// ESC/POS interpreter for the browser-based viewer. Turns printer bytes into drawing operations,
// a command log and warnings. No DOM access here, so it runs in Node for tests too.
// Needs codepages.js, qrtables.js + qr.js, c128table.js + barcodes.js.
(function (g) {
  'use strict';

  var ESC = 0x1b, GS = 0x1d, FS = 0x1c, DLE = 0x10;
  var FONTS = { A: { w: 12, h: 24 }, B: { w: 9, h: 17 } };

  function hex(bytes, max) {
    var out = [], n = Math.min(bytes.length, max || 24);
    for (var i = 0; i < n; i++) out.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16).toUpperCase());
    return out.join(' ') + (bytes.length > n ? ' …' : '');
  }

  // ---------- input decoding ----------
  // Accepts hex ("1B 40", "0x1b,0x40", "\x1b\x40", "1b40"), base64, or text with C-style escapes.
  function decodeInput(text, mode) {
    var t = String(text || '');
    var compact = t.replace(/0x/gi, '').replace(/\\x/gi, '').replace(/[\s,;:]+/g, '');
    var looksHex = /^[0-9a-fA-F]*$/.test(compact) && compact.length > 0 && compact.length % 2 === 0;
    var b64 = t.replace(/\s+/g, '');
    var looksB64 = /^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0;
    if (mode === 'auto' || !mode) mode = looksHex ? 'hex' : looksB64 ? 'base64' : 'escaped';
    var bytes = [];
    if (mode === 'hex') {
      if (!/^[0-9a-fA-F]*$/.test(compact)) throw new Error('Not valid hex: found characters other than 0-9 and A-F.');
      if (compact.length % 2) throw new Error('Hex input has an odd number of digits (' + compact.length + ').');
      for (var i = 0; i < compact.length; i += 2) bytes.push(parseInt(compact.substr(i, 2), 16));
    } else if (mode === 'base64') {
      var bin;
      try { bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary'); }
      catch (e) { throw new Error('Not valid base64.'); }
      for (var j = 0; j < bin.length; j++) bytes.push(bin.charCodeAt(j) & 0xff);
    } else {
      // escaped text: \x1b \n \r \t \\ \0 \e € (as UTF-8, like most languages would send it)
      for (var k = 0; k < t.length; k++) {
        var c = t[k];
        if (c === '\\' && k + 1 < t.length) {
          var n = t[k + 1];
          if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(t.substr(k + 2, 2))) { bytes.push(parseInt(t.substr(k + 2, 2), 16)); k += 3; continue; }
          if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(t.substr(k + 2, 4))) { pushUtf8(bytes, String.fromCharCode(parseInt(t.substr(k + 2, 4), 16))); k += 5; continue; }
          var map = { n: 10, r: 13, t: 9, '0': 0, e: 27, '\\': 92, '"': 34, "'": 39 };
          if (map[n] !== undefined) { bytes.push(map[n]); k++; continue; }
        }
        pushUtf8(bytes, c);
      }
    }
    return { bytes: bytes, mode: mode };
  }
  function pushUtf8(bytes, s) {
    var enc = unescape(encodeURIComponent(s));
    for (var i = 0; i < enc.length; i++) bytes.push(enc.charCodeAt(i));
  }

  // ---------- interpreter ----------
  function interpret(input, options) {
    var o = options || {};
    var bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
    var AREA = o.dots || 576;
    var DEFAULT_PAGE = o.codepage == null ? 0 : o.codepage;
    var ops = [], log = [], warnings = [], warnedKeys = {};
    var y = 0, line = [], lineAlign = null, x = 0;
    var st, textRun = null;
    var qr = { size: 3, ec: 1, data: null, other: null };
    var graphics = null, utf8Seen = 0, utf8Example = null;
    var counts = { commands: 0, textBytes: 0, unknown: 0 };

    function reset() {
      st = { font: 'A', bold: false, dstrike: false, underline: 0, invert: false, sw: 1, sh: 1, align: 0,
        spacing: 30, leftMargin: 0, areaWidth: AREA, rightSpacing: 0, page: DEFAULT_PAGE, upside: false, rotate: false,
        tabs: [8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 248, 256],
        kanji: false, hriPos: 0, hriFont: 'A', bcHeight: 162, bcWidth: 3, charset: 0 };
    }
    reset();

    function warn(off, msg, key) {
      if (key) { if (warnedKeys[key]) { warnedKeys[key].count++; return; } }
      var w = { offset: off, message: msg, count: 1 };
      warnings.push(w);
      if (key) warnedKeys[key] = w;
    }
    function addLog(off, len, name, detail) {
      endTextRun();
      counts.commands++;
      if (log.length < 4000) log.push({ offset: off, bytes: hex(bytes.subarray(off, off + len)), name: name, detail: detail || '' });
    }
    function endTextRun() {
      if (!textRun) return;
      if (log.length < 4000) log.push({ offset: textRun.off, bytes: hex(bytes.subarray(textRun.off, textRun.off + textRun.len)), name: 'Text', detail: '"' + textRun.text + '"' });
      textRun = null;
    }
    function area() { return Math.max(1, Math.min(st.areaWidth, AREA - st.leftMargin)); }
    function cell() { var f = FONTS[st.font]; return { w: (f.w + st.rightSpacing) * st.sw, h: f.h * st.sh, fw: f.w * st.sw }; }

    // --- line buffer ---
    function printLine(feed) { // feed: dots to advance after the line, or null for the normal line feed
      var h = 0, wmax = 0;
      line.forEach(function (it) { h = Math.max(h, it.h); wmax = Math.max(wmax, it.x + it.w); });
      var al = lineAlign == null ? st.align : lineAlign, off = 0, a = area();
      if (al === 1) off = Math.floor((a - wmax) / 2); else if (al === 2) off = a - wmax;
      off = Math.max(0, off) + st.leftMargin;
      line.forEach(function (it) {
        var top = y + (h - it.h);
        if (it.kind === 'char') ops.push({ t: 'char', x: off + it.x, y: top, w: it.w, h: it.h, ch: it.ch, font: it.font, bold: it.bold, underline: it.underline, invert: it.invert, sw: it.sw, sh: it.sh, cjk: it.cjk });
        else ops.push({ t: 'bitmap', x: off + it.x, y: top, w: it.w, h: it.h, rows: it.rows });
      });
      var adv = feed == null ? Math.max(st.spacing, h) : (line.length ? Math.max(feed, h) : feed);
      y += adv;
      line = []; lineAlign = null; x = 0;
    }
    function lineHasData() { return line.length > 0; }
    function addItem(it, off) {
      if (x + it.w > area() && line.length) {
        warn(off, 'A line is wider than the print area (' + area() + ' dots), so the printer wraps it onto the next line.', 'wrap');
        printLine(null);
      }
      if (!line.length) lineAlign = st.align;
      it.x = x; line.push(it); x += it.w;
    }
    function decodeChar(b) {
      if (b < 0x80) return String.fromCharCode(b);
      var p = g.ESCPOS_CODEPAGES[String(st.page)];
      if (!p || !p.hi) return null;
      return p.hi[b - 0x80];
    }
    function addChar(b, off) {
      var c = cell(), ch = decodeChar(b);
      if (ch === null) { warn(off, 'Code page ' + st.page + ' (' + pageName(st.page) + ') is not modelled here, so bytes 0x80-0xFF show as ?.', 'page' + st.page); ch = '?'; }
      addItem({ kind: 'char', w: c.w, h: c.h, ch: ch, font: st.font, bold: st.bold || st.dstrike, underline: st.underline, invert: st.invert, sw: st.sw, sh: st.sh }, off);
      if (!textRun) textRun = { off: off, len: 0, text: '' };
      textRun.len++; textRun.text += ch;
      counts.textBytes++;
    }
    function pageName(n) { var p = g.ESCPOS_CODEPAGES[String(n)]; return p ? p.name : 'unknown'; }

    // immediate blocks (raster images, barcodes, QR): printed at the start of a line
    function immediate(off, what) {
      if (lineHasData()) {
        warn(off, what + ' arrived while text was waiting on the same line. Epson prints it only at the start of a line; here the text is printed first.', 'midline');
        printLine(null);
      }
    }
    function placeBlock(w, h, draw) { // draw(x0) pushes ops at y
      var a = area(), off = 0;
      if (st.align === 1) off = Math.floor((a - w) / 2); else if (st.align === 2) off = a - w;
      draw(Math.max(0, off) + st.leftMargin);
      y += h;
    }
    function rowsFromRaster(data, start, wBytes, h, sx, sy) { // returns array of rows (Uint8Array of 0/1)
      var rows = [], W = wBytes * 8 * sx;
      for (var r = 0; r < h; r++) {
        var row = new Uint8Array(W);
        for (var bx = 0; bx < wBytes; bx++) {
          var v = data[start + r * wBytes + bx] || 0;
          for (var bit = 0; bit < 8; bit++) if (v & (0x80 >> bit)) for (var k = 0; k < sx; k++) row[(bx * 8 + bit) * sx + k] = 1;
        }
        for (var s = 0; s < sy; s++) rows.push(row);
      }
      return rows;
    }
    function drawRaster(off, rows, w, h, label) {
      immediate(off, label);
      if (w > area()) warn(off, label + ' is ' + w + ' dots wide but the print area is ' + area() + ' dots. The right part is cut off (some printers print nothing).', 'wide' + off);
      placeBlock(Math.min(w, area()), h, function (x0) { ops.push({ t: 'bitmap', x: x0, y: y, w: w, h: h, rows: rows, clip: area() + st.leftMargin }); });
    }

    function drawBarcode(off, m, data) {
      immediate(off, 'Barcode');
      var r = g.BARCODE.encode(m, Array.prototype.slice.call(data));
      var name = g.BARCODE.names[m] || ('type ' + m);
      if (r.error) { warn(off, 'Barcode not printed: ' + r.error); return name + ': ' + r.error; }
      (r.warnings || []).forEach(function (w) { warn(off, w); });
      var hri = st.hriPos, hf = FONTS[st.hriFont], hriH = hf.h + 2;
      if (r.unsupported) {
        warn(off, name + ' barcodes are not drawn by this viewer yet; a placeholder is shown.', 'bc' + name);
        placeBlock(Math.min(area(), 300), st.bcHeight, function (x0) { ops.push({ t: 'note', x: x0, y: y, w: Math.min(area(), 300), h: st.bcHeight, text: name + ' barcode: ' + r.hri }); });
        return name + ' "' + r.hri + '" (not drawn)';
      }
      var w = 0, mod = st.bcWidth;
      r.runs.forEach(function (u) { w += Math.round(u * mod); });
      if (w > area()) { warn(off, name + ' barcode is ' + w + ' dots wide, more than the print area (' + area() + '). Printers skip it. Use a smaller GS w module width.'); return name + ' too wide'; }
      var total = st.bcHeight + ((hri & 1) ? hriH : 0) + ((hri & 2) ? hriH : 0);
      placeBlock(w, total, function (x0) {
        var top = y + ((hri & 1) ? hriH : 0), xx = x0;
        var hriText = function (yy) {
          var cw = hf.w, tw = r.hri.length * cw, tx = x0 + Math.floor((w - tw) / 2);
          for (var i = 0; i < r.hri.length; i++) ops.push({ t: 'char', x: tx + i * cw, y: yy, w: cw, h: hf.h, ch: r.hri[i], font: st.hriFont, sw: 1, sh: 1, hri: true });
        };
        if (hri & 1) hriText(y);
        r.runs.forEach(function (u, i) {
          var bw = Math.round(u * mod);
          if (i % 2 === 0) ops.push({ t: 'rect', x: xx, y: top, w: bw, h: st.bcHeight });
          xx += bw;
        });
        if (hri & 2) hriText(top + st.bcHeight + 2);
      });
      return name + ' "' + r.hri + '", ' + w + ' dots wide, ' + st.bcHeight + ' high';
    }

    function drawQR(off) {
      immediate(off, 'QR code');
      if (!qr.data) { warn(off, 'QR print command without stored data (GS ( k fn 80 missing). Nothing printed.'); return 'nothing stored'; }
      var res;
      try { res = g.QR.encode(qr.data, qr.ec); } catch (e) { warn(off, 'QR not printed: ' + e.message); return e.message; }
      var px = qr.size, w = res.size * px;
      if (w > area()) { warn(off, 'QR code is ' + w + ' dots wide, more than the print area. Printers skip it; use a smaller module size.'); return 'too wide'; }
      placeBlock(w, w, function (x0) {
        var rows = [];
        for (var yy = 0; yy < res.size; yy++) {
          var row = new Uint8Array(w);
          for (var xx = 0; xx < res.size; xx++) if (res.modules[yy][xx]) for (var k = 0; k < px; k++) row[xx * px + k] = 1;
          for (var s = 0; s < px; s++) rows.push(row);
        }
        ops.push({ t: 'bitmap', x: x0, y: y, w: w, h: w, rows: rows });
      });
      return 'version ' + res.version + ', ' + res.size + '×' + res.size + ' modules, ' + w + ' dots, error correction ' + 'LMQH'[qr.ec] + ', ' + qr.data.length + ' bytes';
    }

    function cut(off, partial, feed) {
      if (lineHasData()) printLine(null);
      if (feed) y += feed;
      ops.push({ t: 'cut', y: y, partial: partial });
      y += 12;
    }

    var i = 0, n = bytes.length;
    function need(k, off, name) {
      if (off + k > n) { warn(off, name + ' is cut short: the data ends before its parameters.'); return false; }
      return true;
    }

    while (i < n) {
      var b = bytes[i], off = i;
      if (b >= 0x20 && b !== 0x7f) {
        // UTF-8 heuristic: lead byte followed by the right number of continuation bytes
        if (!st.kanji && b >= 0xc2 && b <= 0xf4) {
          var need2 = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : 1, okSeq = i + need2 < n;
          for (var q = 1; okSeq && q <= need2; q++) if ((bytes[i + q] & 0xc0) !== 0x80) okSeq = false;
          if (okSeq) {
            utf8Seen++;
            if (!utf8Example) {
              var seq = Array.prototype.slice.call(bytes.subarray(i, i + need2 + 1));
              var asText = '';
              try { asText = decodeURIComponent(seq.map(function (v) { return '%' + v.toString(16); }).join('')); } catch (e) { asText = '?'; }
              utf8Example = { offset: i, bytes: hex(seq), intended: asText, printed: seq.map(function (v) { return decodeChar(v) || '?'; }).join('') };
            }
          }
        }
        if (st.kanji && b >= 0x81 && i + 1 < n) { // double-byte mode: the next byte is always the second half
          var pair = bytes.subarray(i, i + 2), ch = '□';
          if (bytes[i + 1] >= 0x40 && bytes[i + 1] !== 0x7f && bytes[i + 1] !== 0xff) {
            try { if (typeof TextDecoder !== 'undefined') ch = new TextDecoder('gb18030').decode(pair); } catch (e) { /* keep box */ }
            if (ch.length !== 1 || ch === '�') ch = '□';
          }
          var c2 = cell();
          addItem({ kind: 'char', w: 24 * st.sw, h: 24 * st.sh, ch: ch, font: 'A', bold: st.bold, underline: st.underline, invert: st.invert, sw: st.sw, sh: st.sh, cjk: true }, off);
          if (!textRun) textRun = { off: off, len: 0, text: '' };
          textRun.len += 2; textRun.text += ch; counts.textBytes += 2;
          i += 2; continue;
        }
        addChar(b, off); i++; continue;
      }
      switch (b) {
        case 0x0a: endTextRun(); printLine(null); counts.commands++; i++; continue;
        case 0x0d: i++; continue; // CR: ignored by Epson when auto line feed is off
        case 0x09: { // HT
          var cw = cell().w, col = Math.floor(x / cw) + 1, next = null;
          for (var t = 0; t < st.tabs.length; t++) if (st.tabs[t] >= col) { next = st.tabs[t]; break; }
          if (next !== null && next * cw <= area()) x = next * cw; else printLine(null);
          i++; continue;
        }
        case 0x0c: addLog(off, 1, 'FF', 'Form feed: in standard mode most printers ignore it'); i++; continue;
        case 0x00: i++; continue;
        case 0x18: addLog(off, 1, 'CAN', 'Cancel (page mode only)'); i++; continue;
        case 0x7f: i++; continue;
      }
      if (b === ESC && i + 1 < n) {
        var c = bytes[i + 1], a1 = bytes[i + 2], a2 = bytes[i + 3];
        switch (c) {
          case 0x40: // ESC @
            if (lineHasData()) warn(off, 'ESC @ (initialize) arrived with unprinted text in the line buffer. The printer throws that text away.');
            line = []; lineAlign = null; x = 0; reset();
            addLog(off, 2, 'ESC @', 'Initialize printer: styles, alignment, code page and margins reset'); i += 2; continue;
          case 0x21: if (!need(3, off, 'ESC !')) { i = n; continue; }
            st.font = (a1 & 1) ? 'B' : 'A'; st.bold = !!(a1 & 8); st.sh = (a1 & 16) ? 2 : 1; st.sw = (a1 & 32) ? 2 : 1; st.underline = (a1 & 128) ? 1 : 0;
            addLog(off, 3, 'ESC !', 'Print mode: font ' + st.font + (st.bold ? ', bold' : '') + (st.sh > 1 ? ', double height' : '') + (st.sw > 1 ? ', double width' : '') + (st.underline ? ', underline' : ''));
            i += 3; continue;
          case 0x45: if (!need(3, off, 'ESC E')) { i = n; continue; } st.bold = !!(a1 & 1); addLog(off, 3, 'ESC E', 'Bold ' + (st.bold ? 'on' : 'off')); i += 3; continue;
          case 0x47: if (!need(3, off, 'ESC G')) { i = n; continue; } st.dstrike = !!(a1 & 1); addLog(off, 3, 'ESC G', 'Double-strike ' + (st.dstrike ? 'on' : 'off')); i += 3; continue;
          case 0x2d: if (!need(3, off, 'ESC -')) { i = n; continue; } st.underline = (a1 === 1 || a1 === 49) ? 1 : (a1 === 2 || a1 === 50) ? 2 : 0; addLog(off, 3, 'ESC -', 'Underline ' + (st.underline ? st.underline + ' dot' : 'off')); i += 3; continue;
          case 0x4d: if (!need(3, off, 'ESC M')) { i = n; continue; } st.font = (a1 === 1 || a1 === 49) ? 'B' : 'A'; if (a1 === 2 || a1 === 50) warn(off, 'Font C is printer-specific; shown as font A.', 'fontc'); addLog(off, 3, 'ESC M', 'Font ' + st.font); i += 3; continue;
          case 0x61: if (!need(3, off, 'ESC a')) { i = n; continue; } st.align = (a1 === 1 || a1 === 49) ? 1 : (a1 === 2 || a1 === 50) ? 2 : 0; if (lineHasData()) warn(off, 'ESC a (alignment) in the middle of a line only takes effect on the next line.', 'alignmid'); addLog(off, 3, 'ESC a', 'Align ' + ['left', 'center', 'right'][st.align]); i += 3; continue;
          case 0x32: st.spacing = 30; addLog(off, 2, 'ESC 2', 'Default line spacing'); i += 2; continue;
          case 0x33: if (!need(3, off, 'ESC 3')) { i = n; continue; } st.spacing = a1; addLog(off, 3, 'ESC 3', 'Line spacing ' + a1 + ' dots'); i += 3; continue;
          case 0x64: if (!need(3, off, 'ESC d')) { i = n; continue; } endTextRun();
            if (a1 === 0) { if (lineHasData()) printLine(0); } else { printLine(null); y += (a1 - 1) * st.spacing; }
            addLog(off, 3, 'ESC d', 'Print and feed ' + a1 + ' line' + (a1 === 1 ? '' : 's')); i += 3; continue;
          case 0x4a: if (!need(3, off, 'ESC J')) { i = n; continue; } endTextRun(); printLine(a1); addLog(off, 3, 'ESC J', 'Print and feed ' + a1 + ' dots'); i += 3; continue;
          case 0x65: if (!need(3, off, 'ESC e')) { i = n; continue; } addLog(off, 3, 'ESC e', 'Reverse feed ' + a1 + ' lines (not shown)'); i += 3; continue;
          case 0x20: if (!need(3, off, 'ESC SP')) { i = n; continue; } st.rightSpacing = a1; addLog(off, 3, 'ESC SP', 'Character right spacing ' + a1 + ' dots'); i += 3; continue;
          case 0x74: if (!need(3, off, 'ESC t')) { i = n; continue; } st.page = a1; addLog(off, 3, 'ESC t', 'Code page ' + a1 + ': ' + pageName(a1) + ' (Epson numbering)'); i += 3; continue;
          case 0x52: if (!need(3, off, 'ESC R')) { i = n; continue; } st.charset = a1; if (a1) warn(off, 'ESC R ' + a1 + ' selects an international character set that swaps a few ASCII symbols (#, $, @, [, \\ ...). The swap is not shown here.', 'escR'); addLog(off, 3, 'ESC R', 'International character set ' + a1); i += 3; continue;
          case 0x7b: if (!need(3, off, 'ESC {')) { i = n; continue; } st.upside = !!(a1 & 1); if (st.upside) warn(off, 'Upside-down printing (ESC {) is on; the preview shows it the right way up.', 'upside'); addLog(off, 3, 'ESC {', 'Upside-down ' + (st.upside ? 'on' : 'off')); i += 3; continue;
          case 0x56: if (!need(3, off, 'ESC V')) { i = n; continue; } st.rotate = !!(a1 & 3); if (st.rotate) warn(off, '90° rotation (ESC V) is on; the preview does not rotate characters.', 'rot'); addLog(off, 3, 'ESC V', '90° rotation ' + (st.rotate ? 'on' : 'off')); i += 3; continue;
          case 0x24: if (!need(4, off, 'ESC $')) { i = n; continue; } x = Math.min(a1 + a2 * 256, area()); addLog(off, 4, 'ESC $', 'Absolute position ' + (a1 + a2 * 256) + ' dots'); i += 4; continue;
          case 0x5c: if (!need(4, off, 'ESC \\')) { i = n; continue; } { var rel = a1 + a2 * 256; if (rel > 32767) rel -= 65536; x = Math.max(0, Math.min(x + rel, area())); addLog(off, 4, 'ESC \\', 'Relative position ' + rel + ' dots'); } i += 4; continue;
          case 0x44: { var j = i + 2, tabs = []; while (j < n && bytes[j] !== 0 && tabs.length < 32) { tabs.push(bytes[j]); j++; }
            st.tabs = tabs; addLog(off, j - i + 1, 'ESC D', 'Tab stops at columns ' + (tabs.join(', ') || '(none)')); i = j + 1; continue; }
          case 0x70: if (!need(5, off, 'ESC p')) { i = n; continue; } endTextRun();
            ops.push({ t: 'event', y: y, text: 'Cash drawer kick (pin ' + ((a1 & 1) ? 5 : 2) + ')' });
            addLog(off, 5, 'ESC p', 'Open cash drawer: pin ' + ((a1 & 1) ? 5 : 2) + ', pulse ' + a2 * 2 + ' ms on, ' + bytes[i + 4] * 2 + ' ms off'); i += 5; continue;
          case 0x69: cut(off, true, 0); addLog(off, 2, 'ESC i', 'Partial cut (older command)'); i += 2; continue;
          case 0x6d: cut(off, true, 0); addLog(off, 2, 'ESC m', 'Partial cut (older command)'); i += 2; continue;
          case 0x2a: { // ESC * m nL nH data
            if (!need(5, off, 'ESC *')) { i = n; continue; }
            var m = a1, cols = a2 + bytes[i + 4] * 256, dots24 = (m === 32 || m === 33), per = dots24 ? 3 : 1;
            var len = cols * per, sx = (m === 0 || m === 32) ? 2 : 1, sy = dots24 ? 1 : 3;
            if (!need(5 + len, off, 'ESC * image')) { i = n; continue; }
            var hgt = (dots24 ? 24 : 8) * sy, rows = [];
            for (var rr = 0; rr < hgt; rr++) rows.push(new Uint8Array(cols * sx));
            for (var cc = 0; cc < cols; cc++) for (var k2 = 0; k2 < per; k2++) {
              var v = bytes[i + 5 + cc * per + k2];
              for (var bit = 0; bit < 8; bit++) if (v & (0x80 >> bit)) {
                var yy = (k2 * 8 + bit) * sy;
                for (var s1 = 0; s1 < sy; s1++) for (var s2 = 0; s2 < sx; s2++) rows[yy + s1][cc * sx + s2] = 1;
              }
            }
            addItem({ kind: 'bitmap', w: cols * sx, h: hgt, rows: rows }, off);
            if (!dots24) warn(off, 'ESC * 8-dot mode: dot height differs between printer models; shown at 3 dots per bit (Epson 180 dpi).', 'esc8');
            addLog(off, 5 + len, 'ESC *', 'Bit image, ' + (dots24 ? '24' : '8') + '-dot, ' + cols + ' columns' + (sx > 1 ? ' (single density, doubled)' : ''));
            i += 5 + len; continue;
          }
          case 0x26: { // ESC & y c1 c2 [x data]... user-defined characters
            if (!need(5, off, 'ESC &')) { i = n; continue; }
            var yb = a1, c1 = a2, c2b = bytes[i + 4], j2 = i + 5;
            for (var chn = c1; chn <= c2b && j2 < n; chn++) { var xw = bytes[j2]; j2 += 1 + yb * xw; }
            warn(off, 'User-defined characters (ESC &) are not drawn; standard glyphs are shown instead.', 'udc');
            addLog(off, j2 - i, 'ESC &', 'Define user characters ' + c1 + '-' + c2b); i = j2; continue;
          }
          case 0x25: case 0x3d: case 0x3f: case 0x55: case 0x72: case 0x63:
            if (c === 0x63) { if (!need(4, off, 'ESC c')) { i = n; continue; } addLog(off, 4, 'ESC c ' + String.fromCharCode(a1), 'Paper sensor / panel button setting'); i += 4; continue; }
            if (!need(3, off, 'ESC ' + String.fromCharCode(c))) { i = n; continue; }
            addLog(off, 3, 'ESC ' + String.fromCharCode(c), { 0x25: 'User-defined character set on/off', 0x3d: 'Select peripheral device', 0x3f: 'Cancel user-defined character', 0x55: 'Unidirectional printing', 0x72: 'Select print color' }[c]);
            i += 3; continue;
          case 0x4c: warn(off, 'Page mode (ESC L) is not supported by this viewer; output after it may look wrong.', 'page'); addLog(off, 2, 'ESC L', 'Select page mode'); i += 2; continue;
          case 0x53: addLog(off, 2, 'ESC S', 'Select standard mode'); i += 2; continue;
          case 0x54: addLog(off, 3, 'ESC T', 'Page mode print direction'); i += 3; continue;
          case 0x57: addLog(off, 10, 'ESC W', 'Page mode print area'); i += 10; continue;
        }
        counts.unknown++;
        warn(off, 'Unknown command ESC 0x' + c.toString(16).toUpperCase() + ' (' + (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '?') + '). Its parameters may be shown as text.', 'unk1b' + c);
        addLog(off, 2, 'ESC ?', 'Unknown'); i += 2; continue;
      }
      if (b === GS && i + 1 < n) {
        var c3 = bytes[i + 1], p1 = bytes[i + 2], p2 = bytes[i + 3];
        switch (c3) {
          case 0x21: if (!need(3, off, 'GS !')) { i = n; continue; } st.sw = ((p1 >> 4) & 7) + 1; st.sh = (p1 & 7) + 1; addLog(off, 3, 'GS !', 'Character size ' + st.sw + '× wide, ' + st.sh + '× high'); i += 3; continue;
          case 0x42: if (!need(3, off, 'GS B')) { i = n; continue; } st.invert = !!(p1 & 1); addLog(off, 3, 'GS B', 'White on black ' + (st.invert ? 'on' : 'off')); i += 3; continue;
          case 0x4c: if (!need(4, off, 'GS L')) { i = n; continue; } st.leftMargin = Math.min(p1 + p2 * 256, AREA - 1); addLog(off, 4, 'GS L', 'Left margin ' + st.leftMargin + ' dots'); i += 4; continue;
          case 0x57: if (!need(4, off, 'GS W')) { i = n; continue; } st.areaWidth = p1 + p2 * 256 || AREA; addLog(off, 4, 'GS W', 'Print area width ' + st.areaWidth + ' dots'); i += 4; continue;
          case 0x50: if (!need(4, off, 'GS P')) { i = n; continue; } addLog(off, 4, 'GS P', 'Motion units (ignored here: 1 unit = 1 dot)'); i += 4; continue;
          case 0x48: if (!need(3, off, 'GS H')) { i = n; continue; } st.hriPos = p1 >= 48 ? p1 - 48 : p1; addLog(off, 3, 'GS H', 'Barcode text: ' + ['none', 'above', 'below', 'above and below'][st.hriPos & 3]); i += 3; continue;
          case 0x66: if (!need(3, off, 'GS f')) { i = n; continue; } st.hriFont = (p1 === 1 || p1 === 49) ? 'B' : 'A'; addLog(off, 3, 'GS f', 'Barcode text font ' + st.hriFont); i += 3; continue;
          case 0x68: if (!need(3, off, 'GS h')) { i = n; continue; } st.bcHeight = p1 || 1; addLog(off, 3, 'GS h', 'Barcode height ' + st.bcHeight + ' dots'); i += 3; continue;
          case 0x77: if (!need(3, off, 'GS w')) { i = n; continue; } st.bcWidth = Math.max(1, Math.min(p1 >= 68 ? p1 - 66 : p1, 6)); addLog(off, 3, 'GS w', 'Barcode module width ' + p1); i += 3; continue;
          case 0x6b: { // GS k
            if (!need(3, off, 'GS k')) { i = n; continue; }
            var mm = p1, data, used;
            if (mm <= 6) { var e = i + 3; while (e < n && bytes[e] !== 0) e++; data = bytes.subarray(i + 3, e); used = e - i + 1; }
            else { if (!need(4, off, 'GS k')) { i = n; continue; } data = bytes.subarray(i + 4, i + 4 + p2); used = 4 + p2; if (i + used > n) { warn(off, 'GS k barcode data is cut short.'); i = n; continue; } }
            endTextRun();
            var detail = drawBarcode(off, mm, data);
            addLog(off, used, 'GS k', 'Barcode ' + detail); i += used; continue;
          }
          case 0x56: { // GS V
            if (!need(3, off, 'GS V')) { i = n; continue; }
            var mv = p1, full = (mv === 0 || mv === 48 || mv === 65 || mv === 97 || mv === 103), feed = 0, ln = 3;
            if (mv === 65 || mv === 66 || mv === 97 || mv === 98 || mv === 103 || mv === 104) { if (!need(4, off, 'GS V')) { i = n; continue; } feed = p2; ln = 4; }
            endTextRun(); cut(off, !full, feed);
            addLog(off, ln, 'GS V', (full ? 'Full' : 'Partial') + ' cut' + (feed ? ' after feeding ' + feed + ' dots' : '')); i += ln; continue;
          }
          case 0x76: { // GS v 0
            if (!need(8, off, 'GS v 0')) { i = n; continue; }
            var mode = bytes[i + 3] >= 48 ? bytes[i + 3] - 48 : bytes[i + 3];
            var xb = bytes[i + 4] + bytes[i + 5] * 256, yh = bytes[i + 6] + bytes[i + 7] * 256, ln2 = 8 + xb * yh;
            if (i + ln2 > n) { warn(off, 'GS v 0 image data is cut short: needs ' + xb * yh + ' bytes, only ' + (n - i - 8) + ' present.'); ln2 = n - i; }
            endTextRun();
            var sxv = (mode & 1) ? 2 : 1, syv = (mode & 2) ? 2 : 1;
            var rowsv = rowsFromRaster(bytes, i + 8, xb, yh, sxv, syv);
            drawRaster(off, rowsv, xb * 8 * sxv, yh * syv, 'Raster image');
            addLog(off, ln2, 'GS v 0', 'Raster image ' + xb * 8 + '×' + yh + ' dots' + (mode ? ' (scaled ' + sxv + '×' + syv + ')' : ''));
            i += ln2; continue;
          }
          case 0x28: { // GS ( X pL pH ...
            if (!need(5, off, 'GS (')) { i = n; continue; }
            var fnc = p1, plen = bytes[i + 3] + bytes[i + 4] * 256, body = bytes.subarray(i + 5, i + 5 + plen), tot = 5 + plen;
            if (i + tot > n) { warn(off, 'GS ( ' + String.fromCharCode(fnc) + ' is cut short.'); i = n; continue; }
            endTextRun();
            if (fnc === 0x6b) { // GS ( k
              var cn = body[0], fn = body[1];
              if (cn === 49) {
                if (fn === 65) addLog(off, tot, 'GS ( k', 'QR: model ' + (body[2] - 48));
                else if (fn === 67) { qr.size = Math.max(1, Math.min(body[2], 16)); addLog(off, tot, 'GS ( k', 'QR: module size ' + qr.size + ' dots'); }
                else if (fn === 69) { qr.ec = Math.max(0, Math.min(body[2] - 48, 3)); addLog(off, tot, 'GS ( k', 'QR: error correction ' + 'LMQH'[qr.ec]); }
                else if (fn === 80) { qr.data = Array.prototype.slice.call(body.subarray(3)); addLog(off, tot, 'GS ( k', 'QR: store ' + qr.data.length + ' bytes'); }
                else if (fn === 81) { addLog(off, tot, 'GS ( k', 'QR: print, ' + drawQR(off)); }
                else addLog(off, tot, 'GS ( k', 'QR function ' + fn);
              } else {
                var sym = { 48: 'PDF417', 50: 'MaxiCode', 51: 'GS1 DataBar', 52: 'Composite', 65: 'Aztec', 66: 'DataMatrix' }[cn] || ('symbol ' + cn);
                if (fn === 81) {
                  immediate(off, sym);
                  warn(off, sym + ' symbols are not drawn by this viewer yet; a placeholder is shown.', 'sym' + cn);
                  placeBlock(Math.min(area(), 240), 80, function (x0) { ops.push({ t: 'note', x: x0, y: y, w: Math.min(area(), 240), h: 80, text: sym + ' symbol' }); });
                }
                addLog(off, tot, 'GS ( k', sym + ' function ' + fn);
              }
            } else if (fnc === 0x4c) { graphicsCmd(off, body, tot, 'GS ( L'); }
            else addLog(off, tot, 'GS ( ' + String.fromCharCode(fnc), 'Extended command, ' + plen + ' parameter bytes');
            i += tot; continue;
          }
          case 0x38: { // GS 8 L p1 p2 p3 p4 m fn ...
            if (bytes[i + 2] !== 0x4c || !need(7, off, 'GS 8 L')) { addLog(off, 2, 'GS 8', 'Unknown'); i += 2; continue; }
            var len8 = bytes[i + 3] + bytes[i + 4] * 256 + bytes[i + 5] * 65536 + bytes[i + 6] * 16777216, tot8 = 7 + len8;
            if (i + tot8 > n) { warn(off, 'GS 8 L is cut short.'); i = n; continue; }
            endTextRun(); graphicsCmd(off, bytes.subarray(i + 7, i + tot8), tot8, 'GS 8 L'); i += tot8; continue;
          }
          case 0x2a: { if (!need(4, off, 'GS *')) { i = n; continue; } var l2 = 4 + p1 * p2 * 8; addLog(off, l2, 'GS *', 'Define downloaded image ' + p1 * 8 + '×' + p2 * 8); graphics = { dl: { wBytes: p1, hDots: p2 * 8, start: i + 4 } }; i += l2; continue; }
          case 0x2f: if (!need(3, off, 'GS /')) { i = n; continue; } endTextRun();
            immediate(off, 'Downloaded image'); placeBlock(200, 40, function (x0) { ops.push({ t: 'note', x: x0, y: y, w: 200, h: 40, text: 'Downloaded image (GS /)' }); });
            warn(off, 'GS / prints an image stored in printer RAM; shown as a placeholder.', 'gsslash');
            addLog(off, 3, 'GS /', 'Print downloaded image'); i += 3; continue;
          case 0x61: case 0x72: case 0x49: if (!need(3, off, 'GS')) { i = n; continue; }
            addLog(off, 3, 'GS ' + String.fromCharCode(c3), { 0x61: 'Automatic status back setting', 0x72: 'Status request (printer replies, nothing printed)', 0x49: 'Printer ID request (printer replies)' }[c3]); i += 3; continue;
          case 0x3a: addLog(off, 2, 'GS :', 'Start/end macro definition'); i += 2; continue;
          case 0x5e: addLog(off, 5, 'GS ^', 'Run macro (not run here)'); i += 5; continue;
        }
        counts.unknown++;
        warn(off, 'Unknown command GS 0x' + c3.toString(16).toUpperCase() + '. Its parameters may be shown as text.', 'unk1d' + c3);
        addLog(off, 2, 'GS ?', 'Unknown'); i += 2; continue;
      }
      if (b === FS && i + 1 < n) {
        var c4 = bytes[i + 1];
        if (c4 === 0x26) { st.kanji = true; warn(off, 'FS & turns on Kanji (double-byte) mode. Bytes 0x81 and up now print as Chinese/Japanese characters, two bytes per character. If you meant Latin text, send FS . to turn it off.', 'kanji'); addLog(off, 2, 'FS &', 'Kanji mode on'); i += 2; continue; }
        if (c4 === 0x2e) { st.kanji = false; addLog(off, 2, 'FS .', 'Kanji mode off'); i += 2; continue; }
        if (c4 === 0x70) { if (!need(4, off, 'FS p')) { i = n; continue; } endTextRun(); immediate(off, 'NV logo');
          placeBlock(Math.min(area(), 320), 60, function (x0) { ops.push({ t: 'note', x: x0, y: y, w: Math.min(area(), 320), h: 60, text: 'Logo #' + bytes[i + 2] + ' stored in the printer (FS p)' }); });
          warn(off, 'FS p prints a logo stored in the printer\'s memory. The viewer cannot see it, so a placeholder is shown.', 'fsp');
          addLog(off, 4, 'FS p', 'Print stored logo #' + bytes[i + 2]); i += 4; continue; }
        if (c4 === 0x71) { // FS q n [xL xH yL yH data]...
          var cnt = bytes[i + 2], j3 = i + 3;
          for (var im = 0; im < cnt && j3 + 4 <= n; im++) { var xw2 = bytes[j3] + bytes[j3 + 1] * 256, yh2 = bytes[j3 + 2] + bytes[j3 + 3] * 256; j3 += 4 + xw2 * yh2 * 8; }
          addLog(off, j3 - i, 'FS q', 'Store ' + cnt + ' logo(s) in printer memory'); i = j3; continue; }
        if (c4 === 0x21 || c4 === 0x2d || c4 === 0x43 || c4 === 0x53 || c4 === 0x57) {
          var l4 = c4 === 0x53 ? 4 : 3; addLog(off, l4, 'FS ' + String.fromCharCode(c4), 'Kanji setting'); i += l4; continue; }
        counts.unknown++;
        warn(off, 'Unknown command FS 0x' + c4.toString(16).toUpperCase() + '.', 'unk1c' + c4); addLog(off, 2, 'FS ?', 'Unknown'); i += 2; continue;
      }
      if (b === DLE && i + 1 < n) {
        var c5 = bytes[i + 1];
        if (c5 === 0x04 || c5 === 0x05) { addLog(off, 3, c5 === 4 ? 'DLE EOT' : 'DLE ENQ', 'Real-time status request (printer replies, nothing printed)'); i += 3; continue; }
        if (c5 === 0x14) {
          var f = bytes[i + 2], l5 = f === 1 ? 5 : f === 2 ? 5 : f === 8 ? 10 : 3;
          if (f === 1) ops.push({ t: 'event', y: y, text: 'Cash drawer kick (real-time, pin ' + ((bytes[i + 3] & 1) ? 5 : 2) + ')' });
          addLog(off, l5, 'DLE DC4', f === 1 ? 'Real-time drawer pulse' : f === 2 ? 'Power off sequence' : f === 8 ? 'Clear buffers' : 'Real-time function ' + f);
          i += l5; continue;
        }
        addLog(off, 2, 'DLE', 'Real-time command'); i += 2; continue;
      }
      // other control bytes (or ESC/GS at the very end)
      if (b === ESC || b === GS || b === FS || b === DLE) { warn(off, 'The data ends in the middle of a command.'); i = n; continue; }
      addLog(off, 1, 'Control 0x' + b.toString(16).toUpperCase(), 'Ignored');
      i++;
    }
    endTextRun();
    if (lineHasData()) {
      warn(n, 'The data ends with text still in the line buffer (no LF or print command after it). Most printers do not print it until more data arrives.');
      printLine(null);
    }
    if (utf8Seen) {
      warn(utf8Example.offset, 'This looks like UTF-8 text (' + utf8Seen + ' multi-byte character' + (utf8Seen > 1 ? 's' : '') + '). Receipt printers use single-byte code pages, so "' + utf8Example.intended + '" (' + utf8Example.bytes + ') prints as "' + utf8Example.printed + '". Encode text to the printer\'s code page, or print it as an image.');
    }

    function graphicsCmd(off2, body, tot, name) {
      var fn = body[1];
      if (fn === 112 || fn === 113) {
        var bx = body[3], by = body[4], xw = body[6] + body[7] * 256, yhh = body[8] + body[9] * 256;
        graphics = { wBytes: Math.ceil(xw / 8), w: xw, h: yhh, data: body.subarray(10), sx: bx, sy: by };
        if (fn === 113) warn(off2, name + ' column-format graphics are stored but not drawn.', 'gcol');
        addLog(off2, tot, name, 'Store graphics ' + xw + '×' + yhh + ' dots');
      } else if (fn === 50 || fn === 2) {
        if (!graphics || !graphics.data) { warn(off2, name + ' print graphics without stored data.'); addLog(off2, tot, name, 'Print graphics (nothing stored)'); return; }
        var rows = rowsFromRaster(graphics.data, 0, graphics.wBytes, graphics.h, graphics.sx === 2 ? 2 : 1, graphics.sy === 2 ? 2 : 1);
        drawRaster(off2, rows, graphics.wBytes * 8 * (graphics.sx === 2 ? 2 : 1), graphics.h * (graphics.sy === 2 ? 2 : 1), 'Graphics');
        addLog(off2, tot, name, 'Print stored graphics');
      } else if (fn === 69 || fn === 85) {
        immediate(off2, 'NV graphics');
        placeBlock(Math.min(area(), 320), 60, function (x0) { ops.push({ t: 'note', x: x0, y: y, w: Math.min(area(), 320), h: 60, text: 'Logo stored in the printer (' + name + ' fn ' + fn + ')' }); });
        warn(off2, 'This prints a logo stored in the printer (NV graphics); shown as a placeholder.', 'nvg');
        addLog(off2, tot, name, 'Print NV graphics');
      } else addLog(off2, tot, name, 'Graphics function ' + fn);
    }

    return { ops: ops, height: y, width: AREA, log: log, warnings: warnings, counts: counts, bytes: n };
  }

  // Groups printed characters into text lines (used by tests and the "copy text" button).
  function textLines(result, cellW) {
    var rows = {};
    result.ops.forEach(function (op) {
      if (op.t !== 'char' || op.hri) return;
      var key = op.y + op.h; // bottom edge = baseline row
      (rows[key] = rows[key] || []).push(op);
    });
    return Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).map(function (k) {
      var ops = rows[k].sort(function (a, b) { return a.x - b.x; }), s = '';
      ops.forEach(function (op) {
        var w = (cellW || 12) * (op.sw || 1), col = Math.floor(op.x / w + 1e-9);
        while (s.length < col) s += ' ';
        s += op.ch;
      });
      return s;
    });
  }

  g.ESCPOS = { decodeInput: decodeInput, interpret: interpret, textLines: textLines, FONTS: FONTS, hex: hex };
})(typeof globalThis !== 'undefined' ? globalThis : this);
