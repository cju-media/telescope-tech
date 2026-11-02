// Stage plot: stage size, projector screen, and where each fixture sits.
// Top-down, in metres. x runs stage left → right as seen from the audience;
// y runs upstage (0) → downstage (depth), so the audience is at the bottom.
// Each fixture's beam has a tilt (degrees from straight down: 0 = straight down,
// 90 = level) and a direction on the plot (0 = upstage, 90 = stage left,
// 180 = toward the audience, 270 = stage right).
const fs = require("node:fs");
const path = require("node:path");

let file = null;
let stage = null;

const DEFAULT = {
  width: 10,
  depth: 6,
  screen: { visible: true, x: 5, y: 0.6, width: 4 },
  positions: {},
};

const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : fallback;
};

function normalize(s, prev = DEFAULT) {
  s = s || {};
  const width = num(s.width, 1, 100, prev.width);
  const depth = num(s.depth, 1, 100, prev.depth);
  const sc = s.screen || {};
  const ps = prev.screen;
  const screenWidth = num(sc.width, 0.5, width, Math.min(ps.width, width));
  const screen = {
    visible: sc.visible === undefined ? ps.visible : !!sc.visible,
    width: screenWidth,
    x: num(sc.x, screenWidth / 2, width - screenWidth / 2, Math.min(ps.x, width - screenWidth / 2)),
    y: num(sc.y, 0, depth, Math.min(ps.y, depth)),
  };
  const positions = {};
  for (const [id, p] of Object.entries(s.positions || {})) {
    if (!/^[\w-]+$/.test(id) || !p) continue;
    const dir = num(p.dir, -360, 720, 0);
    positions[id] = {
      x: num(p.x, 0, width, width / 2),
      y: num(p.y, 0, depth, depth / 2),
      tilt: num(p.tilt, 0, 90, 0),
      dir: Math.round(((dir % 360) + 360) % 360),
    };
  }
  return { width, depth, screen, positions };
}

function init(dir) {
  file = path.join(dir, "stage.json");
  try {
    stage = normalize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`Couldn't read ${file}: ${e.message}`);
    stage = normalize(DEFAULT);
  }
}

// Positions of fixtures no longer in the patch are dropped.
function get(fixtureIds) {
  const ids = new Set(fixtureIds);
  return { ...stage, positions: Object.fromEntries(Object.entries(stage.positions).filter(([id]) => ids.has(id))) };
}

function set(next, fixtureIds) {
  stage = normalize(next, stage);
  const ids = new Set(fixtureIds);
  for (const id of Object.keys(stage.positions)) if (!ids.has(id)) delete stage.positions[id];
  fs.writeFileSync(file + ".tmp", JSON.stringify(stage, null, 2));
  fs.renameSync(file + ".tmp", file);
  return get(fixtureIds);
}

module.exports = { init, get, set };
