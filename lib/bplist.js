// Minimal reader for Apple binary property lists (bplist00) and
// NSKeyedArchiver object graphs, enough to read Lightkey fixture profiles.

class UID {
  constructor(n) {
    this.n = n;
  }
}

function parseBplist(buf) {
  if (buf.toString("latin1", 0, 8) !== "bplist00") throw new Error("Not a binary plist");
  const t = buf.length - 32;
  const offSize = buf[t + 6];
  const refSize = buf[t + 7];
  const numObjects = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableOff = Number(buf.readBigUInt64BE(t + 24));
  const uint = (pos, size) => buf.readUIntBE(pos, size);
  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) offsets[i] = uint(tableOff + i * offSize, offSize);
  const cache = new Array(numObjects);

  function readInt(pos, size) {
    if (size === 8) return Number(buf.readBigInt64BE(pos));
    if (size === 16) return Number(buf.readBigInt64BE(pos + 8));
    return uint(pos, size);
  }
  // Returns [length, positionAfterLength] for a marker's low nibble.
  function length(nib, pos) {
    if (nib !== 0xf) return [nib, pos + 1];
    const size = 1 << (buf[pos + 1] & 0xf);
    return [readInt(pos + 2, size), pos + 2 + size];
  }
  function obj(ref) {
    if (cache[ref] !== undefined) return cache[ref];
    const pos = offsets[ref];
    const m = buf[pos];
    const hi = m >> 4;
    const lo = m & 0xf;
    let v;
    switch (hi) {
      case 0x0:
        v = lo === 0x8 ? false : lo === 0x9 ? true : null;
        break;
      case 0x1:
        v = readInt(pos + 1, 1 << lo);
        break;
      case 0x2:
        v = lo === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1);
        break;
      case 0x3:
        v = new Date((978307200 + buf.readDoubleBE(pos + 1)) * 1000);
        break;
      case 0x4: {
        const [n, p] = length(lo, pos);
        v = buf.subarray(p, p + n);
        break;
      }
      case 0x5: {
        const [n, p] = length(lo, pos);
        v = buf.toString("latin1", p, p + n);
        break;
      }
      case 0x6: {
        const [n, p] = length(lo, pos);
        v = Buffer.from(buf.subarray(p, p + n * 2)).swap16().toString("utf16le");
        break;
      }
      case 0x8:
        v = new UID(uint(pos + 1, lo + 1));
        break;
      case 0xa:
      case 0xc: {
        const [n, p] = length(lo, pos);
        v = [];
        cache[ref] = v;
        for (let i = 0; i < n; i++) v.push(obj(uint(p + i * refSize, refSize)));
        return v;
      }
      case 0xd: {
        const [n, p] = length(lo, pos);
        v = {};
        cache[ref] = v;
        for (let i = 0; i < n; i++) {
          v[obj(uint(p + i * refSize, refSize))] = obj(uint(p + (n + i) * refSize, refSize));
        }
        return v;
      }
      default:
        throw new Error(`Unknown bplist marker 0x${m.toString(16)}`);
    }
    cache[ref] = v;
    return v;
  }
  return obj(top);
}

// Turn an NSKeyedArchiver plist into plain objects. Custom classes come back
// as objects with a `$class` name; Foundation collections become arrays/objects.
function unarchive(plist, rootKey) {
  const objects = plist.$objects;
  const done = new Map();
  function resolve(x) {
    if (x instanceof UID) x = objects[x.n];
    if (x === "$null") return null;
    if (Array.isArray(x)) return x.map(resolve);
    if (!x || typeof x !== "object" || Buffer.isBuffer(x) || x instanceof Date) return x;
    if (done.has(x)) return done.get(x);
    const cls = x.$class ? objects[x.$class.n].$classname : null;
    if ("NS.string" in x) return x["NS.string"];
    if ("NS.objects" in x && "NS.keys" in x) {
      const out = {};
      done.set(x, out);
      x["NS.keys"].forEach((k, i) => (out[resolve(k)] = resolve(x["NS.objects"][i])));
      return out;
    }
    if ("NS.objects" in x) {
      const out = [];
      done.set(x, out);
      for (const v of x["NS.objects"]) out.push(resolve(v));
      return out;
    }
    if (cls === "_NSKeyedCoderOldStyleArray") {
      const out = [];
      for (let i = 0; i < x["NS.count"]; i++) out.push(resolve(x["$" + i]));
      return out;
    }
    const out = { $class: cls };
    done.set(x, out);
    for (const [k, v] of Object.entries(x)) if (k !== "$class") out[k] = resolve(v);
    return out;
  }
  const top = plist.$top;
  return resolve(rootKey ? top[rootKey] : top);
}

module.exports = { parseBplist, unarchive };
