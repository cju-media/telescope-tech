// Art-Net lighting engine: patch, per-fixture state, fades, blackout, scenes.
//
// Each fixture's state is high level — {dimmer, strobe, comp: {Red: 255, ...},
// raw: {c4: 0, ...}} — and is turned into DMX using the fixture's compiled
// Lightkey model (see lightkey.js). raw holds only channels someone has set;
// everything else sits at the profile's default.
const dgram = require("node:dgram");
const fs = require("node:fs");
const path = require("node:path");
const lightkey = require("./lightkey");

const FADE_STEP_MS = 25; // 40 frames/s while fading

let opts = {};
let patch = []; // [{id, name, universe, address, model}]
let patchVersion = 0;
const states = new Map(); // fixture id -> state
let scenes = [];
let live = false;
let keepalive = null;
let sequence = 0;
let fade = null;
let blackout = null; // while blacked out: the states to bring back, by fixture id
const udp = dgram.createSocket("udp4");

const clamp = (v, max = 255) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
const RGB = { r: "Red", g: "Green", b: "Blue" };

// ---- Files ----

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`Couldn't read ${file}: ${e.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(file + ".tmp", file);
}

const patchFile = () => path.join(opts.dir, "patch.json");
const scenesFile = () => path.join(opts.dir, "scenes.json");
const savePatch = () => writeJson(patchFile(), patch);
const saveScenes = () => writeJson(scenesFile(), scenes);

// ---- State ----

function controlMax(c) {
  return c.fine !== undefined ? 65535 : 255;
}

function controlDefault(model, c) {
  const v = model.defaults[c.ch] || 0;
  return c.fine !== undefined ? v * 256 + (model.defaults[c.fine] || 0) : v;
}

function blankState(model) {
  const comp = {};
  for (const { name } of model.components) comp[name] = Object.values(RGB).includes(name) ? 255 : 0;
  return { dimmer: 0, strobe: 0, comp, raw: {} };
}

const copyState = (s) => ({ dimmer: s.dimmer, strobe: s.strobe, comp: { ...s.comp }, raw: { ...s.raw } });

function roundState(s) {
  const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
  return { dimmer: Math.round(s.dimmer), strobe: Math.round(s.strobe), comp: r(s.comp), raw: r(s.raw) };
}

// Fill in anything a stored state is missing for this fixture's model.
function normalizeState(model, s) {
  const out = blankState(model);
  if (!s) return out;
  out.dimmer = clamp(s.dimmer);
  out.strobe = model.strobe ? clamp(s.strobe) : 0;
  for (const name of Object.keys(out.comp)) if (s.comp && s.comp[name] !== undefined) out.comp[name] = clamp(s.comp[name]);
  for (const c of model.controls) {
    if (s.raw && s.raw[c.key] !== undefined) out.raw[c.key] = clamp(s.raw[c.key], controlMax(c));
  }
  return out;
}

// ---- DMX output ----

function renderFixture(f, s, dmx) {
  const m = f.model;
  const base = f.address - 1;
  const put = (ch, v) => {
    if (base + ch < 512) dmx[base + ch] = v;
  };
  const put16 = (ch, fine, v, max) => {
    if (fine !== undefined) {
      const x = Math.round((v / max) * 65535);
      put(ch, x >> 8);
      put(fine, x & 255);
    } else put(ch, Math.round((v / max) * 255));
  };
  m.defaults.forEach((v, ch) => put(ch, v));
  // Fixtures without a dimmer channel get a virtual one: scale the colors.
  const virtual = m.intensity.length === 0 ? s.dimmer / 255 : 1;
  for (const c of m.components) put16(c.ch, c.fine, (s.comp[c.name] || 0) * virtual, 255);
  for (const i of m.intensity) {
    const v = i.lo + ((i.hi - i.lo) * s.dimmer) / 255;
    put16(i.ch, i.fine, v, 255);
  }
  for (const c of m.controls) {
    if (s.raw[c.key] !== undefined) put16(c.ch, c.fine, s.raw[c.key], controlMax(c));
  }
  if (m.strobe && s.strobe > 0) {
    put(m.strobe.ch, Math.round(m.strobe.lo + ((m.strobe.hi - m.strobe.lo) * (s.strobe - 1)) / 254));
  } else if (m.strobe && s.raw[`c${m.strobe.ch}`] === undefined) {
    put(m.strobe.ch, m.strobe.off);
  }
}

function sendDmx() {
  const universes = new Map();
  for (const f of patch) {
    if (!universes.has(f.universe)) universes.set(f.universe, Buffer.alloc(512));
    renderFixture(f, states.get(f.id), universes.get(f.universe));
  }
  sequence = (sequence % 255) + 1;
  for (const [universe, dmx] of universes) {
    const header = Buffer.alloc(18);
    header.write("Art-Net\0", 0, "latin1");
    header.writeUInt16LE(0x5000, 8); // OpDmx
    header.writeUInt16BE(14, 10); // protocol version
    header[12] = sequence;
    header[13] = 0; // physical
    header.writeUInt16LE(universe & 0x7fff, 14); // SubUni + Net
    header.writeUInt16BE(512, 16);
    udp.send(Buffer.concat([header, dmx]), 6454, opts.host);
  }
}

// We only transmit after someone touches a control, and stop on release,
// so we don't fight Lightkey (or any other console) for the node.
function goLive() {
  live = true;
  sendDmx();
  // Nodes expect a refresh at least every few seconds.
  if (!keepalive) keepalive = setInterval(sendDmx, 1000);
}

function release() {
  stopFade();
  blackout = null;
  live = false;
  clearInterval(keepalive);
  keepalive = null;
}

// ---- Setting levels ----

// body: {fixtures?: [ids], dimmer?, strobe?, color?: {r,g,b}, comp?: {Name: v}, raw?: {key: v}, fade?: seconds}
function setLights({ fixtures, fade: seconds, ...values }) {
  blackout = null; // touching the lights cancels a pending restore
  const instant = !(seconds > 0);
  if (instant) stopFade(); // manual control freezes a running fade where it is
  const ids = new Set(Array.isArray(fixtures) ? fixtures : patch.map((f) => f.id));
  const targets = {};
  for (const f of patch) {
    if (!ids.has(f.id)) continue;
    const s = copyState(fade ? fade.to[f.id] : states.get(f.id));
    if (values.dimmer !== undefined) s.dimmer = clamp(values.dimmer);
    if (values.strobe !== undefined && f.model.strobe) s.strobe = clamp(values.strobe);
    const comp = { ...values.comp };
    for (const [k, name] of Object.entries(RGB)) if (values.color && values.color[k] !== undefined) comp[name] = values.color[k];
    for (const [name, v] of Object.entries(comp)) if (name in s.comp) s.comp[name] = clamp(v);
    for (const [key, v] of Object.entries(values.raw || {})) {
      const c = f.model.controls.find((c) => c.key === key);
      if (!c) continue;
      if (v === null) delete s.raw[key];
      else s.raw[key] = clamp(v, controlMax(c));
    }
    targets[f.id] = s;
  }
  fadeTo(targets, instant ? 0 : seconds * 1000);
}

// ---- Fades ----

function stopFade() {
  if (!fade) return;
  clearInterval(fade.timer);
  fade = null;
}

// Fade the given fixtures (by id) to target states over `ms`; others keep going as they are.
function fadeTo(targets, ms) {
  const unfinished = fade ? fade.to : null;
  stopFade();
  const from = {};
  const to = {};
  for (const f of patch) {
    from[f.id] = copyState(states.get(f.id));
    // A fixture left out keeps heading wherever an interrupted fade was taking it.
    to[f.id] = targets[f.id] ? normalizeState(f.model, targets[f.id]) : copyState((unfinished || {})[f.id] || states.get(f.id));
  }
  const apply = (p) => {
    for (const f of patch) {
      const a = from[f.id];
      const b = to[f.id];
      if (p >= 1) {
        states.set(f.id, copyState(b));
        continue;
      }
      const s = states.get(f.id);
      s.dimmer = a.dimmer + (b.dimmer - a.dimmer) * p;
      for (const name of Object.keys(b.comp)) s.comp[name] = a.comp[name] + (b.comp[name] - a.comp[name]) * p;
      // Strobe is a mode, not a level: switch on at the start, off at the end.
      s.strobe = b.strobe ? b.strobe : a.strobe;
      for (const c of f.model.controls) {
        const x = a.raw[c.key] ?? controlDefault(f.model, c);
        const y = b.raw[c.key] ?? controlDefault(f.model, c);
        if (x === y && a.raw[c.key] === undefined && b.raw[c.key] === undefined) continue;
        s.raw[c.key] = c.fade ? x + (y - x) * p : y; // stepped channels (gobos, modes...) jump straight away
      }
    }
  };
  if (!(ms > 0)) {
    apply(1);
    return goLive();
  }
  const start = Date.now();
  const step = () => {
    const t = Math.min(1, (Date.now() - start) / ms);
    apply(t >= 1 ? 1 : t * t * (3 - 2 * t)); // smoothstep easing
    sendDmx();
    if (t >= 1) stopFade();
  };
  goLive();
  fade = { timer: setInterval(step, FADE_STEP_MS), to };
  step();
}

const currentTargets = () => {
  const out = {};
  for (const f of patch) out[f.id] = roundState(fade ? fade.to[f.id] : states.get(f.id));
  return out;
};

// ---- Blackout ----

function setBlackout(on, ms) {
  if (on && !blackout) {
    // Mid-fade, remember where the fade was heading, not where it happens to be.
    const saved = currentTargets();
    const dark = {};
    for (const [id, s] of Object.entries(saved)) dark[id] = { ...copyState(s), dimmer: 0 };
    fadeTo(dark, ms);
    blackout = saved;
  } else if (!on && blackout) {
    const saved = blackout;
    blackout = null;
    fadeTo(saved, ms);
  }
}

// ---- Scenes ----

function saveScene(name) {
  name = String(name || "").trim().slice(0, 40);
  if (!name) throw new Error("Scene needs a name");
  // While blacked out, save the look that's waiting to come back, not darkness.
  const scene = { name, fixtures: blackout ? JSON.parse(JSON.stringify(blackout)) : currentTargets() };
  const i = scenes.findIndex((s) => s.name === name);
  if (i >= 0) scenes[i] = scene;
  else scenes.push(scene);
  saveScenes();
}

function recallScene(name, ms) {
  const scene = scenes.find((s) => s.name === name);
  if (!scene) throw Object.assign(new Error(`No scene called ${JSON.stringify(name)}`), { status: 404 });
  blackout = null;
  fadeTo(scene.fixtures, ms);
}

function deleteScene(name) {
  scenes = scenes.filter((s) => s.name !== name);
  saveScenes();
}

// Scenes from before the patch existed were arrays of {r,g,b,a,dimmer,strobe} in patch order.
function migrateScenes() {
  let changed = false;
  for (const s of scenes) {
    if (!Array.isArray(s.fixtures)) continue;
    const out = {};
    s.fixtures.forEach((v, i) => {
      if (!patch[i]) return;
      out[patch[i].id] = { dimmer: v.dimmer, strobe: v.strobe, comp: { Red: v.r, Green: v.g, Blue: v.b, Amber: v.a }, raw: {} };
    });
    s.fixtures = out;
    changed = true;
  }
  if (changed) saveScenes();
}

// Rough on-screen color for a fixture state, for scene and tile swatches.
function swatch(model, s) {
  if (!s) return "#000000";
  const c = s.comp || {};
  const has = model.components.length > 0;
  const k = (s.dimmer || 0) / 255;
  const white = (c.White || 0) + (c["Warm White"] || 0) + (c["Cold White"] || 0);
  const amber = c.Amber || 0;
  const ch = (v) => Math.min(255, Math.round(v * k)).toString(16).padStart(2, "0");
  if (!has) return "#" + ch(255) + ch(255) + ch(240);
  return "#" + ch((c.Red || 0) + amber + white) + ch((c.Green || 0) + amber * 0.6 + white) + ch((c.Blue || 0) + white * 0.9);
}

// ---- Patch ----

function nextId() {
  let n = 1;
  for (const f of patch) n = Math.max(n, Number(String(f.id).slice(1)) + 1 || n);
  return "f" + n;
}

function checkPlacement(universe, address, footprint, ignoreId) {
  if (!Number.isInteger(universe) || universe < 0 || universe > 32767) throw new Error("Universe must be 0–32767");
  if (!Number.isInteger(address) || address < 1 || address + footprint - 1 > 512) {
    throw new Error(`Address must be 1–${513 - footprint} for a ${footprint}-channel fixture`);
  }
  for (const f of patch) {
    if (f.id === ignoreId || f.universe !== universe) continue;
    const end = f.address + f.model.footprint - 1;
    if (address <= end && address + footprint - 1 >= f.address) {
      throw new Error(`Overlaps ${f.name} (${f.universe}.${f.address}–${end})`);
    }
  }
}

// First free address in a universe that fits `footprint`, or null.
function freeAddress(universe, footprint, after = 1) {
  const taken = patch.filter((f) => f.universe === universe).map((f) => [f.address, f.address + f.model.footprint - 1]);
  for (let a = after; a + footprint - 1 <= 512; a++) {
    const clash = taken.find(([s, e]) => a <= e && a + footprint - 1 >= s);
    if (!clash) return a;
    a = clash[1];
  }
  return null;
}

function addFixtures({ profile, personality = 0, universe = opts.defaultUniverse, address, count = 1, name }) {
  const model = lightkey.compile(profile, Number(personality) || 0);
  universe = Number(universe);
  count = Math.max(1, Math.min(64, Math.round(Number(count) || 1)));
  const base = String(name || "").trim() || model.name;
  const added = [];
  // Auto-addressing looks for a gap big enough for the whole run.
  let addr = address ? Number(address) : freeAddress(universe, model.footprint * count);
  if (addr === null) throw new Error(`No room for ${count} × ${model.footprint} channels in universe ${universe}`);
  // Validate the whole run before adding anything.
  const plan = [];
  for (let i = 0; i < count; i++) {
    const a = addr + i * model.footprint;
    checkPlacement(universe, a, model.footprint);
    for (const p of plan) if (a <= p + model.footprint - 1 && a + model.footprint - 1 >= p) throw new Error("Fixtures overlap");
    plan.push(a);
  }
  for (const [i, a] of plan.entries()) {
    const f = { id: nextId(), name: count > 1 ? `${base} ${i + 1}` : base, universe, address: a, model };
    patch.push(f);
    states.set(f.id, blankState(model));
    added.push(f.id);
  }
  patchChanged();
  return added;
}

function updateFixture(id, changes) {
  const f = patch.find((f) => f.id === id);
  if (!f) throw Object.assign(new Error("No such fixture"), { status: 404 });
  const model =
    changes.personality !== undefined && Number(changes.personality) !== f.model.personality
      ? lightkey.compile(f.model.profile, Number(changes.personality))
      : f.model;
  const universe = changes.universe !== undefined ? Number(changes.universe) : f.universe;
  const address = changes.address !== undefined ? Number(changes.address) : f.address;
  checkPlacement(universe, address, model.footprint, id);
  if (changes.name !== undefined) f.name = String(changes.name).trim().slice(0, 40) || f.name;
  if (model !== f.model) {
    f.model = model;
    states.set(id, normalizeState(model, states.get(id)));
  }
  f.universe = universe;
  f.address = address;
  patchChanged();
}

function removeFixture(id) {
  if (!patch.some((f) => f.id === id)) throw Object.assign(new Error("No such fixture"), { status: 404 });
  stopFade();
  patch = patch.filter((f) => f.id !== id);
  states.delete(id);
  if (blackout) delete blackout[id];
  for (const s of scenes) delete s.fixtures[id];
  saveScenes();
  patchChanged();
}

function moveFixture(id, dir) {
  const i = patch.findIndex((f) => f.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= patch.length) return;
  [patch[i], patch[j]] = [patch[j], patch[i]];
  patchChanged();
}

function patchChanged() {
  patchVersion++;
  savePatch();
  if (live) sendDmx();
}

function patchState() {
  return {
    version: patchVersion,
    fixtures: patch.map((f) => ({
      id: f.id,
      name: f.name,
      universe: f.universe,
      address: f.address,
      footprint: f.model.footprint,
      profile: f.model.profile,
      manufacturer: f.model.manufacturer,
      model: f.model.name,
      mode: f.model.mode,
      personality: f.model.personality,
    })),
  };
}

function lightsState() {
  return {
    live,
    fading: !!fade,
    blackout: !!blackout,
    node: opts.host,
    patchVersion,
    scenes: scenes.map((s) => ({
      name: s.name,
      preview: patch.filter((f) => s.fixtures[f.id]).map((f) => swatch(f.model, s.fixtures[f.id])),
    })),
    fixtures: patch.map((f) => ({
      id: f.id,
      name: f.name,
      universe: f.universe,
      address: f.address,
      footprint: f.model.footprint,
      label: `${f.model.manufacturer} ${f.model.name}`,
      dimmer: true,
      components: f.model.components.map((c) => c.name).filter((n, i, a) => a.indexOf(n) === i),
      strobe: !!f.model.strobe,
      controls: f.model.controls.map((c) => ({
        key: c.key,
        label: c.label,
        max: controlMax(c),
        def: controlDefault(f.model, c),
        fine: c.fine !== undefined,
        options: c.options,
      })),
      swatch: swatch(f.model, states.get(f.id)),
      state: roundState(states.get(f.id)),
    })),
  };
}

// ---- Startup ----

function init({ host, defaultUniverse = 1, dir }) {
  opts = { host, defaultUniverse, dir };
  patch = readJson(patchFile(), null);
  if (!patch) {
    // First run: the rig this was built for — four SlimPAR Q12 USBs in 9-channel mode.
    patch = [];
    try {
      const model = lightkey.compile("Chauvet - SlimPAR Q12 USB", 0);
      [1, 10, 19, 28].forEach((address, i) =>
        patch.push({ id: `f${i + 1}`, name: `P${i + 1}`, universe: defaultUniverse, address, model })
      );
    } catch (e) {
      console.error(`Starting with an empty patch: ${e.message}`);
    }
    savePatch();
  }
  for (const f of patch) states.set(f.id, blankState(f.model));
  scenes = readJson(scenesFile(), []);
  migrateScenes();
}

module.exports = {
  init,
  setLights,
  setBlackout,
  release,
  saveScene,
  recallScene,
  deleteScene,
  addFixtures,
  updateFixture,
  removeFixture,
  moveFixture,
  lightsState,
  patchState,
  freeAddress,
  isBlackout: () => !!blackout,
};
