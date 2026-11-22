// UI for the ESC/POS viewer. Everything runs in this page; nothing is uploaded.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var input = $('ev-input'), format = $('ev-format'), paper = $('ev-paper'), page = $('ev-codepage'), area = $('ev-area');
  var canvas = $('ev-canvas'), status = $('ev-status'), warnList = $('ev-warnings'), logBody = $('ev-log'), errBox = $('ev-error');
  var zoom = $('ev-zoom');
  function applyZoom() { canvas.style.width = zoom.value === 'fit' ? '' : (canvas.width * +zoom.value) + 'px'; canvas.classList.toggle('fixed', zoom.value !== 'fit'); }
  var fileBytes = null, fileName = '', lastResult = null, timer = null;

  // code page menu
  Object.keys(ESCPOS_CODEPAGES).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) {
    var p = ESCPOS_CODEPAGES[n];
    if (!p.hi) return;
    var o = document.createElement('option');
    o.value = n; o.textContent = n + ': ' + p.name;
    page.appendChild(o);
  });
  page.value = '0';

  // examples
  var exSel = $('ev-example');
  ESCPOS_EXAMPLES.forEach(function (e) {
    var o = document.createElement('option'); o.value = e.id; o.textContent = e.name; exSel.appendChild(o);
  });
  exSel.addEventListener('change', function () {
    var e = ESCPOS_EXAMPLES.filter(function (x) { return x.id === exSel.value; })[0];
    if (!e) return;
    fileBytes = null; fileName = '';
    var bin = atob(e.b64), hexOut = [];
    for (var i = 0; i < bin.length; i++) hexOut.push(('0' + bin.charCodeAt(i).toString(16).toUpperCase()).slice(-2));
    input.value = hexOut.join(' ');
    format.value = 'auto';
    render();
  });

  function paperSettings() {
    var v = paper.value.split(':');
    return { paperDots: +v[0], dots: +v[1] };
  }

  function setText(el, text) { el.textContent = text; }

  function render() {
    errBox.hidden = true;
    var bytes;
    try {
      if (fileBytes) bytes = fileBytes;
      else {
        if (!input.value.trim()) { status.textContent = 'Paste bytes or drop a file to see the receipt.'; clear(); return; }
        var dec = ESCPOS.decodeInput(input.value, format.value);
        bytes = dec.bytes;
        $('ev-detected').textContent = format.value === 'auto' ? 'Read as ' + { hex: 'hex', base64: 'base64', escaped: 'text with escapes' }[dec.mode] : '';
      }
    } catch (e) {
      errBox.hidden = false; setText(errBox, e.message); clear(); return;
    }
    var ps = paperSettings();
    var res = ESCPOS.interpret(bytes, { dots: ps.dots, codepage: +page.value });
    lastResult = res;
    ESCPOS_RENDER.paint(res, canvas, { paperDots: ps.paperDots, showArea: area.checked });
    applyZoom();
    var w = res.warnings.length;
    status.textContent = (fileName ? fileName + ': ' : '') + res.bytes.toLocaleString() + ' bytes, ' + res.counts.commands.toLocaleString() + ' commands, ' +
      res.counts.textBytes.toLocaleString() + ' text bytes, ' + w + ' warning' + (w === 1 ? '' : 's') + '. Receipt length ' + (res.height / 8).toFixed(0) + ' mm.';
    warnList.textContent = '';
    res.warnings.forEach(function (wn) {
      var li = document.createElement('li');
      li.textContent = wn.message + (wn.count > 1 ? ' (' + wn.count + ' times)' : '') + ' [byte ' + wn.offset + ']';
      warnList.appendChild(li);
    });
    $('ev-warn-wrap').hidden = !w;
    logBody.textContent = '';
    res.log.forEach(function (l) {
      var tr = document.createElement('tr');
      [l.offset, l.name, l.detail, l.bytes].forEach(function (v, i) {
        var td = document.createElement('td'); td.textContent = String(v);
        if (i === 3) td.className = 'hex';
        tr.appendChild(td);
      });
      logBody.appendChild(tr);
    });
    $('ev-log-count').textContent = res.log.length + (res.log.length >= 4000 ? '+' : '');
  }
  function clear() {
    lastResult = null;
    canvas.width = 1; canvas.height = 1;
    warnList.textContent = ''; logBody.textContent = ''; $('ev-warn-wrap').hidden = true;
  }
  function soon() { clearTimeout(timer); timer = setTimeout(render, 250); }

  input.addEventListener('input', function () { fileBytes = null; fileName = ''; exSel.value = ''; soon(); });
  [format, paper, page, area].forEach(function (el) { el.addEventListener('change', render); });

  // files
  function loadFile(f) {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { errBox.hidden = false; setText(errBox, 'That file is over 8 MB. Receipt jobs are usually a few KB.'); return; }
    var rd = new FileReader();
    rd.onload = function () {
      fileBytes = new Uint8Array(rd.result); fileName = f.name; exSel.value = '';
      input.value = '';
      input.placeholder = 'Showing ' + f.name + ' (' + fileBytes.length + ' bytes). Type or paste here to replace it.';
      $('ev-detected').textContent = 'Raw file';
      render();
    };
    rd.readAsArrayBuffer(f);
  }
  $('ev-file').addEventListener('change', function (e) { loadFile(e.target.files[0]); });
  var drop = $('ev-drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]); });

  // outputs
  $('ev-png').addEventListener('click', function () {
    if (!lastResult) return;
    var a = document.createElement('a');
    a.download = 'receipt-preview.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  });
  $('ev-copy').addEventListener('click', function () {
    if (!lastResult) return;
    var text = ESCPOS.textLines(lastResult).join('\n');
    var btn = this;
    navigator.clipboard.writeText(text).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy text'; }, 1500); });
  });
  zoom.addEventListener('change', applyZoom);

  // Links from the command reference open with their bytes: #hex=1B40...
  var m = /^#hex=((?:[0-9A-Fa-f]{2}){1,100000})$/.exec(location.hash);
  if (m) {
    input.value = m[1].toUpperCase().match(/../g).join(' ');
    format.value = 'hex';
    render();
  } else {
    exSel.value = 'thermalink';
    exSel.dispatchEvent(new Event('change'));
  }
})();
