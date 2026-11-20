// QR code encoder (byte mode, model 2), written for the ESC/POS viewer.
// Needs qrtables.js (QR_VERSIONS). Exposes QR.encode(bytes, level, mask?) -> { version, size, modules[y][x] }.
// level: 0 = L, 1 = M, 2 = Q, 3 = H. mask: 0..7 to force a mask, otherwise the lowest-penalty mask is used.
(function (g) {
  'use strict';
  var T = g.QR_VERSIONS;

  function row(version, level) {
    for (var i = 0; i < T.length; i++) if (T[i][0] === version && T[i][1] === level) return T[i];
    return null;
  }
  function dataCodewords(r) { return r[3] * r[4] + r[5] * r[6]; }

  // ---- Reed-Solomon over GF(256), polynomial 0x11D ----
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
  function generator(degree) { // coefficients, highest power first, leading 1 omitted
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly.slice(1);
  }
  function ecBytes(data, degree) {
    var gen = generator(degree), rem = new Array(degree).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem.shift();
      rem.push(0);
      for (var j = 0; j < degree; j++) rem[j] ^= mul(gen[j], factor);
    }
    return rem;
  }

  // ---- bit stream ----
  function buildCodewords(bytes, level) {
    var r = null;
    for (var v = 1; v <= 40; v++) {
      var cand = row(v, level);
      var bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (bits <= dataCodewords(cand) * 8) { r = cand; break; }
    }
    if (!r) throw new Error('QR data too long (' + bytes.length + ' bytes)');
    var version = r[0], cap = dataCodewords(r) * 8, bits = [];
    function put(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    var data = [];
    for (var b = 0; b < bits.length; b += 8) {
      var byte = 0;
      for (var k = 0; k < 8; k++) byte = (byte << 1) | bits[b + k];
      data.push(byte);
    }
    // split into blocks, add EC, interleave
    var blocks = [], ecs = [], pos = 0, ecLen = r[2];
    var groups = [[r[3], r[4]], [r[5], r[6]]];
    groups.forEach(function (gr) {
      for (var n = 0; n < gr[0]; n++) {
        var blk = data.slice(pos, pos + gr[1]);
        pos += gr[1];
        blocks.push(blk);
        ecs.push(ecBytes(blk, ecLen));
      }
    });
    var out = [], maxData = Math.max(r[4], r[6]);
    for (var c = 0; c < maxData; c++) blocks.forEach(function (blk) { if (c < blk.length) out.push(blk[c]); });
    for (var e = 0; e < ecLen; e++) ecs.forEach(function (ec) { out.push(ec[e]); });
    return { version: version, codewords: out };
  }

  // ---- matrix ----
  function alignmentPositions(version, size) {
    if (version === 1) return [];
    var num = Math.floor(version / 7) + 2;
    var step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (num * 2 - 2)) * 2;
    var res = [6];
    for (var p = size - 7; res.length < num; p -= step) res.splice(1, 0, p);
    return res;
  }

  function Matrix(version) {
    var size = version * 4 + 17;
    this.version = version;
    this.size = size;
    this.m = [];
    this.fn = [];
    for (var y = 0; y < size; y++) { this.m.push(new Array(size).fill(false)); this.fn.push(new Array(size).fill(false)); }
  }
  Matrix.prototype.setFn = function (x, y, dark) { this.m[y][x] = dark; this.fn[y][x] = true; };

  Matrix.prototype.drawFunctionPatterns = function () {
    var s = this.size, self = this;
    for (var i = 0; i < s; i++) { this.setFn(6, i, i % 2 === 0); this.setFn(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        var d = Math.max(Math.abs(dx), Math.abs(dy));
        self.setFn(x, y, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(s - 4, 3); finder(3, s - 4);
    var al = alignmentPositions(this.version, s), n = al.length;
    for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++)
        this.setFn(al[a] + dx2, al[b] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
    }
    this.drawFormat(0, 0); // reserve
    if (this.version >= 7) {
      var rem = this.version;
      for (var k = 0; k < 12; k++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      var vbits = (this.version << 12) | rem;
      for (var j = 0; j < 18; j++) {
        var bit = ((vbits >>> j) & 1) === 1, p = s - 11 + (j % 3), q = Math.floor(j / 3);
        this.setFn(p, q, bit); this.setFn(q, p, bit);
      }
    }
  };

  var LEVEL_BITS = [1, 0, 3, 2]; // L, M, Q, H
  Matrix.prototype.drawFormat = function (level, mask) {
    var data = (LEVEL_BITS[level] << 3) | mask, rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412, s = this.size;
    function bit(i) { return ((bits >>> i) & 1) === 1; }
    for (var a = 0; a <= 5; a++) this.setFn(8, a, bit(a));
    this.setFn(8, 7, bit(6)); this.setFn(8, 8, bit(7)); this.setFn(7, 8, bit(8));
    for (var b = 9; b < 15; b++) this.setFn(14 - b, 8, bit(b));
    for (var c = 0; c < 8; c++) this.setFn(s - 1 - c, 8, bit(c));
    for (var d = 8; d < 15; d++) this.setFn(8, s - 15 + d, bit(d));
    this.setFn(8, s - 8, true);
  };

  Matrix.prototype.drawCodewords = function (cw) {
    var s = this.size, i = 0, total = cw.length * 8;
    for (var right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < s; vert++) for (var j = 0; j < 2; j++) {
        var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? s - 1 - vert : vert;
        if (!this.fn[y][x]) {
          this.m[y][x] = i < total ? ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;
          i++;
        }
      }
    }
  };

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }
  Matrix.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) for (var x = 0; x < this.size; x++)
      if (!this.fn[y][x] && maskBit(mask, x, y)) this.m[y][x] = !this.m[y][x];
  };

  Matrix.prototype.penalty = function () {
    var s = this.size, m = this.m, score = 0, x, y;
    function lineScore(get) {
      var sc = 0;
      for (var a = 0; a < s; a++) {
        var run = 1;
        for (var b = 1; b <= s; b++) {
          if (b < s && get(a, b) === get(a, b - 1)) { run++; continue; }
          if (run >= 5) sc += 3 + (run - 5);
          run = 1;
        }
        for (var c = 0; c + 11 <= s; c++) {
          var p1 = true, p2 = true;
          var pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
          for (var k = 0; k < 11; k++) {
            var v = get(a, c + k) ? 1 : 0;
            if (v !== pat[k]) p1 = false;
            if (v !== pat[10 - k]) p2 = false;
          }
          if (p1) sc += 40;
          if (p2) sc += 40;
        }
      }
      return sc;
    }
    score += lineScore(function (a, b) { return m[a][b]; });
    score += lineScore(function (a, b) { return m[b][a]; });
    for (y = 0; y < s - 1; y++) for (x = 0; x < s - 1; x++) {
      var c0 = m[y][x];
      if (c0 === m[y][x + 1] && c0 === m[y + 1][x] && c0 === m[y + 1][x + 1]) score += 3;
    }
    var dark = 0;
    for (y = 0; y < s; y++) for (x = 0; x < s; x++) if (m[y][x]) dark++;
    var total = s * s, k2 = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k2) * 10;
    return score;
  };

  function encode(bytes, level, forceMask) {
    if (level == null) level = 1;
    var cw = buildCodewords(bytes, level);
    var best = null, bestScore = Infinity;
    var masks = forceMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
    masks.forEach(function (mask) {
      var mx = new Matrix(cw.version);
      mx.drawFunctionPatterns();
      mx.drawCodewords(cw.codewords);
      mx.applyMask(mask);
      mx.drawFormat(level, mask);
      var sc = masks.length > 1 ? mx.penalty() : 0;
      if (sc < bestScore) { bestScore = sc; best = mx; best.mask = mask; }
    });
    return { version: best.version, size: best.size, mask: best.mask, modules: best.m };
  }

  g.QR = { encode: encode };
})(typeof globalThis !== 'undefined' ? globalThis : this);
