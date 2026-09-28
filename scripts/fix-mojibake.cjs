'use strict';
/**
 * Fix Premiere CEP UI mojibake + fancy glyphs -> ASCII.
 * Patterns use \u escapes so this script file encoding cannot break matching.
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

// Literal mojibake codepoint sequences found in index.html (UTF-8 misread as cp1252).
const REPLACEMENTS = [
  // 💬 emoji -> remove
  ['\u00F0\u0178\u2019\u00AC', ''],
  // other common emoji mojibake prefixes (palette / folder / etc.)
  ['\u00F0\u0178\u017D\u00A8', ''], // 🎨
  ['\u00F0\u0178\u2014\u201A', ''], // 🗂-ish
  ['\u00F0\u0178\u201C\u0081', ''], // 📁-ish
  // − (U+2212 MINUS) mojibake âˆ’
  ['\u00E2\u02C6\u2019', '-'],
  // — em dash â€”
  ['\u00E2\u20AC\u201D', '-'],
  // – en dash â€“
  ['\u00E2\u20AC\u201C', '-'],
  // … ellipsis â€¦
  ['\u00E2\u20AC\u00A6', '...'],
  // → â†’
  ['\u00E2\u2020\u2019', '->'],
  // ← â†
  ['\u00E2\u2020\u0090', '<-'],
  // ↑ â†‘
  ['\u00E2\u2020\u2018', '^'],
  // ↓ â†“
  ['\u00E2\u2020\u201C', 'v'],
  // ✦ âœ¦
  ['\u00E2\u0153\u00A6', '*'],
  // ✎ âœŽ
  ['\u00E2\u0153\u017D', 'Edit'],
  // ✓ âœ“ / ✕ âœ• / etc. - handle common
  ['\u00E2\u0153\u201C', 'OK'],
  ['\u00E2\u0153\u2022', 'x'],
  // ▶ â–¶
  ['\u00E2\u2013\u00B6', '>'],
  // · middle dot as Â·
  ['\u00C2\u00B7', ' - '],
  // orphan Â (from Â· / non-breaking constructs)
  ['\u00C2', ''],
  // curly quotes mojibake
  ['\u00E2\u20AC\u2122', "'"],
  ['\u00E2\u20AC\u0153', '"'],
  ['\u00E2\u20AC\u009D', '"'],
  ['\u00E2\u20AC\u02DC', "'"],

  // Real Unicode (if file is clean UTF-8)
  ['\uD83D\uDCAC', ''], // 💬
  ['\uD83C\uDFA8', ''], // 🎨
  ['\uD83D\uDCC1', ''], // 📁
  ['\u2726', '*'], // ✦
  ['\u00B7', ' - '], // ·
  ['\u2212', '-'], // −
  ['\u2013', '-'], // –
  ['\u2014', '-'], // —
  ['\u2026', '...'], // …
  ['\u2192', '->'],
  ['\u2190', '<-'],
  ['\u2191', '^'],
  ['\u2193', 'v'],
  ['\u2304', 'v'], // ⌄
  ['\u25B6', '>'],
  ['\u2713', 'OK'],
  ['\u2715', 'x'],
  ['\u2716', 'x'],
  ['\u00D7', 'x'],
  ['\uFF0B', '+'], // ＋
  ['\u21BA', ''], // ↺
  ['\u25A3', ''], // ▣
  ['\u232B', ''], // ⌫
  ['\u2032', "'"],
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201C', '"'],
  ['\u201D', '"'],
  ['\u00A0', ' '],
  ['\u200B', ''],
  ['\uFEFF', ''],
];

function fixText(s) {
  let out = s;
  for (const [bad, good] of REPLACEMENTS) {
    if (!bad) continue;
    if (out.indexOf(bad) !== -1) out = out.split(bad).join(good);
  }
  // tidy "Voice  - -6" style doubles
  out = out.replace(/ -\s+-/g, ' -');
  out = out.replace(/[ \t]+\n/g, '\n');
  return out;
}

function processFile(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.log('skip', rel);
    return;
  }
  const before = fs.readFileSync(full, 'utf8');
  const after = fixText(before);
  if (after === before) {
    console.log('unchanged', rel);
    return;
  }
  fs.writeFileSync(full, after, 'utf8');
  console.log('fixed', rel);
}

[
  'index.html',
  'theme-preview.html',
  'modules/autoCaptions.js',
  'modules/audio-panel.js',
].forEach(processFile);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function show(label, re) {
  const m = html.match(re);
  console.log(label + ':', m ? JSON.stringify(m[1].slice(0, 160)) : 'MISSING');
}
show('empty-icon', /captions-empty-icon">([^<]*)</);
show('spark', /ac-smart-spark">([^<]*)</);
show('mix', /id="audioMixRole">([\s\S]*?)<\/select>/);
show('normalize', /Normalize output \(([^)]*)\)/);
show('reset', /id="btnReset"[^>]*>([^<]*)</);

// leftover high chars sample
const leftovers = new Set();
for (const ch of html) {
  const cp = ch.codePointAt(0);
  if (cp > 127) leftovers.add('U+' + cp.toString(16).toUpperCase() + '=' + ch);
}
console.log('non-ascii sample count', leftovers.size);
console.log([...leftovers].slice(0, 40).join(' | '));
