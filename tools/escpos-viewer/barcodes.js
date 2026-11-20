// 1D barcode encoders for GS k, written for the ESC/POS viewer. Needs c128table.js (C128_PATTERNS).
// BARCODE.encode(m, bytes) -> { runs: [bar, space, bar, ...] widths in narrow units, hri: string, warnings: [] }
// or { unsupported: name } / { error: message }.
(function (g) {
  'use strict';
  var NAMES = { 0: 'UPC-A', 1: 'UPC-E', 2: 'EAN-13', 3: 'EAN-8', 4: 'CODE39', 5: 'ITF', 6: 'CODABAR',
    65: 'UPC-A', 66: 'UPC-E', 67: 'EAN-13', 68: 'EAN-8', 69: 'CODE39', 70: 'ITF', 71: 'CODABAR', 72: 'CODE93', 73: 'CODE128' };
  var WIDE = 2.5;

  function runsFromBits(bits) {
    var runs = [], cur = bits[0], n = 0;
    if (cur !== '1') throw new Error('pattern must start with a bar');
    for (var i = 0; i < bits.length; i++) {
      if (bits[i] === cur) { n++; continue; }
      runs.push(n); cur = bits[i]; n = 1;
    }
    runs.push(n);
    return runs;
  }
  function str(bytes) { return String.fromCharCode.apply(null, bytes); }

  // ---- EAN / UPC ----
  var L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  var R = L.map(function (p) { return p.replace(/./g, function (c) { return c === '0' ? '1' : '0'; }); });
  var G = R.map(function (p) { return p.split('').reverse().join(''); });
  var PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  function check(digits, firstWeight) { // firstWeight: weight of the leftmost digit
    var sum = 0;
    for (var i = 0; i < digits.length; i++) sum += (+digits[i]) * ((i % 2 === 0) ? firstWeight : 4 - firstWeight);
    return String((10 - sum % 10) % 10);
  }
  function ean13(d) {
    var bits = '101', par = PARITY[+d[0]];
    for (var i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? L : G)[+d[i]];
    bits += '01010';
    for (var j = 7; j <= 12; j++) bits += R[+d[j]];
    return bits + '101';
  }
  function ean8(d) {
    var bits = '101';
    for (var i = 0; i < 4; i++) bits += L[+d[i]];
    bits += '01010';
    for (var j = 4; j < 8; j++) bits += R[+d[j]];
    return bits + '101';
  }
  function eanLike(kind, s) {
    var spec = { 'EAN-13': [12, 13, 1], 'EAN-8': [7, 8, 3], 'UPC-A': [11, 12, 3] }[kind];
    if (!/^\d+$/.test(s) || (s.length !== spec[0] && s.length !== spec[1]))
      return { error: kind + ' needs ' + spec[0] + ' or ' + spec[1] + ' digits, got "' + s + '"' };
    var warnings = [], body = s.slice(0, spec[0]), cd = check(body, spec[2]);
    if (s.length === spec[1] && s[spec[0]] !== cd)
      warnings.push(kind + ' check digit is ' + s[spec[0]] + ' but should be ' + cd + '. Many printers refuse to print this.');
    var full = body + (s.length === spec[1] ? s[spec[0]] : cd);
    var bits = kind === 'EAN-8' ? ean8(full) : ean13(kind === 'UPC-A' ? '0' + full : full);
    return { runs: runsFromBits(bits), hri: full, warnings: warnings };
  }

  // ---- CODE39 (1 = wide element; 5 bars and 4 spaces, starting with a bar) ----
  var C39 = { '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001', '5': '100110000',
    '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100', 'A': '100001001', 'B': '001001001',
    'C': '101001000', 'D': '000011001', 'E': '100011000', 'F': '001011000', 'G': '000001101', 'H': '100001100',
    'I': '001001100', 'J': '000011100', 'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011',
    'O': '100010010', 'P': '001010010', 'Q': '000000111', 'R': '100000110', 'S': '001000110', 'T': '000010110',
    'U': '110000001', 'V': '011000001', 'W': '111000000', 'X': '010010001', 'Y': '110010000', 'Z': '011010000',
    '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000', '/': '010100010', '+': '010001010',
    '%': '000101010', '*': '010010100' };
  function code39(s) {
    var warnings = [], body = s;
    if (body[0] === '*' && body[body.length - 1] === '*' && body.length >= 2) body = body.slice(1, -1);
    for (var i = 0; i < body.length; i++)
      if (!C39[body[i]] || body[i] === '*') return { error: 'CODE39 cannot encode "' + body[i] + '" (only 0-9, A-Z, space and - . $ / + %)' };
    var full = '*' + body + '*', runs = [];
    for (var j = 0; j < full.length; j++) {
      var p = C39[full[j]];
      for (var k = 0; k < 9; k++) runs.push(p[k] === '1' ? WIDE : 1);
      if (j < full.length - 1) runs.push(1); // inter-character gap
    }
    return { runs: runs, hri: '*' + body + '*', warnings: warnings };
  }

  // ---- ITF (interleaved 2 of 5) ----
  var I25 = ['00110', '10001', '01001', '11000', '00101', '10100', '01100', '00011', '10010', '01010'];
  function itf(s) {
    if (!/^\d+$/.test(s)) return { error: 'ITF needs digits only, got "' + s + '"' };
    if (s.length % 2) return { error: 'ITF needs an even number of digits, got ' + s.length };
    var runs = [1, 1, 1, 1];
    for (var i = 0; i < s.length; i += 2) {
      var a = I25[+s[i]], b = I25[+s[i + 1]];
      for (var k = 0; k < 5; k++) { runs.push(a[k] === '1' ? WIDE : 1); runs.push(b[k] === '1' ? WIDE : 1); }
    }
    runs.push(WIDE, 1, 1);
    return { runs: runs, hri: s, warnings: [] };
  }

  // ---- CODE128 with ESC/POS code set prefixes ({A {B {C, {S shift, {1-{4 FNC, {{ literal) ----
  function code128(bytes) {
    var P = g.C128_PATTERNS;
    if (bytes.length < 2 || bytes[0] !== 0x7b || [0x41, 0x42, 0x43].indexOf(bytes[1]) < 0)
      return { error: 'CODE128 data must start with {A, {B or {C (code set selection). Got "' + str(bytes.slice(0, 2)) + '"' };
    var set = String.fromCharCode(bytes[1]), vals = [{ A: 103, B: 104, C: 105 }[set]], hri = '';
    for (var i = 2; i < bytes.length; i++) {
      var b = bytes[i];
      if (b === 0x7b && i + 1 < bytes.length) {
        var c = String.fromCharCode(bytes[++i]);
        if (c === 'A' || c === 'B' || c === 'C') {
          if (c === set) continue;
          vals.push({ A: 101, B: 100, C: 99 }[c]);
          set = c; continue;
        }
        if (c === 'S') { vals.push(98); continue; }
        if (c === '1') { vals.push(102); continue; }
        if (c === '2') { vals.push(97); continue; }
        if (c === '3') { vals.push(96); continue; }
        if (c === '4') { vals.push(set === 'A' ? 101 : 100); continue; }
        if (c === '{') { b = 0x7b; } else return { error: 'CODE128: unknown escape "{' + c + '"' };
      }
      if (set === 'C') {
        if (b > 99) return { error: 'CODE128 code set C takes byte values 0-99 (two digits per byte), got ' + b };
        vals.push(b); hri += (b < 10 ? '0' : '') + b;
      } else if (set === 'A') {
        if (b > 95) return { error: 'CODE128 code set A cannot encode byte 0x' + b.toString(16) };
        vals.push(b < 32 ? b + 64 : b - 32); if (b >= 32) hri += String.fromCharCode(b);
      } else {
        if (b < 32 || b > 127) return { error: 'CODE128 code set B cannot encode byte 0x' + b.toString(16) };
        vals.push(b - 32); hri += String.fromCharCode(b);
      }
    }
    var sum = vals[0];
    for (var k = 1; k < vals.length; k++) sum += k * vals[k];
    vals.push(sum % 103);
    var bits = vals.map(function (v) { return P[v]; }).join('') + P[106];
    return { runs: runsFromBits(bits), hri: hri, warnings: [] };
  }

  function encode(m, bytes) {
    var name = NAMES[m];
    if (!name) return { error: 'Unknown barcode type m=' + m };
    var s = str(bytes);
    switch (name) {
      case 'UPC-A': case 'EAN-13': case 'EAN-8': return eanLike(name, s);
      case 'CODE39': return code39(s);
      case 'ITF': return itf(s);
      case 'CODE128': return code128(bytes);
      default: return { unsupported: name, hri: s };
    }
  }
  g.BARCODE = { encode: encode, names: NAMES, WIDE: WIDE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
