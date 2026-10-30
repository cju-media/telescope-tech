// Reads Lightkey's fixture library (.lightkeyfxt) and compiles a personality
// into the channel model the lighting engine uses.
//
// Profiles are read in place from the installed Lightkey app (and the user's
// own profile folder); nothing is copied. Patched fixtures keep their compiled
// model in patch.json, so they keep working without Lightkey.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseBplist, unarchive } = require("./bplist");

const PROFILE_DIRS = [
  process.env.LIGHTKEY_PROFILES,
  path.join(os.homedir(), "Library/Application Support/Lightkey/Fixture Profiles"),
  "/Applications/Lightkey.app/Contents/Resources/Fixture Profiles",
].filter(Boolean);

let index = null;

// Every profile, from file names alone: "Manufacturer - Model.lightkeyfxt".
// Earlier directories win, so a user's own profile overrides the built-in one.
function listProfiles() {
  if (index) return index;
  const seen = new Map();
  for (const dir of PROFILE_DIRS) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".lightkeyfxt")) continue;
      const id = f.slice(0, -".lightkeyfxt".length);
      if (seen.has(id)) continue;
      const sep = id.indexOf(" - ");
      seen.set(id, {
        id,
        manufacturer: sep > 0 ? id.slice(0, sep) : "Generic",
        name: sep > 0 ? id.slice(sep + 3) : id,
        file: path.join(dir, f),
      });
    }
  }
  index = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  return index;
}

function searchProfiles(q, limit = 60) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of listProfiles()) {
    // Also match manufacturer initials, so "adj" finds "American DJ".
    const initials = p.manufacturer.replace(/[^A-Z]/g, "");
    const hay = `${p.id} ${initials}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push({ id: p.id, manufacturer: p.manufacturer, name: p.name });
    if (out.length >= limit) break;
  }
  return out;
}

const profileCache = new Map();

function loadProfile(id) {
  if (profileCache.has(id)) return profileCache.get(id);
  const entry = listProfiles().find((p) => p.id === id);
  if (!entry) throw new Error(`No Lightkey profile called ${JSON.stringify(id)}`);
  const profile = unarchive(parseBplist(fs.readFileSync(entry.file)), "fixtureProfile");
  profileCache.set(id, profile);
  return profile;
}

const personalityLabel = (p) => p.customName || `${p.footprint}-channel`;

// ---- Compiling a personality ----

const short = (cls) => cls.replace(/^LX/, "").replace(/Capability$/, "");
const LABELS = {
  ColorComponent: "Color",
  Intensity: "Dimmer",
  ShutterStrobe: "Shutter / Strobe",
  PanTiltSpeed: "Pan/Tilt Speed",
  ColorWheel: "Color Wheel",
  ColorFilter: "Color Temperature",
  GoboRotation: "Gobo Rotation",
  GoboAngle: "Gobo Angle",
  GoboShake: "Gobo Shake",
  PrismRotation: "Prism Rotation",
  PrismAngle: "Prism Angle",
  GreenSaturation: "Green/Magenta",
  XfadeToColor: "Crossfade to Color",
  InfinitePan: "Infinite Pan",
  InfiniteTilt: "Infinite Tilt",
  OnOff: "On/Off",
};
// Capabilities whose value is a position or level and can be faded smoothly.
const FADEABLE = new Set([
  "Intensity", "ColorComponent", "Pan", "Tilt", "PanTiltSpeed", "Zoom", "Focus", "Iris", "Frost",
  "ColorFilter", "GreenSaturation", "XfadeToColor", "GoboAngle", "PrismAngle", "Fog",
]);
const STROBE_MODES = { 0: "Closed", 1: "Open", 2: "Strobe", 3: "Pulse", 4: "Ramp up", 5: "Random strobe", 10: "Effect" };

const range = (s) => (s.$0 || [0, 255]).map((v) => v & 255);
const hexOf = (c) => {
  const d = c && c.Cmps && (c.Cmps.data || c.Cmps);
  return d ? "#" + [...d].slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("") : null;
};

function settingLabel(cls, params = {}) {
  if (params.name) return params.name;
  if (params.componentName) return params.componentName;
  if (cls === "ShutterStrobe" && params.mode !== undefined) return STROBE_MODES[params.mode] || `Mode ${params.mode}`;
  if (params.goboIdentifier) return params.goboIdentifier.replace(/^(builtin|special)\./, "").replace(/_/g, " ");
  if (cls === "ColorWheel" && params.color) return `Color ${hexOf(params.color)}`;
  if (cls === "ColorWheel" && params.mode === 1) return params.direction ? "Rotate CCW" : "Rotate CW";
  if (cls === "Lamp" || cls === "OnOff") return params.on ? "On" : "Off";
  return null;
}

// Which capability on a shared channel is active with the mode channels at their defaults.
function activeWhenDefault(caps, modeDefaults) {
  const plain = caps.find((c) => !c.condition);
  const matches = caps.find((c) => {
    if (!c.condition) return false;
    const set = c.condition.settingIndexes || {};
    const idx = modeDefaults[c.condition.modeChannel || 0] ?? 0;
    return idx >= (set.NSLocation || 0) && idx < (set.NSLocation || 0) + (set.NSLength || 0);
  });
  return matches || plain || caps[0];
}

function compile(id, personalityIndex = 0) {
  const profile = loadProfile(id);
  const per = profile.personalities[personalityIndex];
  if (!per) throw new Error(`${id} has no mode ${personalityIndex}`);
  const footprint = per.footprint;
  const caps = (per.capabilities || []).filter((c) => c.channel >= 0 && c.channel < footprint);

  // Default setting index of each mode capability (conditions refer to these by order).
  const modeCaps = caps.filter((c) => short(c.$class) === "Mode");
  const modeDefaults = modeCaps.map((c) => Math.max(0, (c.settings || []).findIndex((s) => s.params && s.params.default)));

  const byChannel = new Map();
  for (const c of caps) {
    if (!byChannel.has(c.channel)) byChannel.set(c.channel, []);
    byChannel.get(c.channel).push(c);
  }

  // Pair "XFine" channels with their coarse "X" channel.
  const fineOf = new Map(); // coarse channel -> fine channel
  const fineChannels = new Set();
  for (const c of caps) {
    const cls = short(c.$class);
    if (!cls.endsWith("Fine")) continue;
    const coarse = caps.find(
      (o) => short(o.$class) === cls.slice(0, -4) && JSON.stringify(o.beamIndexes) === JSON.stringify(c.beamIndexes)
    ) || caps.find((o) => short(o.$class) === cls.slice(0, -4));
    if (coarse && !fineOf.has(coarse.channel)) {
      fineOf.set(coarse.channel, c.channel);
      fineChannels.add(c.channel);
    }
  }

  const model = {
    profile: id,
    manufacturer: profile.manufacturer,
    name: profile.name,
    mode: personalityLabel(per),
    personality: personalityIndex,
    footprint,
    intensity: [],
    components: [],
    strobe: null,
    controls: [],
    defaults: new Array(footprint).fill(0),
  };

  for (let ch = 0; ch < footprint; ch++) {
    if (fineChannels.has(ch)) continue;
    const list = byChannel.get(ch);
    if (!list) {
      model.controls.push({ key: `c${ch}`, label: `Channel ${ch + 1}`, ch, fade: false, options: [] });
      continue;
    }
    const active = activeWhenDefault(list, modeDefaults);
    const cls = short(active.$class);
    const fine = fineOf.get(ch);
    const settings = active.settings || [];

    if (cls === "Intensity" && list.length === 1) {
      const spans = settings.map(range).sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
      let [lo, hi] = spans[0] || [0, 255];
      if (lo === hi) [lo, hi] = [0, 255];
      model.intensity.push({ ch, fine, lo, hi });
      continue;
    }
    if (cls === "ColorComponent" && list.length === 1) {
      const name = (settings[0] && settings[0].params && settings[0].params.componentName) || "Color";
      model.components.push({ ch, fine, name });
      continue;
    }
    if (cls === "ShutterStrobe" && !model.strobe) {
      const open = settings.find((s) => s.params && s.params.mode === 1);
      const strobe = settings.find((s) => s.params && s.params.mode === 2);
      if (strobe) {
        let [lo, hi] = range(strobe);
        const p = strobe.params;
        if (p.minSpeed !== undefined && p.maxSpeed !== undefined && p.minSpeed > p.maxSpeed) [lo, hi] = [hi, lo];
        const off = open ? range(open)[0] : 0;
        model.strobe = { ch, off, lo, hi };
        model.defaults[ch] = off;
      }
    }

    // Everything else becomes a raw control, with Lightkey's named ranges as presets.
    const options = [];
    for (const c of list) {
      const ccls = short(c.$class);
      const prefix = list.length > 1 ? (c.customName || LABELS[ccls] || ccls) + ": " : "";
      const many = (c.settings || []).length > 1;
      for (const s of c.settings || []) {
        const [lo, hi] = range(s);
        const label = settingLabel(ccls, s.params) || (many ? `${lo}–${hi}` : null);
        if (label) options.push({ label: prefix + label, lo, hi });
      }
    }
    const label = active.customName || LABELS[cls] || cls.replace(/([a-z])([A-Z])/g, "$1 $2");
    const def = settings.find((s) => s.params && s.params.default === true);
    if (def) model.defaults[ch] = range(def)[0];
    else if (settings[0] && settings[0].params && settings[0].params.defaultValue !== undefined) {
      model.defaults[ch] = settings[0].params.defaultValue & 255;
    } else if (cls === "Pan" || cls === "Tilt") model.defaults[ch] = 128;
    model.controls.push({
      key: `c${ch}`,
      label,
      ch,
      fine,
      fade: FADEABLE.has(cls),
      strobe: model.strobe && model.strobe.ch === ch ? true : undefined,
      options,
    });
  }
  return model;
}

// Summary of a profile's modes, for the patch editor.
function describeProfile(id) {
  const p = loadProfile(id);
  return {
    id,
    manufacturer: p.manufacturer,
    name: p.name,
    personalities: p.personalities.map((per, i) => {
      let channels = [];
      try {
        const m = compile(id, i);
        channels = new Array(m.footprint).fill("");
        for (const x of m.intensity) channels[x.ch] = "Dimmer";
        for (const x of m.components) channels[x.ch] = x.name;
        for (const x of m.controls) channels[x.ch] = x.label;
        for (const x of [...m.intensity, ...m.components, ...m.controls]) if (x.fine !== undefined) channels[x.fine] = channels[x.ch] + " fine";
      } catch {}
      return { index: i, label: personalityLabel(per), footprint: per.footprint, channels };
    }),
  };
}

module.exports = { listProfiles, searchProfiles, compile, describeProfile, PROFILE_DIRS };
