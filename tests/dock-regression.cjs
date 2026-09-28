// Drives the real index.html dock in a DOM with the Premiere bridge stubbed.
// Catches the class of bug that a JSX-only suite cannot see: a control that
// exists in the markup but is wired to nothing, or wired to the wrong endpoint.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
// jsdom is a soft dependency: `npm install` in this repo provides it.
// Missing means skip, not fail, so the release build never breaks over a
// dev-only package.
let JSDOM;
try { JSDOM = require('./dev-require.cjs')('jsdom').JSDOM; }
catch (_) {
  try { JSDOM = require('jsdom').JSDOM; } catch (_2) {
    console.log('SKIP dock wiring suite: jsdom is not installed (run npm install).');
    process.exit(0);
  }
}
let count = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function boot() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'),
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const calls = [];
  win.OrbitCore = {
    host: { call: (name, args) => { calls.push({ name, args }); return Promise.resolve({ ok: true, moved: 1, changed: 1, count: 1, fps: 30 }); } },
    run: (cfg) => {
      calls.push({ name: 'run:' + cfg.id, confirm: !!cfg.confirm, danger: !!cfg.danger, safetyCopy: !!cfg.safetyCopy });
      return Promise.resolve({ ok: true, changed: 1 });
    }
  };
  // jsdom has no 2D canvas; the matte writer only needs it not to throw.
  win.HTMLCanvasElement.prototype.getContext = () => ({
    fillRect() {}, clearRect() {}, fillText() {}, measureText: () => ({ width: 10 }),
    set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    set shadowColor(v) {}, set shadowBlur(v) {}, set shadowOffsetY(v) {}
  });
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
  win.eval(fs.readFileSync(path.join(root, 'modules/dock-extras.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(root, 'modules/composer-tools.js'), 'utf8'));
  return { win, doc: win.document, calls };
}
const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const flush = () => new Promise(r => setTimeout(r, 0));

test('Every dock control is wired to a host endpoint', () => {
  const { win, doc, calls } = boot();
  const dock = doc.getElementById('orbitRightDock');
  assert.ok(dock, 'dock missing from index.html');
  assert.equal(dock.getAttribute('data-orbit-wired'), '1');
  const expected = {
    'cut-at-playhead': 'run:timeline-cut-at-playhead',
    'trim-before': 'run:timeline-trim-before',
    'trim-after': 'run:timeline-trim-after',
    'color-matte': 'getActiveSequenceSpec'
  };
  for (const action of Object.keys(expected)) {
    const btn = dock.querySelector('[data-dock-action="' + action + '"]');
    assert.ok(btn, 'no dock button for ' + action);
    calls.length = 0;
    click(win, btn);
    assert.ok(calls.length, action + ' is wired to nothing');
    assert.equal(calls[0].name, expected[action], action + ' called ' + calls[0].name);
  }
});

test('Nothing left on the dock confirms or takes a safety copy', () => {
  const { win, doc, calls } = boot();
  const dock = doc.getElementById('orbitRightDock');
  for (const action of ['cut-at-playhead', 'trim-before', 'trim-after']) {
    calls.length = 0;
    click(win, dock.querySelector('[data-dock-action="' + action + '"]'));
    assert.equal(calls[0].confirm, false, action + ' confirm');
    assert.equal(calls[0].safetyCopy, false, action + ' safetyCopy');
    assert.equal(calls[0].danger, false, action + ' danger');
  }
});

// Ripple Delete stays off the dock (its host endpoint remains). Align and
// Anchor came back once Align measured real clip bounds: every one of the 18
// pad cells must reach its own endpoint with its own mode.
test('Ripple delete stays gone; every align and anchor cell reaches its endpoint', async () => {
  const { win, doc } = boot();
  assert.equal(doc.querySelector('[data-dock-action="ripple-delete"]'), null, 'ripple delete button survived');
  assert.equal(typeof win.ComposerTools.align, 'function');
  assert.equal(typeof win.ComposerTools.setAnchor, 'function');
  const modes = ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
  for (const [action, pad, endpoint] of [['align', 'alignPad', 'composerAlignSelection'], ['anchor', 'anchorPad', 'composerSetAnchorPoint']]) {
    const cells = doc.querySelectorAll('#' + pad + ' [data-dock-action="' + action + '"]');
    assert.deepEqual(Array.from(cells).map((b) => b.getAttribute('data-mode')), modes, pad + ' cells');
    for (const mode of modes) {
      const h = boot();
      const cell = h.doc.querySelector('#' + pad + ' [data-mode="' + mode + '"]');
      click(h.win, cell);
      await flush();
      // A successful action also refreshes the selection count afterwards.
      assert.deepEqual(h.calls.map((c) => c.name).filter((n) => n !== 'composerInspectSelection'), [endpoint], action + ' ' + mode);
      assert.equal(h.calls[0].name, endpoint);
      assert.equal(h.calls[0].args[0], mode);
      assert.ok(cell.classList.contains('is-last'), action + ' ' + mode + ' not marked as last used');
    }
  }
});

test('A drawer toggle opens only its own pop', () => {
  const { win, doc } = boot();
  const drawers = doc.querySelectorAll('#orbitRightDock .orbit-dock-drawer');
  assert.equal(drawers.length, 7, 'align, anchor, nest, guides, sequence, volume, pitch');
  for (const drawer of drawers) {
    click(win, drawer.querySelector('[data-dock-drawer]'));
    assert.equal(doc.querySelectorAll('#orbitRightDock .orbit-dock-drawer.open').length, 1);
    assert.ok(drawer.classList.contains('open'));
    assert.equal(drawer.querySelector('[data-dock-drawer]').getAttribute('aria-expanded'), 'true');
  }
});

test('A pop is clamped inside the panel instead of hanging off the edge', () => {
  const { win, doc } = boot();
  Object.defineProperty(win, 'innerWidth', { value: 240, configurable: true });
  const drawer = doc.querySelector('#volumeBlock').closest('.orbit-dock-drawer');
  const toggle = drawer.querySelector('[data-dock-drawer]');
  toggle.getBoundingClientRect = () => ({ left: 232, width: 25, top: 400 });
  Object.defineProperty(drawer.querySelector('.orbit-dock-pop'), 'offsetWidth', { value: 128, configurable: true });
  click(win, toggle);
  const left = parseFloat(drawer.querySelector('.orbit-dock-pop').style.left);
  assert.ok(left + 64 <= 240, 'pop right edge ' + (left + 64) + ' overflows 240px panel');
  assert.ok(left - 64 >= 0, 'pop left edge overflows');
});

test('Working state disables every dock control until the call settles', async () => {
  const { win, doc, calls } = boot();
  let release = null;
  const resolved = () => Promise.resolve({ ok: true, moved: 1, changed: 1, count: 1, fps: 30 });
  // Only the FIRST call hangs. The follow-up refresh must be able to finish, or
  // busy(false) never runs and the test would be asserting its own deadlock.
  win.OrbitCore.host.call = (name, args) => {
    calls.push({ name, args });
    if (release !== null) return resolved();
    return new Promise(r => { release = r; });
  };
  click(win, doc.querySelector('[data-dock-action="color-matte"]'));
  await flush();
  assert.ok(doc.querySelector('[data-dock-action="cut-at-playhead"]').disabled, 'controls stay clickable while busy');
  assert.ok(doc.querySelector('[data-dock-drawer="volume"]').disabled);
  release({ ok: true, width: 1920, height: 1080 });
  for (let i = 0; i < 12; i++) await flush();
  assert.equal(doc.querySelector('[data-dock-action="cut-at-playhead"]').disabled, false, 'controls never re-enabled');
  assert.equal(doc.querySelector('[data-dock-drawer="volume"]').disabled, false);
});

// Every action added in the second round. A menu row that looks right but is
// wired to nothing is exactly the bug this suite exists to catch, and there
// are now fifteen of them behind four drawers.
test('Every second-round dock action reaches its own host endpoint', async () => {
  const expected = {
    'nest': ['composerNest'],
    'flip-h': ['composerFlip', 'horizontal'],
    'flip-v': ['composerFlip', 'vertical'],
    'fit': ['composerFitToFrame', 'fit'],
    'fill': ['composerFitToFrame', 'fill'],
    'scale-reset': ['composerFitToFrame', 'reset'],
    'guides-off': ['composerRemoveGuides'],
    'seq-selection': ['composerCreateSequence', 'selection'],
    'seq-16x9': ['composerCreateSequence', '16x9'],
    'seq-9x16': ['composerCreateSequence', '9x16']
  };
  for (const action of Object.keys(expected)) {
    const { win, doc, calls } = boot();
    const btn = doc.querySelector('#orbitRightDock [data-dock-action="' + action + '"]');
    assert.ok(btn, 'no dock control for ' + action);
    click(win, btn);
    await flush();
    assert.ok(calls.length, action + ' is wired to nothing');
    assert.equal(calls[0].name, expected[action][0], action + ' called ' + calls[0].name);
    if (expected[action][1] !== undefined) {
      assert.equal(calls[0].args[0], expected[action][1], action + ' passed ' + calls[0].args[0]);
    }
  }
});

// The point of the inspect round: the user has to be told what an unnest
// costs while the nest is still intact. A single call that rebuilds and then
// warns is an apology, not a warning.
test('Unnest inspects before it applies', async () => {
  const { win, doc, calls } = boot();
  win.OrbitCore.run = (cfg) => {
    calls.push({ name: 'run:' + cfg.id, confirm: !!cfg.confirm, safetyCopy: !!cfg.safetyCopy });
    return Promise.resolve(cfg.preflight({ host: win.OrbitCore.host.call }))
      .then(() => ({ preview: cfg.preview() }))
      .then(p => cfg.execute({ host: win.OrbitCore.host.call }).then(r => Object.assign({ preview: p.preview }, r)));
  };
  win.OrbitCore.host.call = (name, args) => {
    calls.push({ name, args });
    return Promise.resolve(args[0] === 'inspect'
      ? { ok: true, inspected: true, clips: 4, effects: 2, message: '2 effect(s) ... will be lost.' }
      : { ok: true, placed: 4, total: 4, effectsLost: 2, errors: [] });
  };
  click(win, doc.querySelector('[data-dock-action="unnest"]'));
  for (let i = 0; i < 12; i++) await flush();
  const host = calls.filter(c => c.name === 'composerUnnest');
  assert.equal(host.length, 2, 'expected an inspect call and an apply call');
  assert.equal(host[0].args[0], 'inspect', 'the first call must not change anything');
  assert.equal(host[1].args[0], 'apply');
  const run = calls.find(c => c.name === 'run:timeline-unnest');
  assert.ok(run.confirm, 'unnest deletes the nest clip, so it must confirm');
  assert.ok(run.safetyCopy, 'unnest must take a safety copy');
});

// Paste Image and the guides both need a file on disk before the host can do
// anything, so a missing dock-extras.js has to fail loudly rather than
// silently doing nothing.
test('Paste image and guides report a missing dock-extras instead of failing silently', async () => {
  const { win, doc } = boot();
  delete win.DockExtras;
  for (const action of ['paste-image', 'guides-16x9']) {
    click(win, doc.querySelector('[data-dock-action="' + action + '"]'));
    await flush();
    const status = doc.getElementById('orbitDockStatus');
    assert.match(status.textContent, /dock-extras\.js did not load/, action + ' said: ' + status.textContent);
    assert.ok(status.classList.contains('error'), action + ' must read as an error');
  }
});

// Everything lives on one vertical rail down the right-hand side now — the
// bottom bar and the transform bar under the header are both gone. The two
// things worth pinning are that no control was dropped in the move, and that
// the rail is a single column: a wrapped rail would eat panel width the way
// the old wrapped bar ate panel height.
test('Every control is on the one right-hand rail, in a single column', () => {
  const { doc } = boot();
  const rail = doc.getElementById('orbitRightDock');
  assert.ok(rail, 'right dock missing from index.html');
  assert.equal(rail.getAttribute('data-orbit-wired'), '1');
  assert.equal(doc.getElementById('orbitGlobalDock'), null, 'the bottom bar is still in the markup');
  assert.equal(doc.getElementById('orbitTopDock'), null, 'the transform bar is still in the markup');

  for (const action of ['cut-at-playhead', 'trim-before', 'trim-after', 'flip-h', 'flip-v',
    'fit', 'fill', 'scale-reset', 'paste-image', 'color-matte']) {
    assert.ok(rail.querySelector('[data-dock-action="' + action + '"]'), action + ' did not survive the move');
  }
  for (const drawer of ['align', 'anchor', 'nest', 'guides', 'sequence', 'volume', 'pitch']) {
    assert.ok(rail.querySelector('[data-dock-drawer="' + drawer + '"]'), drawer + ' drawer did not survive the move');
  }
  assert.equal(rail.querySelectorAll('.orbit-dock-btn').length, 17);

  // jsdom has no layout, so the single column is read off the rule that
  // guarantees it rather than measured.
  const css = fs.readFileSync(path.join(root, 'css/orbit-dock.css'), 'utf8');
  const strip = css.slice(css.indexOf('.orbit-right-dock .orbit-dock-center {'));
  const block = strip.slice(0, strip.indexOf('}'));
  assert.match(block, /flex-direction:\s*column/);
  assert.match(block, /flex-wrap:\s*nowrap/, 'a wrapped rail would widen instead of scrolling');
  assert.match(block, /overflow-y:\s*auto/, 'a rail taller than the panel must scroll');
});

// The rail starts level with the panel's content, not under the header. A
// hardcoded top cannot do that: the library's own toolbars are 79px tall at
// 420px and 129px at 240px, so the offset has to be measured at runtime.
test('The rail top is measured against the content, not hardcoded', () => {
  const { doc } = boot();
  const marked = doc.querySelectorAll('[data-dock-anchor]');
  assert.equal(marked.length, 1, 'expected exactly one dock anchor in index.html');
  assert.equal(marked[0].id, 'mainLayout', 'the anchor moved off the library layout');

  const src = fs.readFileSync(path.join(root, 'modules/composer-tools.js'), 'utf8');
  const sync = src.slice(src.indexOf('function railTopTarget('), src.indexOf('function watchRailTop'));
  assert.match(sync, /data-dock-anchor/, 'syncRailTop does not look for the anchor');
  assert.match(sync, /getBoundingClientRect/, 'the offset must be measured');
  assert.match(sync, /Math\.max\(0, Math\.min\(top, limit\)\)/,
    'an unclamped top can push the rail off the bottom of a short panel');

  // Switching rails swaps a display:none, which fires no resize event.
  const watch = src.slice(src.indexOf('function watchRailTop'), src.indexOf('  /**\n   * Puts a pop'));
  assert.match(watch, /ResizeObserver/, 'nothing re-measures when the panel resizes');
  assert.match(watch, /MutationObserver/, 'nothing re-measures when the view changes');
});

// The rail is absolutely positioned, so nothing reflows around it: #app has to
// reserve the width or every panel's content runs underneath the icons. It
// took !important to get there, because a later layer writes #app's padding
// as a shorthand and silently resets the right side.
test('The panel reserves the rail its width', () => {
  const css = fs.readFileSync(path.join(root, 'css/orbit-dock.css'), 'utf8');
  assert.match(css, /#app\s*\{\s*padding-right:\s*32px\s*!important/,
    'no padding-right reservation for the rail');
  const rail = css.slice(css.indexOf('.orbit-right-dock {'));
  assert.match(rail.slice(0, rail.indexOf('}')), /width:\s*32px/,
    'the rail width and the reservation disagree');
});

// Pops used to open upward from a bottom bar. On a full-height rail they open
// sideways, and the lowest buttons would throw one off the bottom of the
// window without the vertical clamp.
test('A pop opens beside its own button, never off-screen', () => {
  const src = fs.readFileSync(path.join(root, 'modules/composer-tools.js'), 'utf8');
  const fn = src.slice(src.indexOf('function placePop('), src.indexOf('function closeDockDrawers'));
  assert.match(fn, /rect\.left - width - 8/, 'the pop must sit to the left of the rail');
  assert.match(fn, /Math\.max\(6, Math\.min\(top,/, 'no vertical clamp: a low button opens a pop off-screen');
  assert.match(fn, /if \(left < 6\)/, 'no fallback for a panel too narrow to fit a pop beside the rail');
});

test('Every control moves and reports together', async () => {
  const { win, doc } = boot();
  let release = null;
  win.OrbitCore.host.call = () => release ? Promise.resolve({ ok: true, changed: 1 }) : new Promise(r => { release = r; });
  click(win, doc.querySelector('#orbitRightDock [data-dock-action="fill"]'));
  await flush();
  assert.ok(doc.querySelector('[data-dock-action="cut-at-playhead"]').disabled,
    'the rest of the rail stayed live while one control was working');
  release({ ok: true, changed: 2 });
  for (let i = 0; i < 12; i++) await flush();
  assert.equal(doc.querySelector('[data-dock-action="cut-at-playhead"]').disabled, false);
  assert.match(doc.getElementById('orbitDockStatus').textContent, /Filled the frame/);
});

// The header is the product name and nothing else. The Core badge used to sit
// there and read as a stray green dot; it moved to Project Doctor's action
// row, which is the one thing that must not silently break, since the badge is
// the only way into the Core drawer.
test('The header carries no status chrome, and Core status is still reachable', () => {
  const { doc } = boot();
  const header = doc.querySelector('.orbit-shell-header');
  assert.ok(header, 'header missing');
  assert.equal(header.querySelector('.orbit-host-status'), null, 'HOST READY is still in the header');
  assert.equal(header.textContent.replace(/\s+/g, ' ').trim(), 'Orbit PremierePRO STUDIO SUITE');

  const core = fs.readFileSync(path.join(root, 'utils/orbitCore.js'), 'utf8');
  const mount = core.slice(core.indexOf('function initUi()'), core.indexOf('var drawer = document.createElement'));
  assert.match(mount, /pd-actions/, 'the Core badge no longer targets the Doctor action row');
  assert.ok(doc.querySelector('.pd-actions'), 'the Doctor action row it mounts into is gone from index.html');
  assert.ok(doc.querySelector('#pdDiagnostic'), 'the Diagnostic button it sits beside is gone');
});

test('Retired Tools panel controls are gone but the dock still works', () => {
  const { win, doc, calls } = boot();
  for (const id of ['composerToolsView', 'composerToolsPanel', 'punchView']) {
    assert.equal(doc.getElementById(id), null, id + ' should have been removed');
  }
  // Motion came back as its own rail, so it must exist again.
  assert.ok(doc.getElementById('motionView'), 'motionView should exist');
  calls.length = 0;
  click(win, doc.querySelector('[data-dock-action="color-matte"]'));
  assert.equal(calls[0].name, 'getActiveSequenceSpec');
});

(async () => {
  for (const item of queue) {
    await item.fn();
    count++;
    console.log('PASS ' + item.name);
  }
  console.log(count + ' dock wiring tests passed; real Premiere behavior remains unverified.');
})().catch(error => { console.error('FAIL ' + error.message); process.exitCode = 1; });
