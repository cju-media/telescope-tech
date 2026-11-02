#!/usr/bin/env node
/*
Tiny web interface to power an Epson projector on/off and run the
Art-Net lighting rig, with fixtures patched from Lightkey's profile library.

Usage:
    node server.js
then open http://localhost:8080 (or http://<this-mac's-ip>:8080 from a phone).

Env vars:
    EPSON_HOST        projector IP or hostname. Leave unset and the projector is
                      found automatically (by MAC address) whenever its DHCP
                      address changes; the last one found is kept in projector.json.
    EPSON_MAC         projector MAC to look for (default 58:05:d9:1b:03:c1)
    EPSON_PASSWORD    the projector's Web Control password (user is EPSONWEB);
                      defaults to the one built in below
    ARTNET_HOST       Art-Net node IP (default 192.168.1.4, a DMX-AN2)
    ARTNET_UNIVERSE   universe for newly patched fixtures (default 1)
    LIGHTKEY_PROFILES extra folder of .lightkeyfxt profiles to search first
    PORT              port for this web UI (default 8080)

The patch lives in patch.json, scenes in scenes.json and the stage plot in
stage.json, next to this file.

Talks to the projector via its Web Control endpoint (/cgi-bin/json_query),
falling back to the newer Web API and then ESC/VP.net on TCP 3629.
No dependencies beyond Node's standard library.
*/
const http = require("node:http");
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const lights = require("./lib/lights");
const lightkey = require("./lib/lightkey");
const stage = require("./lib/stage");
const discover = require("./lib/discover");

// A fixed EPSON_HOST turns discovery off; otherwise the address can change at runtime.
const FIXED_HOST = process.env.EPSON_HOST || null;
const HOST = () => FIXED_HOST || discover.host();
const PASSWORD = process.env.EPSON_PASSWORD || "telescope";
const PORT = Number(process.env.PORT || 8080);
const USER = "EPSONWEB";
const ARTNET_HOST = process.env.ARTNET_HOST || "192.168.1.4";
const ARTNET_UNIVERSE = Number(process.env.ARTNET_UNIVERSE ?? 1);

const POWER_STATES = {
  "00": ["off", "Standby"],
  "01": ["on", "On"],
  "02": ["warming", "Warming up"],
  "03": ["cooling", "Cooling down"],
  "04": ["off", "Standby"],
  "05": ["error", "Abnormal standby"],
  "09": ["off", "A/V standby"],
};

class ProjectorError extends Error {
  // unreachable: the projector didn't answer at all (vs. answering with an error)
  constructor(message, unreachable = false) {
    super(message);
    this.unreachable = unreachable;
  }
}

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

function rawGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST(), path, headers, timeout: 10000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

// GET with HTTP Digest auth (the projector uses MD5 / qop=auth).
async function digestGet(path, headers = {}) {
  let res = await rawGet(path, headers);
  const challenge = res.headers["www-authenticate"];
  if (res.status !== 401 || !challenge || !PASSWORD) return res;
  const p = {};
  for (const [, k, v] of challenge.matchAll(/(\w+)="?([^",]*)"?/g)) p[k] = v;
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = md5(`${USER}:${p.realm}:${PASSWORD}`);
  const ha2 = md5(`GET:${path}`);
  const response = md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  const auth =
    `Digest username="${USER}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", ` +
    `algorithm=MD5, qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  return rawGet(path, { ...headers, Authorization: auth });
}

async function jsonQuery(cmd) {
  let res;
  try {
    res = await digestGet(`/cgi-bin/json_query?jsoncallback=${encodeURIComponent(cmd)}`, {
      Referer: `http://${HOST()}/cgi-bin/webconf`,
    });
  } catch (e) {
    throw new ProjectorError(`Web Control: ${e.message}`, true);
  }
  // Something else may have been given the projector's old address.
  if (!/epson/i.test(res.headers.server || "")) throw new ProjectorError(`${HOST()} isn't the projector`, true);
  if (res.status === 401) throw new ProjectorError("Web Control: wrong or missing password (EPSON_PASSWORD)");
  if (res.status !== 200) throw new ProjectorError(`Web Control: HTTP ${res.status}`);
  let feature;
  try {
    feature = JSON.parse(res.body).projector.feature;
  } catch (e) {
    throw new ProjectorError(`Web Control: ${e.message}`);
  }
  if (feature.error) throw new ProjectorError(`Projector rejected ${JSON.stringify(cmd)}: ${feature.reply}`);
  const reply = feature.reply || "";
  // Normalise query replies ("01") to the ESC/VP21 form ("PWR=01")
  return cmd.endsWith("?") ? `${cmd.slice(0, -1)}=${reply}` : reply;
}

async function webApi(cmd) {
  let res;
  try {
    res = await digestGet(`/api/v01/control/escvp21?cmd=${cmd.replaceAll(" ", "+")}`);
  } catch (e) {
    throw new ProjectorError(`Web API: ${e.message}`);
  }
  if (res.status === 401) throw new ProjectorError("Web API: wrong or missing password (EPSON_PASSWORD)");
  if (res.status !== 200) throw new ProjectorError(`Web API: HTTP ${res.status}`);
  return res.body;
}

function escvpNet(cmd) {
  let hello = Buffer.from("ESC/VP.net\x10\x03\x00\x00\x00\x00", "latin1");
  if (PASSWORD) {
    const pw = Buffer.alloc(16);
    Buffer.from(PASSWORD).copy(pw, 0, 0, 16);
    hello = Buffer.concat([Buffer.from("ESC/VP.net\x10\x03\x00\x00\x00\x01\x01\x01", "latin1"), pw]);
  }
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: HOST(), port: 3629, timeout: 8000 });
    let handshaken = false;
    let buf = Buffer.alloc(0);
    const fail = (msg) => {
      sock.destroy();
      reject(new ProjectorError(msg));
    };
    sock.on("connect", () => sock.write(hello));
    sock.on("timeout", () => fail("ESC/VP.net: timed out"));
    sock.on("error", (e) => fail(`ESC/VP.net: ${e.message}`));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        if (buf.length < 16) return;
        if (buf[14] !== 0x20) return fail(`ESC/VP.net refused (status 0x${buf[14].toString(16)})`);
        handshaken = true;
        buf = buf.subarray(16);
        sock.write(cmd + "\r");
      }
      if (buf.toString("latin1").endsWith(":")) {
        sock.end();
        resolve(buf.toString("latin1"));
      }
    });
    sock.on("close", () => fail("ESC/VP.net: connection closed"));
  });
}

async function sendOnce(cmd) {
  const errors = [];
  let unreachable = false;
  for (const fn of [jsonQuery, webApi, escvpNet]) {
    try {
      const reply = await fn(cmd);
      if (!FIXED_HOST) discover.confirm(HOST()).catch(() => {});
      return reply;
    } catch (e) {
      if (!(e instanceof ProjectorError)) throw e;
      // The first method (Web Control) tells us whether anything answered at that address.
      if (fn === jsonQuery) unreachable = e.unreachable;
      errors.push(e.message);
    }
  }
  throw new ProjectorError(errors.join("; "), unreachable);
}

// If the projector has gone silent, it has probably picked up a new DHCP
// address: look for it by MAC and try once more there.
async function send(cmd) {
  try {
    return await sendOnce(cmd);
  } catch (e) {
    if (FIXED_HOST || !(e instanceof ProjectorError) || !e.unreachable) throw e;
    const before = HOST();
    const found = await discover.find();
    if (!found || found === before) {
      throw new ProjectorError(`Can't reach the projector at ${before || "an unknown address"} and couldn't find it on the network`, true);
    }
    return sendOnce(cmd);
  }
}

async function status() {
  const text = await send("PWR?");
  const m = text.match(/PWR=(\d\d)/);
  if (!m) throw new ProjectorError(`Unexpected reply: ${JSON.stringify(text)}`);
  const [state, label] = POWER_STATES[m[1]] || ["unknown", `Code ${m[1]}`];
  return { state, label, code: m[1], host: HOST() };
}

// ---- Web server ----

const PAGE_FILE = path.join(__dirname, "page.html");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const seconds = (v) => Math.max(0, Number(v) || 0) * 1000;

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const route = (method, re) => req.method === method && p.match(re);
  let m;

  if (route("GET", /^\/$/)) {
    const page = fs
      .readFileSync(PAGE_FILE, "utf8")
      .replaceAll("__HOST__", HOST() || "searching…")
      .replaceAll("__ARTNET__", ARTNET_HOST)
      .replaceAll("__UNIVERSE__", String(ARTNET_UNIVERSE));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page);
  }

  // Projector
  if (route("GET", /^\/api\/status$/)) return sendJson(res, await status());
  if ((m = route("POST", /^\/api\/power\/(on|off)$/))) {
    await send(m[1] === "on" ? "PWR ON" : "PWR OFF");
    return sendJson(res, await status());
  }

  // Lights — every change answers with the new lights state
  let changed = true;
  if (route("GET", /^\/api\/lights$/)) changed = true;
  else if (route("POST", /^\/api\/lights$/)) lights.setLights(await readJson(req));
  else if (route("POST", /^\/api\/lights\/blackout$/)) {
    const body = await readJson(req);
    // {on: true|false}, or omit `on` to toggle
    lights.setBlackout(body.on === undefined ? !lights.isBlackout() : !!body.on, seconds(body.fade));
  } else if (route("POST", /^\/api\/lights\/master$/)) lights.setMaster((await readJson(req)).level);
  else if (route("POST", /^\/api\/lights\/release$/)) lights.release();
  else if (route("POST", /^\/api\/scenes$/)) lights.saveScene((await readJson(req)).name);
  else if (route("POST", /^\/api\/scenes\/recall$/)) {
    const body = await readJson(req);
    lights.recallScene(body.name, seconds(body.fade));
  } else if ((m = route("DELETE", /^\/api\/scenes\/(.+)$/))) lights.deleteScene(decodeURIComponent(m[1]));
  else changed = false;
  if (changed) return sendJson(res, lights.lightsState());

  // Stage plot
  const fixtureIds = () => lights.patchState().fixtures.map((f) => f.id);
  if (route("GET", /^\/api\/stage$/)) return sendJson(res, stage.get(fixtureIds()));
  if (route("PUT", /^\/api\/stage$/)) return sendJson(res, stage.set(await readJson(req), fixtureIds()));

  // Patch
  if (route("GET", /^\/api\/profiles$/)) return sendJson(res, lightkey.searchProfiles(url.searchParams.get("q")));
  if ((m = route("GET", /^\/api\/profiles\/(.+)$/))) return sendJson(res, lightkey.describeProfile(decodeURIComponent(m[1])));
  if (route("GET", /^\/api\/patch$/)) return sendJson(res, lights.patchState());
  if (route("GET", /^\/api\/patch\/free$/)) {
    const q = url.searchParams;
    return sendJson(res, { address: lights.freeAddress(Number(q.get("universe")), Number(q.get("footprint")) || 1) });
  }
  if (route("POST", /^\/api\/patch$/)) lights.addFixtures(await readJson(req));
  else if ((m = route("PATCH", /^\/api\/patch\/([\w-]+)$/))) lights.updateFixture(m[1], await readJson(req));
  else if ((m = route("DELETE", /^\/api\/patch\/([\w-]+)$/))) lights.removeFixture(m[1]);
  else if ((m = route("POST", /^\/api\/patch\/([\w-]+)\/move$/))) lights.moveFixture(m[1], (await readJson(req)).dir);
  else {
    res.writeHead(404).end();
    return;
  }
  return sendJson(res, lights.patchState());
}

discover.init(__dirname, { host: "192.168.1.11", mac: process.env.EPSON_MAC || "58:05:d9:1b:03:c1" });
lights.init({ host: ARTNET_HOST, defaultUniverse: ARTNET_UNIVERSE, dir: __dirname });
stage.init(__dirname);

const server = http.createServer((req, res) =>
  handle(req, res).catch((e) => {
    if (e instanceof ProjectorError) return sendJson(res, { error: e.message }, 502);
    // Bugs get logged; plain Errors from the lighting/patch code are user-facing (bad address, overlap...).
    const bug = e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError;
    if (bug) console.error(e);
    sendJson(res, { error: e.message || String(e) }, e.status || (bug ? 500 : 400));
  })
);
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other server or set PORT=…`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Projector ${FIXED_HOST || `${HOST()} (auto, MAC ${discover.mac()})`} + Art-Net ${ARTNET_HOST}`);
  // 0.0.0.0 isn't something you can type into a browser, so list the real addresses.
  const lan = Object.values(require("node:os").networkInterfaces())
    .flat()
    .filter((a) => a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
  console.log(`Open http://localhost:${PORT} on this Mac`);
  for (const ip of lan) console.log(`  or http://${ip}:${PORT} from a phone on the same network`);
});
