/* TrackParse - browser-side GPX/KML/KMZ track parser.
   Ported from hike/app.py (_gpx_points, _kml_track_points, _kmz_points,
   _write_csv). Pure computation, no I/O. Works in the browser (DOMParser +
   DecompressionStream) and in Node (tests inject a DOMParser shim).
   Public API (window.TrackParse / module.exports):
     parseGPX(text)          -> [{lat, lon, timeMs, elev}]
     parseKML(text)          -> [{lat, lon, timeMs, elev}]
     parseKMZ(arrayBuffer)   -> Promise<[{lat, lon, timeMs, elev}]>
     computePoints(raw)      -> [{lat, lon, dist, time, elev, ts}]
     parseTrackFile(file)    -> Promise<{points, name}> (dispatch by extension)
     rejectEntities(text)    - throws on <!ENTITY (billion-laughs guard)
   computePoints matches Python _write_csv exactly: cumulative haversine
   distance, time_hours relative to the first point, dist/time rounded to
   4 decimals and elevation to 1 decimal with Python round-half-to-even,
   first row dist=0/time=0 and elevation unrounded, ts = unix seconds.
*/
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.TrackParse = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371.0;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLon = (lon2 - lon1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Python round() is round-half-to-even on the EXACT decimal value of the
// double. A multiply-first approach (x * 10^n, then tie-check) is wrong:
// the multiplication itself rounds and can land exactly on a .5 tie that
// the original value is only infinitesimally below/above, flipping the
// result. So: expand the double to its exact decimal string with BigInt,
// round half-to-even in decimal, then take the nearest double (what
// Python's round returns).
function exactDecimalString(x) {
  if (x === 0) return "0";
  var buf = new ArrayBuffer(8);
  var dv = new DataView(buf);
  dv.setFloat64(0, x);
  var bits = dv.getBigUint64(0, false);
  var sign = (bits >> 63n) !== 0n ? "-" : "";
  var exp = Number((bits >> 52n) & 0x7ffn);
  var mant = bits & ((1n << 52n) - 1n);
  var mantissa, e;
  if (exp === 0) { mantissa = mant; e = -1074; }
  else { mantissa = mant + (1n << 52n); e = exp - 1075; }
  if (e >= 0) return sign + (mantissa << BigInt(e)).toString();
  var denom = 1n << BigInt(-e);
  var intPart = mantissa / denom;
  var rem = mantissa % denom;
  var frac = "";
  while (rem !== 0n) {
    rem *= 10n;
    frac += (rem / denom).toString();
    rem = rem % denom;
  }
  return sign + intPart.toString() + (frac ? "." + frac : "");
}

function pyRound(x, digits) {
  if (!isFinite(x)) return x;
  var s = exactDecimalString(x);
  var neg = s.charAt(0) === "-";
  if (neg) s = s.slice(1);
  var parts = s.split(".");
  var intPart = parts[0];
  var fracPart = parts[1] || "";
  while (fracPart.length <= digits) fracPart += "0";
  var keep = fracPart.slice(0, digits);
  var nextDigit = parseInt(fracPart.charAt(digits), 10);
  var restNonZero = /[1-9]/.test(fracPart.slice(digits + 1));
  var roundUp = false;
  if (nextDigit > 5) roundUp = true;
  else if (nextDigit === 5) {
    if (restNonZero) roundUp = true;
    else {
      var lastKeep = digits === 0
        ? parseInt(intPart.charAt(intPart.length - 1), 10)
        : parseInt(keep.charAt(keep.length - 1), 10);
      roundUp = (lastKeep % 2 === 1);
    }
  }
  var result;
  if (!roundUp) {
    result = digits === 0 ? intPart : intPart + "." + keep;
  } else {
    var combined = (intPart + keep).split("").map(function (c) { return parseInt(c, 10); });
    var carry = 1;
    for (var i = combined.length - 1; i >= 0 && carry; i--) {
      var sum = combined[i] + carry;
      combined[i] = sum % 10;
      carry = Math.floor(sum / 10);
    }
    if (carry) combined.unshift(1);
    var cs = combined.join("");
    if (digits === 0) result = cs;
    else {
      while (cs.length <= digits) cs = "0" + cs;
      result = cs.slice(0, cs.length - digits) + "." + cs.slice(cs.length - digits);
    }
  }
  return parseFloat((neg ? "-" : "") + result);
}

function rejectEntities(text) {
  // DOMParser never fetches external entities (no XXE), but internal
  // entity expansion (billion laughs) is real. GPX/KML never need
  // entities, so reject the declaration outright, case-insensitive.
  if (text.toLowerCase().indexOf("<!entity") !== -1) {
    throw new Error("XML 实体声明不被允许");
  }
}

function parseXml(text) {
  var doc = new DOMParser().parseFromString(text, "text/xml");
  var errs = doc.getElementsByTagName("parsererror");
  if (errs && errs.length > 0) throw new Error("XML 解析失败");
  return doc;
}

// First direct child element whose localName matches (namespace-agnostic,
// mirrors ElementTree find() after namespace stripping).
function childByLocalName(el, name) {
  var kids = el.childNodes;
  for (var i = 0; i < kids.length; i++) {
    var n = kids[i];
    if (n.nodeType === 1 && (n.localName === name || n.tagName === name)) return n;
  }
  return null;
}

function parseGPX(text) {
  rejectEntities(text);
  var doc = parseXml(text);
  var trkpts = doc.getElementsByTagNameNS("*", "trkpt");
  var points = [];
  for (var i = 0; i < trkpts.length; i++) {
    var el = trkpts[i];
    var lat = parseFloat(el.getAttribute("lat"));
    var lon = parseFloat(el.getAttribute("lon"));
    if (isNaN(lat) || isNaN(lon)) continue;
    var timeEl = childByLocalName(el, "time");
    if (!timeEl || !timeEl.textContent) continue;
    var ms = Date.parse(timeEl.textContent.trim());
    if (isNaN(ms)) continue;
    var eleEl = childByLocalName(el, "ele");
    var ele = 0.0;
    if (eleEl && eleEl.textContent) {
      var v = parseFloat(eleEl.textContent.trim());
      if (!isNaN(v)) ele = v;
    }
    points.push({ lat: lat, lon: lon, timeMs: ms, elev: ele });
  }
  return points;
}

function parseKML(text) {
  rejectEntities(text);
  var doc = parseXml(text);
  var tracks = doc.getElementsByTagNameNS("*", "Track");
  var points = [];
  for (var t = 0; t < tracks.length; t++) {
    var track = tracks[t];
    var pending = null;
    var kids = track.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType !== 1) continue;
      var ln = n.localName || n.tagName;
      if (ln === "when") {
        var ms = Date.parse((n.textContent || "").trim());
        pending = isNaN(ms) ? null : ms;
      } else if (ln === "coord") {
        var parts = (n.textContent || "").trim().split(/\s+/);
        if (parts.length < 2 || pending === null) continue;
        var clon = parseFloat(parts[0]);
        var clat = parseFloat(parts[1]);
        if (isNaN(clon) || isNaN(clat)) continue;
        var cele = 0.0;
        if (parts.length > 2) {
          var ev = parseFloat(parts[2]);
          if (!isNaN(ev)) cele = ev;
        }
        points.push({ lat: clat, lon: clon, timeMs: pending, elev: cele });
        pending = null;
      }
    }
  }
  return points;
}

// ---- minimal ZIP reader (KMZ) + DecompressionStream inflate ----
// Reads the central directory (always carries true sizes, even when the
// local header uses a data descriptor), then inflates the chosen entry.
function findEOCD(u8) {
  var start = Math.max(0, u8.length - 65557);
  for (var i = u8.length - 22; i >= start; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  var ds = new DecompressionStream("deflate-raw");
  var out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(out);
}

async function parseKMZ(arrayBuffer) {
  var u8 = new Uint8Array(arrayBuffer);
  var dv = new DataView(arrayBuffer);
  var eocd = findEOCD(u8);
  if (eocd < 0) throw new Error("不是有效的 ZIP/KMZ 文件");
  var total = dv.getUint16(eocd + 10, true);
  var cdOffset = dv.getUint32(eocd + 16, true);
  if (total > 2000) throw new Error("ZIP 条目过多");
  var decoder = new TextDecoder("utf-8");
  var chosen = null;
  var off = cdOffset;
  for (var e = 0; e < total; e++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    var method = dv.getUint16(off + 10, true);
    var cSize = dv.getUint32(off + 20, true);
    var uSize = dv.getUint32(off + 24, true);
    var fnLen = dv.getUint16(off + 28, true);
    var exLen = dv.getUint16(off + 30, true);
    var cmLen = dv.getUint16(off + 32, true);
    var lhOff = dv.getUint32(off + 42, true);
    var name = decoder.decode(u8.subarray(off + 46, off + 46 + fnLen));
    var entry = { name: name, method: method, cSize: cSize, uSize: uSize, lhOff: lhOff };
    if (name.toLowerCase().endsWith(".kml") && name.charAt(name.length - 1) !== "/") {
      if (name.toLowerCase() === "doc.kml") { chosen = entry; break; }
      if (chosen === null) chosen = entry;
    }
    off += 46 + fnLen + exLen + cmLen;
  }
  if (chosen === null) throw new Error("KMZ 内没有 KML 文件");
  if (chosen.uSize > 70 * 1024 * 1024) throw new Error("KML 文件过大");
  if (dv.getUint32(chosen.lhOff, true) !== 0x04034b50) throw new Error("ZIP 本地文件头损坏");
  var lhFnLen = dv.getUint16(chosen.lhOff + 26, true);
  var lhExLen = dv.getUint16(chosen.lhOff + 28, true);
  var dataStart = chosen.lhOff + 30 + lhFnLen + lhExLen;
  var comp = u8.subarray(dataStart, dataStart + chosen.cSize);
  var raw;
  if (chosen.method === 0) {
    raw = comp;
  } else if (chosen.method === 8) {
    raw = await inflateRaw(comp);
  } else {
    throw new Error("不支持的 ZIP 压缩方式: " + chosen.method);
  }
  return parseKML(decoder.decode(raw));
}

function computePoints(raw) {
  // raw: [{lat, lon, timeMs, elev}] in track order. Mirrors _write_csv.
  if (!raw || raw.length === 0) return [];
  var startMs = raw[0].timeMs;
  var out = [];
  var total = 0;
  for (var i = 0; i < raw.length; i++) {
    if (i > 0) total += haversine(raw[i - 1].lat, raw[i - 1].lon, raw[i].lat, raw[i].lon);
    // Mirror Python _write_csv: total_seconds() first, then / 3600.
    // (One-step /3600000 can differ by 1 ulp and flip round-half-to-even
    // ties at exact .00005 boundaries.)
    var tHours = ((raw[i].timeMs - startMs) / 1000) / 3600;
    out.push({
      lat: raw[i].lat,
      lon: raw[i].lon,
      dist: i === 0 ? 0 : pyRound(total, 4),
      time: i === 0 ? 0 : pyRound(tHours, 4),
      elev: i === 0 ? raw[i].elev : pyRound(raw[i].elev, 1),
      ts: Math.floor(raw[i].timeMs / 1000)
    });
  }
  return out;
}

async function parseTrackFile(file) {
  // file: browser File (has .name, .text(), .arrayBuffer()).
  var name = file.name || "";
  var lower = name.toLowerCase();
  var raw;
  if (lower.endsWith(".kmz")) {
    var buf = await file.arrayBuffer();
    raw = await parseKMZ(buf);
  } else if (lower.endsWith(".kml")) {
    var kmlText = await file.text();
    raw = parseKML(kmlText);
  } else {
    var gpxText = await file.text();
    raw = parseGPX(gpxText);
  }
  if (!raw || raw.length === 0) throw new Error("未能解析出轨迹点（格式不正确或缺少时间）");
  return { points: computePoints(raw), name: name };
}

return {
  haversine: haversine,
  pyRound: pyRound,
  rejectEntities: rejectEntities,
  parseGPX: parseGPX,
  parseKML: parseKML,
  parseKMZ: parseKMZ,
  computePoints: computePoints,
  parseTrackFile: parseTrackFile
};
});
