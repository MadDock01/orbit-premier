/**
 * dock-extras.js — the panel half of the second round of dock actions.
 *
 * Two things here cannot be done in ExtendScript at all, which is why they
 * live on this side:
 *   · reading a bitmap off the OS clipboard (Paste Image)
 *   · drawing the safe-margin overlay (Premiere exposes no program-monitor
 *     overlay to scripting, so the guides have to become a real PNG on a
 *     guide track)
 * Everything else is a thin call into jsx/hostscript.jsx.
 */
(function (global) {
  'use strict';

  var GUIDE_ASPECTS = {
    '16x9': { w: 16, h: 9, label: '16:9' },
    '9x16': { w: 9, h: 16, label: '9:16' }
  };

  function nodeRequire() {
    var req = global.require || (typeof require === 'function' ? require : null);
    if (!req) throw new Error('Local file access is unavailable in this panel.');
    return req;
  }

  function generatedFolder(name) {
    var req = nodeRequire(), fs = req('fs'), path = req('path'), os = req('os');
    // Not os.tmpdir(): Premiere keeps referencing the file after the import,
    // so a temp sweep would take the media offline.
    var folder = path.join(os.homedir(), 'Documents', 'CompX-Orbit-Premiere', 'Generated Media', name);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    return folder;
  }

  function run(command, args, timeout) {
    return new Promise(function (resolve) {
      var cp;
      try { cp = nodeRequire()('child_process'); } catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); return; }
      cp.execFile(command, args, { timeout: timeout || 15000, windowsHide: true }, function (err, stdout, stderr) {
        resolve({ code: err ? (err.code === undefined ? 1 : err.code) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  /* ------------------------------------------------------- clipboard ---- */

  // Explorer/Finder put a file reference on the clipboard rather than a
  // bitmap, so both shapes are handled: a real bitmap is written out as PNG,
  // a copied image file is used where it already is.
  var IMAGE_FILE = /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i;

  // Written to disk and run with -File rather than passed to -Command: the
  // output path is then just an argument, with no quoting to get wrong.
  var PS_SCRIPT = [
    'param([string]$OutPath)',
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing | Out-Null',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -ne $null) { $img.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output "bitmap"; exit 0 }',
    '$files = [System.Windows.Forms.Clipboard]::GetFileDropList()',
    'if ($files -ne $null -and $files.Count -gt 0) { Write-Output ("file:" + $files[0]); exit 0 }',
    'Write-Output "none"',
    'exit 0'
  ].join('\r\n');

  var OSA_SCRIPT = [
    'on writeData(theData, thePath)',
    '  set fp to open for access (POSIX file thePath) with write permission',
    '  set eof fp to 0',
    '  write theData to fp',
    '  close access fp',
    'end writeData',
    'on run argv',
    '  set outPath to item 1 of argv',
    '  try',
    '    set d to (the clipboard as «class PNGf»)',
    '    writeData(d, outPath)',
    '    return "bitmap"',
    '  end try',
    '  try',
    '    set f to (the clipboard as «class furl»)',
    '    return "file:" & POSIX path of f',
    '  end try',
    '  return "none"',
    'end run'
  ].join('\n');

  /**
   * Returns { path } for an image taken from the clipboard, or throws with a
   * message the dock can show as-is.
   */
  function clipboardImage() {
    var req = nodeRequire(), fs = req('fs'), path = req('path'), os = req('os');
    var out = path.join(generatedFolder('pasted'), 'paste-' + Date.now() + '.png');
    var platform = os.platform();
    var job;

    if (platform === 'win32') {
      // -STA is required: the Windows clipboard is not readable from an MTA
      // thread, and PowerShell defaults to MTA on some hosts.
      var ps1 = path.join(generatedFolder('pasted'), 'orbit-clip.ps1');
      fs.writeFileSync(ps1, PS_SCRIPT, 'utf8');
      job = run('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-OutPath', out], 20000);
    } else if (platform === 'darwin') {
      var scriptPath = path.join(generatedFolder('pasted'), 'orbit-clip.applescript');
      fs.writeFileSync(scriptPath, OSA_SCRIPT, 'utf8');
      job = run('osascript', [scriptPath, out], 20000);
    } else {
      return Promise.reject(new Error('Paste Image is supported on Windows and macOS only.'));
    }

    return job.then(function (res) {
      var answer = res.stdout.replace(/^\s+|\s+$/g, '');
      if (answer.indexOf('bitmap') === 0) {
        if (!fs.existsSync(out)) throw new Error('The clipboard image could not be written to disk.');
        return { path: out, from: 'bitmap' };
      }
      if (answer.indexOf('file:') === 0) {
        var file = answer.slice(5).replace(/^\s+|\s+$/g, '');
        if (!IMAGE_FILE.test(file)) throw new Error('The clipboard holds a file that is not an image.');
        if (!fs.existsSync(file)) throw new Error('The copied file no longer exists: ' + file);
        return { path: file, from: 'file' };
      }
      if (res.code !== 0 && res.stderr) throw new Error('Could not read the clipboard: ' + res.stderr.split('\n')[0]);
      throw new Error('No image on the clipboard. Copy one and try again.');
    });
  }

  /* ----------------------------------------------------------- guides ---- */

  /**
   * Draws the overlay at the sequence's own frame size and returns its path.
   * Action safe is 90% and title safe 80% of the frame, which is what
   * Premiere's own Safe Margins overlay uses; the third box is the target
   * aspect, centred, so a 16:9 edit can be framed for a 9:16 crop.
   */
  function writeGuidePng(spec, aspectKey) {
    var aspect = GUIDE_ASPECTS[aspectKey];
    if (!aspect) throw new Error('Unknown guide aspect: ' + aspectKey);
    var w = Math.max(16, Math.round(Number(spec && spec.width) || 1920));
    var h = Math.max(16, Math.round(Number(spec && spec.height) || 1080));

    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    // Line weight has to scale with the frame or the guides vanish on a 4K
    // sequence and swamp a 720p one.
    var unit = Math.max(1, Math.round(Math.min(w, h) / 540));

    // Safe margins belong to the CROP, not the frame. Drawing them against a
    // 16:9 frame while the user is framing for a 9:16 crop would mark out an
    // action-safe area that is mostly outside the delivered picture.
    var targetRatio = aspect.w / aspect.h, frameRatio = w / h;
    var cw = targetRatio > frameRatio ? w : h * targetRatio;
    var ch = targetRatio > frameRatio ? w / targetRatio : h;
    var cx = (w - cw) / 2, cy = (h - ch) / 2;

    function box(fraction, color, dash, label) {
      var bw = cw * fraction, bh = ch * fraction;
      var x = cx + (cw - bw) / 2, y = cy + (ch - bh) / 2;
      ctx.strokeStyle = color; ctx.lineWidth = unit * 2;
      ctx.setLineDash(dash ? [unit * 8, unit * 6] : []);
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);
      if (!label) return;
      ctx.fillStyle = color;
      ctx.font = '700 ' + Math.round(unit * 13) + 'px Arial, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x + unit * 5, y + unit * 4);
    }

    // Everything outside the crop is dimmed rather than hidden, so the parts
    // of the shot that will be cut are still visible while reframing.
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    if (cw < w) { ctx.fillRect(0, 0, cx, h); ctx.fillRect(cx + cw, 0, w - cx - cw, h); }
    if (ch < h) { ctx.fillRect(0, 0, w, cy); ctx.fillRect(0, cy + ch, w, h - cy - ch); }
    ctx.strokeStyle = '#32d36a'; ctx.lineWidth = unit * 3;
    ctx.strokeRect(cx, cy, cw, ch);
    ctx.fillStyle = '#32d36a';
    ctx.font = '700 ' + Math.round(unit * 15) + 'px Arial, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(aspect.label + ' crop', cx + unit * 6, cy + ch - unit * 5);

    box(0.9, 'rgba(255,255,255,0.85)', false, 'ACTION SAFE 90%');
    box(0.8, 'rgba(255,255,255,0.55)', true, 'TITLE SAFE 80%');

    // Centre crosshair, so a reframe has something to centre on.
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = unit;
    ctx.beginPath();
    ctx.moveTo(w / 2, h / 2 - unit * 14); ctx.lineTo(w / 2, h / 2 + unit * 14);
    ctx.moveTo(w / 2 - unit * 14, h / 2); ctx.lineTo(w / 2 + unit * 14, h / 2);
    ctx.stroke();

    var req = nodeRequire(), fs = req('fs'), path = req('path'), BufferCtor = req('buffer').Buffer;
    var raw = canvas.toDataURL('image/png').split(',')[1];
    var file = path.join(generatedFolder('guides'), 'safe-' + aspectKey + '-' + w + 'x' + h + '.png');
    fs.writeFileSync(file, BufferCtor.from(raw, 'base64'));
    return file;
  }

  global.DockExtras = {
    clipboardImage: clipboardImage,
    writeGuidePng: writeGuidePng,
    aspects: GUIDE_ASPECTS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.DockExtras;
}(typeof window !== 'undefined' ? window : globalThis));
