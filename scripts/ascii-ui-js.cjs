'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const MAP = [
  [/\u2026/g, '...'],
  [/\u2014/g, '-'],
  [/\u2013/g, '-'],
  [/\u2212/g, '-'],
  [/\u00B7/g, ' - '],
  [/\u00D7/g, 'x'],
  [/\u2713/g, 'OK'],
  [/\u2192/g, '->'],
  [/\u00A0/g, ' '],
];

const files = [
  'modules/project-doctor.js',
  'modules/composer-tools.js',
  'modules/audio-panel.js',
  'modules/autoCaptions.js',
];

for (const rel of files) {
  const full = path.join(root, rel);
  let s = fs.readFileSync(full, 'utf8');
  const before = s;
  for (const [re, rep] of MAP) s = s.replace(re, rep);
  s = s.replace(/ -  -/g, ' -');
  if (s !== before) {
    fs.writeFileSync(full, s, 'utf8');
    console.log('fixed', rel);
  } else console.log('unchanged', rel);
}
