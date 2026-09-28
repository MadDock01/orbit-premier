'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const SEQ = [
  ['\u00E2\u0152\u201E', 'v'], // ⌄
  ['\u00E2\u0152\u0081', '*'], // scan icon
  ['\u00E2\u0153\u0161', '*'], // empty diagnosis
  ['\u00E2\u20AC\u00BA', '>'],
  ['\u00E2\u20AC\u00B9', '<'],
  ['\u00E2\u2030\u00A5', '>='],
  ['\u00E2\u2020\u00A9', '<-'],
  ['\u00E2\u02DC\u00B7', '*'],
  ['\u00E2\u02DC - ', '* '],
  ['\u00E2-', '*'],
  ['\u00C3-', 'x'],
  // Arabic tooltip mojibake whole token
  ['\u00D8\u00A7\u00D9\u201E\u00D8\u00B9\u00D8\u00B1\u00D8\u00A8\u00D9\u0160\u00D8\u00A9', 'Arabic'],
];

function fixHtml(s) {
  let out = s;
  for (const [bad, good] of SEQ) out = out.split(bad).join(good);
  // Drop any remaining non-ASCII in HTML shell (CEP-safe)
  out = out.replace(/[^\x00-\x7F]+/g, '');
  out = out.replace(/Right-to-left\s*\(\s*\)/g, 'Right-to-left (Arabic)');
  out = out.replace(/Voice\s+-+\s*/g, 'Voice -');
  out = out.replace(/Music\s+-+\s*/g, 'Music -');
  out = out.replace(/SFX\s+-+\s*/g, 'SFX -');
  out = out.replace(/<div class="captions-empty-icon"><\/div>/g, '<div class="captions-empty-icon" aria-hidden="true">Aa</div>');
  return out;
}

function fixJs(s) {
  let out = s;
  // Keep JS logic; only neutralize known UI emoji / fancy punctuation
  out = out.split('\uD83D\uDCAC').join('');
  out = out.split('\u2726').join('*');
  out = out.split('\u00B7').join(' - ');
  out = out.split('\u2212').join('-');
  out = out.split('\u2013').join('-');
  out = out.split('\u2014').join('-');
  out = out.split('\u2026').join('...');
  out = out.replace(/captions-empty-icon">[^<]*</g, 'captions-empty-icon">Aa<');
  out = out.replace(/Processing\u2026/g, 'Processing...');
  out = out.replace(/Processing…/g, 'Processing...');
  return out;
}

function run(rel, fn) {
  const full = path.join(root, rel);
  const before = fs.readFileSync(full, 'utf8');
  const after = fn(before);
  fs.writeFileSync(full, after, 'utf8');
  console.log('wrote', rel, before.length, '->', after.length);
}

run('index.html', fixHtml);
run('theme-preview.html', fixHtml);
run('modules/autoCaptions.js', fixJs);
run('modules/audio-panel.js', fixJs);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const non = [...html].filter((c) => c.charCodeAt(0) > 127);
console.log('non-ascii remaining', non.length);
console.log('empty', JSON.stringify((html.match(/captions-empty-icon"[^>]*>([^<]*)</) || [])[1]));
console.log('mix', JSON.stringify((html.match(/id="audioMixRole">([\s\S]*?)<\/select>/) || [])[1]));
console.log('spark', JSON.stringify((html.match(/ac-smart-spark">([^<]*)</) || [])[1]));
console.log('chevron', JSON.stringify((html.match(/timing safety<\/small><\/span><i>([^<]*)<\/i>/) || [])[1]));
console.log('zoom', JSON.stringify((html.match(/m4-zoom-label">([^<]*)</) || [])[1]));
console.log('rtl', JSON.stringify((html.match(/title="Right-to-left[^"]*"/) || [])[0]));
