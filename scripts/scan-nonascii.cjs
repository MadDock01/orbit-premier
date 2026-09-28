'use strict';
const fs = require('fs');
const path = require('path');

const files = [
  'index.html',
  'modules/autoCaptions.js',
  'modules/audio-panel.js',
  'modules/beat-panel.js',
  'modules/project-doctor.js',
  'modules/composer-tools.js',
];
const root = path.resolve(__dirname, '..');

function scan(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return;
  const s = fs.readFileSync(full, 'utf8');
  const hits = [];
  const re = /[^\x00-\x7F]/g;
  let m;
  while ((m = re.exec(s))) {
    const start = Math.max(0, m.index - 35);
    const ctx = s.slice(start, m.index + 40).replace(/\s+/g, ' ');
    hits.push({ i: m.index, cp: m[0].codePointAt(0).toString(16).toUpperCase(), ctx });
    if (hits.length >= 12) break;
  }
  console.log(rel, 'non-ascii sample', hits.length);
  hits.forEach((h) => console.log('  U+' + h.cp, JSON.stringify(h.ctx)));
}

files.forEach(scan);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
console.log('empty', JSON.stringify((html.match(/captions-empty-icon"[^>]*>([^<]*)/) || [])[1]));
console.log('mix', JSON.stringify((html.match(/id="audioMixRole">([\s\S]*?)<\/select>/) || [])[1]));
console.log('generate', JSON.stringify((html.match(/id="ac-open-gen-popup"[^>]*>([^<]*)/) || [])[1]));
console.log('apply', JSON.stringify((html.match(/id="ac-apply-model4-btn"[^>]*>([^<]*)/) || [])[1]));
