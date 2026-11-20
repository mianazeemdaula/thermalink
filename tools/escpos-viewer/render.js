// Paints an ESCPOS.interpret() result onto a canvas. 1 printer dot = 1 canvas pixel.
(function (g) {
  'use strict';
  var FAMILY = 'ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';
  var TOP = 16, BOTTOM = 28;

  function paint(result, canvas, opt) {
    var paper = opt.paperDots, areaW = result.width, margin = Math.max(0, Math.floor((paper - areaW) / 2));
    canvas.width = paper;
    canvas.height = Math.max(80, result.height + TOP + BOTTOM);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (opt.showArea) {
      ctx.strokeStyle = 'rgba(15,118,110,.35)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(margin - 0.5, 0); ctx.lineTo(margin - 0.5, canvas.height);
      ctx.moveTo(margin + areaW + 0.5, 0); ctx.lineTo(margin + areaW + 0.5, canvas.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    var advCache = {};
    function advance(font) {
      if (!advCache[font]) { ctx.font = font; advCache[font] = ctx.measureText('M').width || 1; }
      return advCache[font];
    }
    result.ops.forEach(function (op) {
      var x = margin + (op.x || 0), y = TOP + op.y;
      if (op.t === 'char') {
        var base = g.ESCPOS.FONTS[op.font || 'A'], sw = op.sw || 1, sh = op.sh || 1;
        var ch = op.cjk ? 24 * sh : base.h * sh;
        if (op.invert) { ctx.fillStyle = '#000'; ctx.fillRect(x, y, op.w, op.h); }
        var px = op.cjk ? 22 : Math.round(base.h * 0.86);
        var font = (op.bold ? 'bold ' : '') + px + 'px ' + FAMILY;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(op.cjk ? sw : (base.w * sw) / advance(font), sh);
        ctx.font = font;
        ctx.fillStyle = op.invert ? '#fff' : '#000';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(op.ch, 0, Math.round((op.cjk ? 24 : base.h) * 0.78));
        ctx.restore();
        if (op.underline) { ctx.fillStyle = op.invert ? '#fff' : '#000'; ctx.fillRect(x, y + ch - op.underline, op.w, op.underline); }
      } else if (op.t === 'bitmap') {
        ctx.fillStyle = '#000';
        var maxX = op.clip != null ? margin + op.clip : canvas.width;
        for (var r = 0; r < op.rows.length; r++) {
          var row = op.rows[r], start = -1;
          for (var c = 0; c <= row.length; c++) {
            if (c < row.length && row[c]) { if (start < 0) start = c; continue; }
            if (start >= 0) {
              var x0 = x + start, x1 = Math.min(x + c, maxX);
              if (x1 > x0) ctx.fillRect(x0, y + r, x1 - x0, 1);
              start = -1;
            }
          }
        }
      } else if (op.t === 'rect') {
        ctx.fillStyle = '#000'; ctx.fillRect(x, y, op.w, op.h);
      } else if (op.t === 'note') {
        ctx.strokeStyle = '#94a3b8'; ctx.setLineDash([5, 4]); ctx.strokeRect(x + 0.5, y + 0.5, op.w - 1, op.h - 1); ctx.setLineDash([]);
        ctx.fillStyle = '#64748b'; ctx.font = 'italic 15px system-ui, sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillText(op.text, x + 8, y + op.h / 2, op.w - 16);
      } else if (op.t === 'cut') {
        ctx.strokeStyle = '#ef4444'; ctx.setLineDash(op.partial ? [10, 6] : [2, 0]); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, y + 6); ctx.lineTo(canvas.width, y + 6); ctx.stroke();
        ctx.setLineDash([]); ctx.lineWidth = 1;
        ctx.fillStyle = '#ef4444'; ctx.font = '13px system-ui, sans-serif'; ctx.textBaseline = 'bottom';
        var label = '✂ ' + (op.partial ? 'partial cut' : 'full cut');
        ctx.fillText(label, canvas.width - ctx.measureText(label).width - 6, y + 4);
      } else if (op.t === 'event') {
        ctx.fillStyle = '#7c3aed'; ctx.font = '13px system-ui, sans-serif'; ctx.textBaseline = 'top';
        var t = '⚡ ' + op.text;
        ctx.fillText(t, canvas.width - ctx.measureText(t).width - 6, y + 2);
      }
    });
    return { margin: margin, top: TOP };
  }
  g.ESCPOS_RENDER = { paint: paint };
})(typeof globalThis !== 'undefined' ? globalThis : this);
