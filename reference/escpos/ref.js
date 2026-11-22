// Live previews on the ESC/POS command reference pages. Uses the ESC/POS viewer's engine; nothing leaves the page.
(function () {
  'use strict';
  var nodes = document.querySelectorAll('canvas[data-hex]');
  for (var i = 0; i < nodes.length; i++) {
    var c = nodes[i];
    try {
      var bytes = ESCPOS.decodeInput(c.getAttribute('data-hex'), 'hex').bytes;
      var res = ESCPOS.interpret(bytes, { dots: 576, codepage: 0 });
      ESCPOS_RENDER.paint(res, c, { paperDots: 640, showArea: true });
    } catch (e) {
      c.insertAdjacentText('afterend', 'Preview failed: ' + e.message);
    }
  }
})();
