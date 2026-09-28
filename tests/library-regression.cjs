// Library (SFX / MOGRT) cross-platform checks. Pulls named functions out of
// js/main.js and runs them, so the Windows and macOS path shapes are both
// exercised on whatever machine the build runs on.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const acorn = require('./dev-require.cjs')('acorn');
const src = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');
const ast = acorn.parse(src, { ecmaVersion: 2022, allowReturnOutsideFunction: true });

function findFn(name) {
  let hit = null;
  (function walk(n) {
    if (!n || typeof n !== 'object' || hit) return;
    if (n.type === 'FunctionDeclaration' && n.id && n.id.name === name) { hit = n; return; }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
  assert.ok(hit, 'js/main.js no longer defines ' + name);
  return hit;
}
function load(names, extra) {
  const ctx = Object.assign({ encodeURI, decodeURI, console, JSON, Math, String, Number }, extra || {});
  vm.createContext(ctx);
  for (const n of names) vm.runInContext(src.slice(findFn(n).start, findFn(n).end), ctx);
  return ctx;
}

let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }

const { libraryFileUrl } = load(['libraryFileUrl']);

test('A Windows path becomes a three-slash file URL', () => {
  assert.equal(libraryFileUrl('C:\\Sounds\\hit.wav', false), 'file:///C:/Sounds/hit.wav');
  assert.equal(libraryFileUrl('D:\\Packs\\My Pack\\boom.mogrt', true), 'file:///D:/Packs/My%20Pack/boom.mogrt');
});
test('A macOS path is not given a fourth slash', () => {
  // "file:///" + "/Users/..." used to yield file:////Users/... which Premiere
  // cannot resolve, so drag-and-drop silently did nothing on macOS.
  const url = libraryFileUrl('/Users/sonjoy/Sounds/hit.wav', false);
  assert.equal(url, 'file:///Users/sonjoy/Sounds/hit.wav');
  assert.ok(!url.startsWith('file:////'), 'four slashes are back: ' + url);
});
test('Spaces and non-ASCII names are encoded only in the encoded flavour', () => {
  assert.equal(libraryFileUrl('/Users/x/My Sounds/hit.wav', false), 'file:///Users/x/My Sounds/hit.wav');
  assert.equal(libraryFileUrl('/Users/x/My Sounds/hit.wav', true), 'file:///Users/x/My%20Sounds/hit.wav');
  assert.equal(libraryFileUrl('/Users/x/বাংলা/hit.wav', true), 'file:///Users/x/%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE/hit.wav');
});
test('An empty path does not produce a broken URL scheme', () => {
  assert.equal(libraryFileUrl('', false), 'file:///');
  assert.equal(libraryFileUrl(null, false), 'file:///');
});

// ── Static checks over the library code path ────────────────────────────────
test('Library extension matching is case-insensitive', () => {
  // A file named HIT.WAV or CLIP.MOGRT must still be accepted; macOS volumes
  // are commonly case-insensitive but the names are preserved as typed.
  assert.match(src, /path\.extname\([^)]*\)\.toLowerCase\(\)/,
    'addFilePaths should lowercase the extension before matching');
  for (const list of ['AUDIO_EXT', 'MOGRT_EXT', 'PRFPSET_EXT']) {
    const m = src.match(new RegExp('const ' + list + ' = \\[([^\\]]*)\\]'));
    assert.ok(m, list + ' not found');
    assert.equal(m[1], m[1].toLowerCase(), list + ' must be declared lowercase');
  }
});
test('No shell binary is invoked without a platform guard', () => {
  const bad = [];
  src.split('\n').forEach((line, i) => {
    if (!/explorer\.exe|cmd\.exe|powershell/.test(line)) return;
    const near = src.split('\n').slice(Math.max(0, i - 6), i + 1).join('\n');
    if (!/process\.platform/.test(near)) bad.push(i + 1 + ': ' + line.trim());
  });
  assert.deepEqual(bad, [], 'unguarded Windows binary: ' + bad.join(' | '));
});
test('Library paths are built with path.join, not string concatenation', () => {
  // A hardcoded separator is the classic way a library breaks on the other OS.
  const bad = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (/["'][A-Za-z]:\\\\/.test(line)) bad.push(i + 1 + ': ' + line.trim().slice(0, 90));
  });
  assert.deepEqual(bad, [], 'hardcoded drive-letter path: ' + bad.join(' | '));
});
test('The MOGRT cache lives under the OS temp dir, not a fixed path', () => {
  assert.match(src, /MOGRT_CACHE_ROOT\s*=\s*[^;]*os\.tmpdir\(\)/,
    'MOGRT cache must be derived from os.tmpdir()');
});


// --- Library chrome compaction ------------------------------------------
// css/library-compact.css reclaims panel height from the four toolbars and
// width from the folder sidebar. Two things there can break silently, so they
// are pinned here rather than left to a screenshot.
const compact = fs.readFileSync(path.join(root, 'css/library-compact.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('The compaction layer is loaded, and loaded last', () => {
  const links = [...html.matchAll(/<link href="(css\/[^"?]+)/g)].map(m => m[1]);
  assert.ok(links.includes('css/library-compact.css'), 'the stylesheet is not linked at all');
  assert.equal(links[links.length - 1], 'css/library-compact.css',
    'it must come last or the earlier !important layers win');
});

// applyCardSize() in js/main.js sets --card-min-w on the grid. A rule that
// hardcodes grid-template-columns would leave the slider moving with nothing
// happening — the control would look alive and be dead.
test('The card grid still reads the size slider variable', () => {
  const rule = compact.slice(compact.indexOf('#app #sfxMogrtView .library.grid'));
  const block = rule.slice(0, rule.indexOf('}'));
  assert.match(block, /grid-template-columns/);
  assert.match(block, /var\(--card-min-w/, 'the size slider drives this variable');
  assert.match(src, /setProperty\("--card-min-w"/, 'main.js no longer sets the variable this rule reads');
});

// The sidebar is narrowed and, on a very narrow panel, given zero width. It
// must stay a :not(.collapsed) rule: overriding the collapsed state too would
// break the < toggle in the content header.
test('Narrowing the folder sidebar leaves its collapse toggle alone', () => {
  const rules = compact.match(/#app #sfxMogrtView [^{]*sidebar[^{]*\{/g) || [];
  assert.ok(rules.length, 'no sidebar rules found');
  for (const r of rules) {
    assert.match(r, /:not\(\.collapsed\)/, 'this rule also hits the collapsed state: ' + r.trim());
  }
});


console.log(count + ' library tests passed; real Premiere drag-and-drop remains unverified.');
