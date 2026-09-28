'use strict';
/**
 * Compiles jsx/hostscript.jsx -> jsx/hostscript.jsxbin, and nothing else.
 *
 * This is NOT needed to test the panel. js/compx-loader.js points at
 * '/jsx/hostscript.jsx' in the source tree; only scripts/build-release.cjs
 * swaps that to '.jsxbin' when it stages a package. An editable install runs
 * the plain .jsx. Use this when you want to confirm the host script compiles,
 * or to refresh the .jsxbin without producing a signed release.
 *
 * The compiler is Adobe's esdebugger-core native addon, which ships for
 * Windows and macOS only — it cannot run on Linux.
 */
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const tools = path.resolve(root, '../CompX-Orbit-Studio/tools');
const src = path.join(root, 'jsx', 'hostscript.jsx');
const out = path.join(root, 'jsx', 'hostscript.jsxbin');
const n = v => Number(v).toLocaleString('en-US');

(async () => {
  if (!fs.existsSync(src)) throw Error('Source not found: ' + src);
  const pkg = path.join(tools, 'node_modules', 'jsxbin');
  if (!fs.existsSync(pkg)) {
    throw Error('jsxbin is not installed at ' + pkg + '\n         cd "' + tools + '" && npm install jsxbin');
  }

  const before = fs.existsSync(out) ? fs.statSync(out).size : 0;
  console.log('source  ' + n(fs.statSync(src).size) + ' bytes  ' + src);
  console.log('compiling...');

  await require(pkg)(src, out);

  if (!fs.existsSync(out)) throw Error('The compiler produced no output file.');
  const head = fs.readFileSync(out, 'utf8').slice(0, 8);
  if (head !== '@JSXBIN@') {
    throw Error('Output is not JSXBIN (starts with "' + head + '"). The compiler failed silently.');
  }
  console.log('jsxbin  ' + n(fs.statSync(out).size) + ' bytes' + (before ? '  (was ' + n(before) + ')' : '  (new)'));
  console.log('written ' + out);
  console.log('');
  console.log('Note: this did NOT build a ZXP. Run scripts/build-release.cjs for a signed package.');
})().catch(e => {
  console.error('');
  console.error('Failed: ' + e.message);
  if (/Platform not supported/.test(e.message)) {
    console.error('        Adobe ships the JSXBIN compiler for Windows and macOS only.');
  }
  process.exitCode = 1;
});
