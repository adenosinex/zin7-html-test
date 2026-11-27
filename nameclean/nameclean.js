/* nameclean.js - SEG v5 logic ported from nameclean/app.py (Python) + apply engine
   from nameclean_client.py. Pure string computation, no I/O.
   Exports (browser global `Nameclean`, node module.exports):
     tokenize(filename)          -> segments (alias of segments)
     segments(filename)          -> string[]
     atomsOf(filename)           -> string[][] (regions of atoms)
     minePhrases(filenames, threshold) -> [{token, cnt, head, tail, samples, docs}]
     analyzeBatch(filenames, coreSet)  -> [{token, cnt, head, tail, samples, hint}]
     applyRules(filename, rules) -> {name, hits}  (rules: {blacklist, replace, keep, substr})
     splitExt, tkey, isProtected, isPhrasePattern, chineseRuns, hintOf
*/
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.Nameclean = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

var SEG_VERSION = 5;
var CANDIDATE_CAP = 80;
var PHRASE_MIN_LEN = 4;
var PHRASE_MAX_CORPUS = 120000;

var SEP_CHARS = new Set(["-","_"," ","\t","|","~","\u00b7","\u2022","\u30fb","*","+","&","@","#","%","=",",","\uff0c",";","\uff1b","'",'"']);
var BRACKET_CHARS = new Set(["[","]","(",")","\uff08","\uff09","\u300a","\u300b","\u3008","\u3009","{","}","<",">","\u300c","\u300d","\u300e","\u300f","\u3010","\u3011"]);
var DOMAIN_RE = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9\-]{1,30}\.(?:com|net|org|cc|xyz|top|vip|cn|io|me|tv|co|info|site|club|online)(?:\.[a-z]{2,3})?/gi;
var YEAR_RE = /^(19|20)\d{2}$/;
var EPISODE_RE = /^(s\d{1,2}e\d{1,3}|e\d{1,3}|ep\d{1,3}|cd\d|dvd\d|[\u7b2c][0-9\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u96f6\u3007\u4e24]+[\u96c6\u671f\u8bdd\u8a71\u56de\u8bb2\u8b1b])$/i;
var DIGITS_RE = /^\d+$/;
var CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2a6df}]/u;
var SYMBOL_RE = /\p{So}|\p{Sk}/u;
var PHRASE_CONNECTORS = new Set(["-","_"," ","\t","|","~","\u00b7","\u2022","\u30fb","/","&","+","\uff0c",",","\u3001","\uff1a",":","\uff1b",";","\uff01","!","\uff1f","?","\u3002","\u2026","\u2014","\u2013"]);
var EPISODE_SPAN_RE = /[\u7b2c][0-9]+[\u96c6\u671f\u8bdd\u8a71\u56de\u8bb2\u8b1b]|[0-9]+[\u96c6\u671f]/g;

var KNOWN_EXTS = new Set(["mp4","mkv","avi","mov","wmv","flv","ts","m2ts","rmvb","rm","webm","mpg","mpeg","m4v","3gp","srt","ass","ssa","vtt"]);

var AD_HINTS = ["\u5f71\u89c6","\u7535\u5f71","\u8d44\u6e90","\u9996\u53d1","\u72ec\u5bb6","\u514d\u8d39","\u4e0b\u8f7d","\u6700\u65b0","\u6700\u5168","\u793e\u533a","\u8bba\u575b","\u51fa\u54c1","\u5448\u73b0","\u5fae\u4fe1","\u516c\u4f17\u53f7","\u5bfc\u822a","\u5b98\u7f51","\u53d1\u5e03","\u4ea4\u6d41\u7fa4","\u52a0\u7fa4","\u9ad8\u6e05","\u8d85\u6e05","\u84dd\u5149","\u6bcf\u65e5","\u66f4\u65b0","\u5929\u5802","\u4e4b\u5bb6","\u5728\u7ebf","\u89c2\u770b","\u5b8c\u6574\u7248","\u672a\u5220\u51cf"];
var TECH_HINTS = ["bluray","bdrip","bd","web-dl","webdl","hdtv","x264","x265","h264","h265","hevc","avc","dts","aac","ac3","10bit","hdr","remux","dvdrip","brrip","2160p","1080p","720p","480p","4k","2k","uhd","fps","\u7801\u7387"];

function isAscii(s) { return /^[\x00-\x7f]*$/.test(s); }
function isCjk(ch) { return CJK_RE.test(ch); }
function isSymbol(ch) { return SYMBOL_RE.test(ch); }

function splitExt(name) {
  var dot = name.lastIndexOf(".");
  if (dot >= 0) {
    var stem = name.slice(0, dot);
    var ext = name.slice(dot + 1);
    if (stem && KNOWN_EXTS.has(ext.toLowerCase())) return [stem, "." + ext];
    if (stem && ext.length > 0 && ext.length <= 5 && isAscii(ext) && /^[A-Za-z0-9]+$/.test(ext)) return [stem, "." + ext];
  }
  return [name, ""];
}

function stripDomains(text) {
  DOMAIN_RE.lastIndex = 0;
  return text.replace(DOMAIN_RE, "\x00");
}

function tkey(token) {
  return isAscii(token) ? token.toLowerCase() : token;
}

function segmentsOfStem(stem) {
  var out = [], cur = [];
  for (var i = 0; i < stem.length; i++) {
    var ch = stem[i];
    if (SEP_CHARS.has(ch) || BRACKET_CHARS.has(ch) || ch === "." || ch === "\x00") {
      if (cur.length) { out.push(cur.join("")); cur = []; }
    } else {
      cur.push(ch);
    }
  }
  if (cur.length) out.push(cur.join(""));
  return out.map(function (t) { return t.trim(); })
    .filter(function (t) { return t && !KNOWN_EXTS.has(t.toLowerCase()); });
}

function segments(name) {
  var se = splitExt(name);
  return segmentsOfStem(stripDomains(se[0]));
}

function isProtected(token) {
  return YEAR_RE.test(token) || EPISODE_RE.test(token) || DIGITS_RE.test(token);
}

function chineseRuns(name) {
  var se = splitExt(name);
  var stem = stripDomains(se[0]);
  var runs = [], chars = [], idxs = [];
  for (var pos = 0; pos < stem.length; pos++) {
    var ch = stem[pos];
    if (isCjk(ch)) { chars.push(ch); idxs.push(pos); }
    else if (PHRASE_CONNECTORS.has(ch) || isSymbol(ch)) { /* connector: skip */ }
    else {
      if (chars.length) {
        runs.push([stem.slice(idxs[0], idxs[idxs.length - 1] + 1), chars.join("")]);
        chars = []; idxs = [];
      }
    }
  }
  if (chars.length) runs.push([stem.slice(idxs[0], idxs[idxs.length - 1] + 1), chars.join("")]);
  return runs;
}

function phraseOccurrences(name, pattern) {
  if (!pattern) return 0;
  var n = 0;
  var runs = chineseRuns(name);
  for (var i = 0; i < runs.length; i++) if (runs[i][1].indexOf(pattern) >= 0) n++;
  return n;
}

function isPhrasePattern(pattern) {
  if (pattern.length < PHRASE_MIN_LEN) return false;
  var cjk = 0;
  for (var i = 0; i < pattern.length; i++) if (isCjk(pattern[i])) cjk++;
  return cjk >= PHRASE_MIN_LEN && cjk * 2 >= pattern.length;
}

function charClass(ch) {
  if (isCjk(ch)) return "C";
  if (isAscii(ch) && /^[A-Za-z0-9]$/.test(ch)) return "A";
  if (BRACKET_CHARS.has(ch)) return "B";
  return "S";
}

function atomsOf(name) {
  var se = splitExt(name);
  var stem = stripDomains(se[0]);
  var forced = {};
  EPISODE_SPAN_RE.lastIndex = 0;
  var m;
  while ((m = EPISODE_SPAN_RE.exec(stem)) !== null) forced[m.index] = m.index + m[0].length;
  var regions = [], region = [];
  var i = 0, n = stem.length;
  while (i < n) {
    if (forced[i] !== undefined) {
      region.push(stem.slice(i, forced[i]));
      i = forced[i];
      continue;
    }
    var cls = charClass(stem[i]);
    if (cls === "B" || stem[i] === "\x00" || stem[i] === "." || stem[i] === "\uff0e") {
      if (region.length) { regions.push(region); region = []; }
      i += 1;
      continue;
    }
    if (cls === "S") { i += 1; continue; }
    var j = i;
    while (j < n && forced[j] === undefined && charClass(stem[j]) === cls) j++;
    var atom = stem.slice(i, j);
    region.push(cls === "A" ? atom.toLowerCase() : atom);
    i = j;
  }
  if (region.length) regions.push(region);
  return regions;
}

function isPureCjk(s) {
  if (!s) return false;
  for (var i = 0; i < s.length; i++) if (!isCjk(s[i])) return false;
  return true;
}

function samPhraseCandidates(runs, threshold) {
  var nexts = [new Map()];
  var link = [-1];
  var length = [0];
  var sample = [[-1, -1]];
  var docs = [new Set()];
  function newState(nxt, lnk, ln, smp, dset) {
    nexts.push(nxt); link.push(lnk); length.push(ln); sample.push(smp); docs.push(dset);
    return nexts.length - 1;
  }
  for (var runId = 0; runId < runs.length; runId++) {
    var docId = runs[runId][0], text = runs[runId][1];
    var last = 0;
    for (var pos = 0; pos < text.length; pos++) {
      var ch = text[pos];
      var cur = newState(new Map(), 0, length[last] + 1, [runId, pos], new Set([docId]));
      var p = last;
      while (p !== -1 && !nexts[p].has(ch)) { nexts[p].set(ch, cur); p = link[p]; }
      if (p === -1) {
        link[cur] = 0;
      } else {
        var q = nexts[p].get(ch);
        if (length[p] + 1 === length[q]) {
          link[cur] = q;
        } else {
          var clone = newState(new Map(nexts[q]), link[q], length[p] + 1, sample[q], new Set());
          while (p !== -1 && nexts[p].get(ch) === q) { nexts[p].set(ch, clone); p = link[p]; }
          link[q] = link[cur] = clone;
        }
      }
      last = cur;
    }
  }
  var order = [];
  for (var v = 0; v < nexts.length; v++) order.push(v);
  order.sort(function (a, b) { return length[b] - length[a]; });
  for (var oi = 0; oi < order.length; oi++) {
    var vv = order[oi], parent = link[vv];
    if (parent >= 0) {
      // propagate child's docs into parent (union)
      var childDocs = docs[vv];
      childDocs.forEach(function (d) { docs[parent].add(d); });
    }
  }
  var found = new Map();
  for (var v2 = 1; v2 < nexts.length; v2++) {
    var df = docs[v2].size;
    if (df < threshold || length[v2] < PHRASE_MIN_LEN) continue;
    var runId2 = sample[v2][0], end = sample[v2][1];
    var text2 = runs[runId2][1];
    var s = text2.slice(end - length[v2] + 1, end + 1);
    if (s.length === length[v2] && df > (found.has(s) ? found.get(s) : 0)) found.set(s, df);
  }
  var kept = [];
  var entries = Array.from(found.entries());
  entries.sort(function (a, b) {
    if (b[0].length !== a[0].length) return b[0].length - a[0].length;
    if (b[1] !== a[1]) return b[1] - a[1];
    return 0;
  });
  for (var ei = 0; ei < entries.length; ei++) {
    var s2 = entries[ei][0], df2 = entries[ei][1];
    var covered = false;
    for (var ki = 0; ki < kept.length; ki++) {
      if (df2 <= kept[ki][1] && kept[ki][0].indexOf(s2) >= 0) { covered = true; break; }
    }
    if (!covered) kept.push([s2, df2]);
  }
  return kept;
}

function mineAtomPhrases(regionsPerFile, filenames, threshold) {
  var runs = [], total = 0;
  for (var docId = 0; docId < regionsPerFile.length; docId++) {
    var regions = regionsPerFile[docId];
    for (var ri = 0; ri < regions.length; ri++) {
      for (var ai = 0; ai < regions[ri].length; ai++) {
        var atom = regions[ri][ai];
        if (atom.length >= PHRASE_MIN_LEN && isPureCjk(atom)) {
          runs.push([docId, atom]);
          total += atom.length;
        }
      }
    }
  }
  if (!runs.length || total > PHRASE_MAX_CORPUS) return {};
  var out = {};
  var cands = samPhraseCandidates(runs, threshold);
  for (var ci = 0; ci < cands.length; ci++) {
    var phrase = cands[ci][0], df = cands[ci][1];
    var head = 0, tail = 0, samples = [], docs = new Set();
    for (var d = 0; d < regionsPerFile.length; d++) {
      var hit = false;
      var regs = regionsPerFile[d];
      for (var r2 = 0; r2 < regs.length; r2++) {
        for (var a2 = 0; a2 < regs[r2].length; a2++) {
          var at = regs[r2][a2];
          if (at.indexOf(phrase) >= 0) {
            hit = true;
            if (at.indexOf(phrase) === 0) head++;
            if (at.lastIndexOf(phrase) === at.length - phrase.length) tail++;
          }
        }
      }
      if (hit) {
        docs.add(d);
        if (samples.length < 3) samples.push(filenames[d]);
      }
    }
    out[phrase] = { cnt: df, head: head, tail: tail, samples: samples, docs: docs };
  }
  return out;
}

function atomSpanStats(regionsPerFile, filenames, threshold) {
  var out = {};
  for (var docId = 0; docId < regionsPerFile.length; docId++) {
    var seen = new Set();
    var regions = regionsPerFile[docId];
    for (var ri = 0; ri < regions.length; ri++) {
      var region = regions[ri], n = region.length;
      for (var a = 0; a < n; a++) {
        if (isProtected(region[a]) || KNOWN_EXTS.has(region[a].toLowerCase())) continue;
        var text = "", allCjk = true;
        for (var k = a; k < Math.min(n, a + 6); k++) {
          if (k > a && isProtected(region[k])) break;
          if (!isPureCjk(region[k])) allCjk = false;
          text += region[k];
          if (text.length < 2) continue;
          if (k > a && !allCjk) continue;
          if (seen.has(text)) continue;
          seen.add(text);
          var s = out[text];
          if (!s) s = out[text] = { cnt: 0, head: 0, tail: 0, samples: [], docs: new Set() };
          s.docs.add(docId);
          if (a === 0) s.head++;
          if (k === n - 1) s.tail++;
          if (s.samples.length < 3) s.samples.push(filenames[docId]);
        }
      }
    }
  }
  Object.keys(out).forEach(function (text) {
    var s = out[text];
    s.cnt = s.docs.size;
    if (s.cnt < threshold) delete out[text];
  });
  return out;
}

function hintOf(token) {
  var low = token.toLowerCase();
  for (var i = 0; i < AD_HINTS.length; i++) if (token.indexOf(AD_HINTS[i]) >= 0) return "\u7591\u4f3c\u5e7f\u544a";
  for (var j = 0; j < TECH_HINTS.length; j++) if (low.indexOf(TECH_HINTS[j]) >= 0) return "\u6280\u672f\u6807\u7b7e";
  if (token.length >= 6) {
    for (var k = 0; k < token.length; k++) if (isCjk(token[k])) return "\u4e2d\u6587\u957f\u4e32";
  }
  return "";
}

function candidateThreshold(nfiles) {
  if (nfiles < 10) return 1;
  return Math.max(3, Math.ceil(nfiles / 50));
}

function dedupContained(stats, regionsPerFile, phrases, threshold) {
  var normRuns = regionsPerFile.map(function (regions) {
    return regions.map(function (region) { return region.join(""); });
  });
  function occSpans(s) {
    var spans = {};
    for (var doc = 0; doc < normRuns.length; doc++) {
      var runs = normRuns[doc], lst = [];
      for (var ri = 0; ri < runs.length; ri++) {
        var text = runs[ri], start = 0;
        while (true) {
          var j = text.indexOf(s, start);
          if (j < 0) break;
          lst.push([ri, j, j + s.length]);
          start = j + 1;
        }
      }
      if (lst.length) spans[doc] = lst;
    }
    return spans;
  }
  function ownersCovering(claimed, doc, ri, a, b) {
    var owners = new Set();
    var lst = claimed[doc + ":" + ri] || [];
    for (var i = 0; i < lst.length; i++) {
      var sp = lst[i];
      if (sp[0] <= a && b <= sp[1]) owners.add(sp[2]);
    }
    return owners;
  }
  var claimed = {};
  var selected = {};
  var cand = [];
  Object.keys(stats).forEach(function (k) {
    if (phrases[k] || isPureCjk(k)) {
      var spans = occSpans(k);
      if (Object.keys(spans).length) cand.push([k, spans]);
    }
  });
  cand.sort(function (a, b) {
    if (b[0].length !== a[0].length) return b[0].length - a[0].length;
    var na = Object.keys(a[1]).length, nb = Object.keys(b[1]).length;
    if (nb !== na) return nb - na;
    return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
  });
  var rawDf = {}, dropped = {};
  for (var ci = 0; ci < cand.length; ci++) {
    var k = cand[ci][0], spans = cand[ci][1];
    rawDf[k] = Object.keys(spans).length;
    var residual = new Set(), coverers = new Set();
    Object.keys(spans).forEach(function (docKey) {
      var doc = +docKey, lst = spans[docKey], docCovered = true;
      for (var i = 0; i < lst.length; i++) {
        var owners = ownersCovering(claimed, doc, lst[i][0], lst[i][1], lst[i][2]);
        if (owners.size) owners.forEach(function (o) { coverers.add(o); });
        else docCovered = false;
      }
      if (!docCovered) residual.add(doc);
    });
    if (residual.size >= threshold) {
      selected[k] = new Set(residual);
      stats[k].cnt = residual.size;
      stats[k].rawDocs = new Set(Object.keys(spans).map(function (x) { return +x; }));
      if (Object.keys(spans).length >= 2) {
        Object.keys(spans).forEach(function (docKey) {
          var doc = +docKey;
          spans[docKey].forEach(function (sp) {
            var key = doc + ":" + sp[0];
            if (!claimed[key]) claimed[key] = [];
            claimed[key].push([sp[1], sp[2], k]);
          });
        });
      }
    } else {
      dropped[k] = [stats[k], coverers];
      delete stats[k];
    }
  }
  var sharedCore = new Set();
  Object.keys(dropped).forEach(function (k) {
    var entry = dropped[k][0], coverers = dropped[k][1];
    if (coverers.size >= 2 && rawDf[k] >= threshold) {
      var allGreater = true;
      coverers.forEach(function (o) { if (!(rawDf[k] > rawDf[o])) allGreater = false; });
      if (allGreater) {
        entry.cnt = rawDf[k];
        stats[k] = entry;
        selected[k] = new Set(entry.docs || []);
        sharedCore.add(k);
      }
    }
  });
  Object.keys(stats).forEach(function (k) {
    if (selected[k]) return;
    var s = stats[k];
    var selKeys = Object.keys(selected);
    for (var i = 0; i < selKeys.length; i++) {
      var p = selKeys[i];
      var pdocs = (stats[p] && stats[p].rawDocs) || selected[p];
      if (p.indexOf(k) >= 0 && s.docs && s.docs.size) {
        var subset = true;
        s.docs.forEach(function (d) { if (!pdocs.has(d)) subset = false; });
        if (subset) { delete stats[k]; break; }
      }
    }
  });
  var cover = {};
  Object.keys(selected).forEach(function (p) { cover[p] = new Set(); });
  Object.keys(stats).forEach(function (k) {
    if (selected[k]) return;
    var s = stats[k];
    if (s.cnt < threshold) return;
    var hasCjk = false;
    for (var i = 0; i < k.length; i++) if (isCjk(k[i])) { hasCjk = true; break; }
    if (!hasCjk) return;
    var tnorm = "";
    chineseRuns(k).forEach(function (r) { tnorm += r[1]; });
    if (!tnorm) return;
    Object.keys(selected).forEach(function (p) {
      if (tnorm.indexOf(p) >= 0) {
        (s.docs || new Set()).forEach(function (d) { cover[p].add(d); });
      }
    });
  });
  Object.keys(cover).forEach(function (p) {
    var cov = cover[p];
    if (!cov.size || !stats[p] || sharedCore.has(p)) return;
    var residual = new Set();
    selected[p].forEach(function (d) { if (!cov.has(d)) residual.add(d); });
    if (residual.size < threshold) delete stats[p];
    else stats[p].cnt = residual.size;
  });
}

function candRank(a, b) {
  var tokenA = a[0], sA = a[1], tokenB = b[0], sB = b[1];
  function cjkCount(t) { var n = 0; for (var i = 0; i < t.length; i++) if (isCjk(t[i])) n++; return n; }
  var cjkA = cjkCount(tokenA), cjkB = cjkCount(tokenB);
  var catA = cjkA >= 2 ? 0 : 1, catB = cjkB >= 2 ? 0 : 1;
  if (catA !== catB) return catA - catB;
  var scoreA = sA.cnt * Math.min(tokenA.length, 24) * (cjkA >= PHRASE_MIN_LEN ? 2 : 1);
  var scoreB = sB.cnt * Math.min(tokenB.length, 24) * (cjkB >= PHRASE_MIN_LEN ? 2 : 1);
  if (scoreB !== scoreA) return scoreB - scoreA;
  if (sB.cnt !== sA.cnt) return sB.cnt - sA.cnt;
  if (tokenB.length !== tokenA.length) return tokenB.length - tokenA.length;
  if (sB.head !== sA.head) return sB.head - sA.head;
  return tokenA < tokenB ? -1 : (tokenA > tokenB ? 1 : 0);
}

function analyzeBatch(filenames, coreSet) {
  coreSet = coreSet || new Set();
  var stats = {};
  for (var docId = 0; docId < filenames.length; docId++) {
    var fn = filenames[docId];
    var toks = segments(fn);
    var last = toks.length - 1;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i], k = tkey(t);
      if (coreSet.has(k) || isProtected(t) || t.length < 2) continue;
      var s = stats[k];
      if (!s) s = stats[k] = { cnt: 0, head: 0, tail: 0, samples: [], docs: new Set() };
      s.cnt += 1;
      s.docs.add(docId);
      if (i === 0) s.head += 1;
      if (i === last && last > 0) s.tail += 1;
      if (s.samples.length < 3 && s.samples.indexOf(fn) < 0) s.samples.push(fn);
    }
  }
  var nfiles = filenames.length;
  var threshold = candidateThreshold(nfiles);
  var regionsPerFile = filenames.map(function (fn) { return atomsOf(fn); });
  var phrases = mineAtomPhrases(regionsPerFile, filenames, threshold);
  var extra = {};
  Object.keys(phrases).forEach(function (k) { extra[k] = phrases[k]; });
  var spanStats = atomSpanStats(regionsPerFile, filenames, threshold);
  Object.keys(spanStats).forEach(function (phrase) { extra[phrase] = spanStats[phrase]; });
  Object.keys(extra).forEach(function (phrase) {
    var ps = extra[phrase];
    if (coreSet.has(tkey(phrase)) || isProtected(phrase)) return;
    var s = stats[phrase];
    if (!s) {
      stats[phrase] = ps;
    } else {
      s.cnt = Math.max(s.cnt, ps.cnt);
      s.head = Math.max(s.head, ps.head);
      s.tail = Math.max(s.tail, ps.tail);
      var docs = s.docs || new Set();
      ps.docs.forEach(function (d) { docs.add(d); });
      s.docs = docs;
      ps.samples.forEach(function (fn) {
        if (s.samples.length < 3 && s.samples.indexOf(fn) < 0) s.samples.push(fn);
      });
    }
  });
  dedupContained(stats, regionsPerFile, phrases, threshold);
  var ranked = Object.keys(stats).map(function (k) { return [k, stats[k]]; });
  ranked.sort(candRank);
  var above = ranked.filter(function (kv) { return kv[1].cnt >= threshold; });
  var shown = above.slice(0, CANDIDATE_CAP);
  var lowfreq = ranked.length - shown.length;
  return {
    threshold: threshold,
    lowfreq: lowfreq,
    candidates: shown.map(function (kv) {
      var k = kv[0], s = kv[1];
      return { token: k, cnt: s.cnt, head: s.head, tail: s.tail, samples: s.samples.slice(), hint: hintOf(k) };
    })
  };
}

function minePhrases(filenames, threshold) {
  var regionsPerFile = filenames.map(function (fn) { return atomsOf(fn); });
  var phrases = mineAtomPhrases(regionsPerFile, filenames, threshold);
  var extra = atomSpanStats(regionsPerFile, filenames, threshold);
  Object.keys(extra).forEach(function (phrase) { phrases[phrase] = extra[phrase]; });
  return Object.keys(phrases).map(function (k) {
    var s = phrases[k];
    return { token: k, cnt: s.cnt, head: s.head, tail: s.tail, samples: s.samples.slice() };
  });
}

function cjkRuns(stem) {
  var runs = [], chars = [], idxs = [];
  for (var pos = 0; pos < stem.length; pos++) {
    var ch = stem[pos];
    if (isCjk(ch)) { chars.push(ch); idxs.push(pos); }
    else if (PHRASE_CONNECTORS.has(ch) || isSymbol(ch)) { /* connector */ }
    else {
      if (chars.length) { runs.push([idxs, chars.join("") ]); chars = []; idxs = []; }
    }
  }
  if (chars.length) runs.push([idxs, chars.join("")]);
  return runs;
}

function applyPhrase(stem, pattern, repl) {
  var spans = [];
  var runs = cjkRuns(stem);
  for (var i = 0; i < runs.length; i++) {
    var idxs = runs[i][0], norm = runs[i][1], start = 0;
    while (true) {
      var j = norm.indexOf(pattern, start);
      if (j < 0) break;
      spans.push([idxs[j], idxs[j + pattern.length - 1] + 1]);
      start = j + 1;
    }
  }
  if (!spans.length) return [stem, 0];
  spans.sort(function (a, b) { return a[0] - b[0]; });
  var out = [], last = 0, applied = 0;
  for (var k = 0; k < spans.length; k++) {
    var a = spans[k][0], b = spans[k][1];
    if (a < last) continue;
    out.push(stem.slice(last, a));
    out.push(repl);
    last = b;
    applied++;
  }
  out.push(stem.slice(last));
  return [out.join(""), applied];
}

function applyRules(filename, rules) {
  var keep = {}, blacklist = {}, replace = {}, substrs = [];
  (rules.keep || []).forEach(function (x) { keep[tkey(x)] = true; });
  (rules.blacklist || []).forEach(function (x) { blacklist[tkey(x)] = true; });
  (rules.replace || []).forEach(function (pair) { replace[tkey(pair[0])] = pair[1]; });
  substrs = (rules.substr || []).slice();
  var se = splitExt(filename);
  var stem0 = se[0], ext = se[1];
  var work = stripDomains(stem0);
  var hits = {};
  var phraseRules = [];
  Object.keys(blacklist).forEach(function (k) { if (isPhrasePattern(k)) phraseRules.push([k, ""]); });
  Object.keys(replace).forEach(function (k) { if (isPhrasePattern(k)) phraseRules.push([k, replace[k]]); });
  phraseRules.sort(function (a, b) { return b[0].length - a[0].length; });
  for (var pi = 0; pi < phraseRules.length; pi++) {
    var r = applyPhrase(work, phraseRules[pi][0], phraseRules[pi][1]);
    work = r[0];
    if (r[1]) hits[phraseRules[pi][0]] = (hits[phraseRules[pi][0]] || 0) + r[1];
  }
  var out = [];
  var toks = segmentsOfStem(work);
  for (var ti = 0; ti < toks.length; ti++) {
    var tok = toks[ti], k = tkey(tok);
    if (keep[k]) { out.push(tok); continue; }
    if (replace[k] !== undefined) {
      hits[k] = (hits[k] || 0) + 1;
      if (replace[k]) out.push(replace[k]);
      continue;
    }
    if (blacklist[k] && !isProtected(tok)) { hits[k] = (hits[k] || 0) + 1; continue; }
    var t = tok;
    for (var si = 0; si < substrs.length; si++) {
      var s = substrs[si];
      if (s && t.indexOf(s) >= 0) { hits[s] = (hits[s] || 0) + 1; t = t.split(s).join(""); }
    }
    t = t.trim();
    if (t) out.push(t);
    else if (tok) hits[k] = (hits[k] || 0) + 1;
  }
  if (!out.length) return { name: filename, hits: {} };
  var nw = out.join(".") + ext;
  if (nw.length - ext.length < 2 || nw === filename) return { name: filename, hits: {} };
  return { name: nw, hits: hits };
}

function tokenize(filename) { return segments(filename); }

return {
  SEG_VERSION: SEG_VERSION,
  CANDIDATE_CAP: CANDIDATE_CAP,
  PHRASE_MIN_LEN: PHRASE_MIN_LEN,
  splitExt: splitExt,
  tkey: tkey,
  segments: segments,
  tokenize: tokenize,
  atomsOf: atomsOf,
  isProtected: isProtected,
  isPhrasePattern: isPhrasePattern,
  chineseRuns: chineseRuns,
  phraseOccurrences: phraseOccurrences,
  hintOf: hintOf,
  candidateThreshold: candidateThreshold,
  minePhrases: minePhrases,
  analyzeBatch: analyzeBatch,
  applyRules: applyRules
};
});
