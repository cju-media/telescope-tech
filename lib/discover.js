// Finds the projector again when its DHCP address changes.
//
// The projector doesn't publish a usable hostname (its mDNS record points at
// "none.local"), so we identify it by MAC address instead: scan the local
// subnets for Epson's ESC/VP.net port, read the ARP table, and pick the host
// whose MAC matches. The last good address and the MAC live in projector.json.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const EPSON_PORT = 3629;
const MIN_SCAN_INTERVAL_MS = 30_000;

let file = null;
let saved = {}; // {host, mac}
let scanning = null;
let lastScan = 0;

const normMac = (m) =>
  String(m || "")
    .toLowerCase()
    .split(/[:-]/)
    .map((p) => p.padStart(2, "0"))
    .join(":");

function init(dir, defaults = {}) {
  file = path.join(dir, "projector.json");
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`Couldn't read ${file}: ${e.message}`);
  }
  if (!saved.mac && defaults.mac) saved.mac = normMac(defaults.mac);
  if (!saved.host && defaults.host) saved.host = defaults.host;
}

function save(changes) {
  saved = { ...saved, ...changes };
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
}

const host = () => saved.host;
const mac = () => saved.mac;

function canConnect(ip, port, timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port, timeout });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });
}

// IPv4 hosts on each local subnet (capped at /22 so a big network doesn't explode the scan).
function localHosts() {
  const out = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const bits = Math.max(22, Number(a.cidr.split("/")[1]));
      const ip = a.address.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      const base = (ip & mask) >>> 0;
      for (let i = 1; i < 2 ** (32 - bits) - 1; i++) {
        const h = base + i;
        out.add([h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255].join("."));
      }
    }
  }
  return [...out];
}

function arpTable() {
  return new Promise((resolve) => {
    execFile("arp", ["-an"], { timeout: 5000 }, (err, stdout) => {
      const table = new Map();
      if (!err) {
        for (const m of stdout.matchAll(/\(([\d.]+)\) at ([0-9a-f:]+)/gi)) table.set(m[1], normMac(m[2]));
      }
      resolve(table);
    });
  });
}

// Is this host an Epson? Its web server says so in the Server header.
function isEpson(ip) {
  return new Promise((resolve) => {
    const req = require("node:http").get({ host: ip, path: "/", timeout: 2000 }, (res) => {
      res.resume();
      resolve(/epson/i.test(res.headers.server || ""));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function scan() {
  const hosts = localHosts();
  const open = [];
  // Probe in batches so we don't open hundreds of sockets at once.
  for (let i = 0; i < hosts.length; i += 128) {
    const batch = hosts.slice(i, i + 128);
    const results = await Promise.all(batch.map((ip) => canConnect(ip, EPSON_PORT)));
    batch.forEach((ip, j) => results[j] && open.push(ip));
  }
  const arp = await arpTable();
  // Prefer the projector we know by MAC; otherwise accept a lone Epson.
  if (mac()) {
    const match = open.find((ip) => arp.get(ip) === mac());
    if (match) return match;
  }
  const epsons = [];
  for (const ip of open) if (await isEpson(ip)) epsons.push(ip);
  if (epsons.length === 1 && (!mac() || !arp.get(epsons[0]))) return epsons[0];
  if (epsons.length > 1) console.error(`Found several Epson projectors (${epsons.join(", ")}); set EPSON_HOST to pick one.`);
  return null;
}

// Look for the projector; returns its address (and saves it) or null.
// Concurrent callers share one scan, and scans are rate-limited.
function find() {
  if (scanning) return scanning;
  if (Date.now() - lastScan < MIN_SCAN_INTERVAL_MS) return Promise.resolve(null);
  lastScan = Date.now();
  scanning = scan()
    .then(async (ip) => {
      if (ip) {
        const m = (await arpTable()).get(ip);
        if (ip !== saved.host) console.log(`Projector found at ${ip}${saved.host ? ` (was ${saved.host})` : ""}`);
        save({ host: ip, ...(m ? { mac: m } : {}) });
      }
      return ip;
    })
    .catch((e) => {
      console.error(`Projector scan failed: ${e.message}`);
      return null;
    })
    .finally(() => (scanning = null));
  return scanning;
}

// After a successful command, remember the address and learn the MAC if we can.
async function confirm(ip) {
  if (ip === saved.host && saved.mac) return;
  const m = (await arpTable()).get(ip);
  save({ host: ip, ...(m ? { mac: m } : {}) });
}

module.exports = { init, host, mac, find, confirm, isScanning: () => !!scanning };
