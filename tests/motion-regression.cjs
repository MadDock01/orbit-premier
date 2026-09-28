// Motion Lab: curve maths (pure), the host keyframe endpoints (production JSX
// against simulated Premiere objects), and the panel wiring (real index.html).
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const acorn = require('./dev-require.cjs')('acorn');
const source = fs.readFileSync(path.join(root, 'jsx/hostscript.jsx'), 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 2022, allowReturnOutsideFunction: true });
function load(ctx, names) {
  vm.createContext(ctx);
  for (const name of names) {
    const fn = ast.body.find(x => x.type === 'FunctionDeclaration' && x.id.name === name);
    assert.ok(fn, 'missing host function: ' + name);
    vm.runInContext(source.slice(fn.start, fn.end), ctx);
  }
  return ctx;
}
let count = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const Curves = require(path.join(root, 'modules/motion-curves.js'));
const Loop = require(path.join(root, 'modules/motion-loop.js'));

// ── Curve maths ─────────────────────────────────────────────────────────────
test('Every curve starts at 0 and ends at 1, whatever the knobs', () => {
  for (const shape of Curves.shapes)
    for (const dir of ['in', 'out', 'inOut'])
      for (const strength of [0, 0.5, 1, 2])
        for (const decay of [0, 0.5, 1]) {
          const e = Curves.easing(shape, dir, strength, decay);
          assert.ok(Math.abs(e(0)) < 1e-9, `${shape}/${dir} s${strength} d${decay} starts at ${e(0)}`);
          assert.ok(Math.abs(e(1) - 1) < 1e-9, `${shape}/${dir} s${strength} d${decay} ends at ${e(1)}`);
        }
});
test('Strength 0 is a straight line for every shape', () => {
  for (const shape of Curves.shapes) {
    const e = Curves.easing(shape, 'out', 0, 1);
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) assert.ok(Math.abs(e(t) - t) < 1e-9, shape + ' at strength 0 bends');
  }
});
test('Strength actually changes the curve', () => {
  for (const shape of Curves.shapes.filter(s => s !== 'linear')) {
    const a = Curves.easing(shape, 'out', 0.25), b = Curves.easing(shape, 'out', 1);
    const moved = [0.1, 0.25, 0.5, 0.75, 0.9].some(t => Math.abs(a(t) - b(t)) > 1e-6);
    assert.ok(moved, shape + ' ignores strength');
  }
});
test('Ease-out front-loads and ease-in back-loads', () => {
  assert.ok(Curves.easing('cubic', 'out', 1)(0.25) > 0.25, 'ease-out should be ahead at a quarter');
  assert.ok(Curves.easing('cubic', 'in', 1)(0.25) < 0.25, 'ease-in should be behind at a quarter');
  const io = Curves.easing('cubic', 'inOut', 1);
  assert.ok(Math.abs(io(0.5) - 0.5) < 1e-9, 'ease-both should be symmetric at the midpoint');
});
test('Back and elastic overshoot; the plain curves never do', () => {
  const probe = f => { let hi = 0; for (let i = 0; i <= 100; i++) hi = Math.max(hi, f(i / 100)); return hi; };
  assert.ok(probe(Curves.easing('back', 'out', 1)) > 1.01, 'back should overshoot');
  assert.ok(probe(Curves.easing('elastic', 'out', 1)) > 1.01, 'elastic should overshoot');
  for (const shape of ['sine', 'quad', 'cubic', 'quart', 'quint', 'circ'])
    assert.ok(probe(Curves.easing(shape, 'out', 1)) <= 1 + 1e-9, shape + ' should not overshoot');
});
test('Bounce decay tames the bounces without moving the ends', () => {
  const full = Curves.easing('bounce', 'out', 1, 1), tame = Curves.easing('bounce', 'out', 1, 0);
  const wobble = f => { let w = 0, prev = f(0); for (let i = 1; i <= 100; i++) { const v = f(i / 100); if (v < prev) w++; prev = v; } return w; };
  assert.ok(wobble(full) > wobble(tame), 'decay 1 should wobble more than decay 0');
  assert.ok(Math.abs(tame(0)) < 1e-9 && Math.abs(tame(1) - 1) < 1e-9);
});

// ── Baking ──────────────────────────────────────────────────────────────────
test('A baked span keeps both original keyframes exactly', () => {
  const r = Curves.bakeSpan({ from: { t: 0, v: 0 }, to: { t: 1, v: 100 } },
    { shape: 'cubic', dir: 'out', strength: 1, fps: 30, intervalFrames: 1 });
  assert.equal(r.keys.length, 31);
  assert.deepEqual(r.keys[0], { t: 0, v: 0 });
  assert.equal(r.keys[r.keys.length - 1].t, 1);
  assert.equal(r.keys[r.keys.length - 1].v, 100);
});
test('The bake interval controls how many keyframes are written', () => {
  const opts = f => ({ shape: 'cubic', dir: 'out', fps: 30, intervalFrames: f });
  const one = Curves.bakeSpan({ from: { t: 0, v: 0 }, to: { t: 1, v: 100 } }, opts(1)).keys.length;
  const five = Curves.bakeSpan({ from: { t: 0, v: 0 }, to: { t: 1, v: 100 } }, opts(5)).keys.length;
  assert.ok(one > five, 'a finer interval must produce more keys');
  assert.equal(five, 7);
});
test('A runaway span is capped instead of flooding the timeline', () => {
  const r = Curves.bakeSpan({ from: { t: 0, v: 0 }, to: { t: 3600, v: 100 } },
    { shape: 'cubic', dir: 'out', fps: 60, intervalFrames: 1 });
  assert.ok(r.dropped, 'should report that it capped');
  assert.ok(r.keys.length <= Curves.MAX_KEYS + 1, 'wrote ' + r.keys.length + ' keys');
});
test('Multi-component values like Position interpolate per axis', () => {
  const r = Curves.bakeSpan({ from: { t: 0, v: [0, 100] }, to: { t: 1, v: [200, 300] } },
    { shape: 'linear', dir: 'out', fps: 10, intervalFrames: 5 });
  const mid = r.keys[1];
  assert.ok(Array.isArray(mid.v) && mid.v.length === 2);
  assert.ok(Math.abs(mid.v[0] - 100) < 1e-6 && Math.abs(mid.v[1] - 200) < 1e-6, JSON.stringify(mid));
});
test('A multi-key series bakes without duplicating the joins', () => {
  const keys = Curves.bakeSeries([0, 1, 2], [0, 50, 0], { shape: 'cubic', dir: 'inOut', fps: 10, intervalFrames: 5 });
  const times = keys.map(k => k.t);
  assert.deepEqual(times, [...new Set(times)], 'a boundary key was written twice');
  assert.equal(times[0], 0);
  assert.equal(times[times.length - 1], 2);
});

// ── Looping ─────────────────────────────────────────────────────────────────
const loopOf = o => Loop.buildLoop(Object.assign({ epsilon: 1 / 30 }, o)).keys.map(k => [Number(k.t.toFixed(3)), k.v]);

test('A cycle snaps back to the start instead of holding the last value', () => {
  const keys = loopOf({ times: [0, 1], values: [0, 100], type: 'cycle', until: 3 });
  // The reset key is what makes it a loop; without it the property just sits at 100.
  assert.deepEqual(keys, [[1.033, 0], [2, 100], [2.033, 0], [3, 100]]);
});
test('Ping-pong retraces the unit and needs no reset key', () => {
  assert.deepEqual(loopOf({ times: [0, 1], values: [0, 100], type: 'pingpong', until: 4 }),
    [[2, 0], [3, 100], [4, 0]]);
});
test('Ping-pong mirrors a multi-key unit rather than re-sorting it', () => {
  assert.deepEqual(loopOf({ times: [0, 0.5, 1], values: [0, 80, 20], type: 'pingpong', until: 3 }),
    [[1.5, 80], [2, 0], [2.5, 80], [3, 20]]);
});
test('Offset accumulates the net change and stays continuous', () => {
  assert.deepEqual(loopOf({ times: [0, 1], values: [0, 100], type: 'offset', until: 4 }),
    [[2, 200], [3, 300], [4, 400]]);
});
test('Loop in runs backwards and reverses the offset sign', () => {
  assert.deepEqual(loopOf({ times: [2, 3], values: [0, 100], type: 'offset', direction: 'in', until: 0 }),
    [[0, -200], [1, -100]]);
});
test('Loop in cycles back towards the clip head', () => {
  const keys = loopOf({ times: [2, 3], values: [0, 100], type: 'cycle', direction: 'in', until: 0 });
  assert.ok(keys.every(([t]) => t >= 0 && t < 2), 'loop-in keys must sit before the unit: ' + JSON.stringify(keys));
  assert.deepEqual(keys.map(k => k[0]), [...keys.map(k => k[0])].sort((a, b) => a - b), 'keys must ascend');
  assert.deepEqual(keys, [[0, 0], [0.967, 100], [1, 0], [1.967, 100]]);
});
test('Offset loops multi-component values per axis', () => {
  assert.deepEqual(loopOf({ times: [0, 1], values: [[0, 0], [100, 50]], type: 'offset', until: 2 }),
    [[2, [200, 100]]]);
});
test('A loop with nowhere to go produces nothing rather than erroring', () => {
  for (const dir of ['out', 'in'])
    assert.deepEqual(Loop.buildLoop({ times: [0, 1], values: [0, 1], type: 'cycle', direction: dir, until: dir === 'out' ? 1 : 0.5 }).keys.length, 0);
  assert.equal(Loop.buildLoop({ times: [0], values: [0], type: 'cycle', until: 9 }).keys.length, 0);
});
test('A runaway loop is capped', () => {
  const r = Loop.buildLoop({ times: [0, 0.01], values: [0, 1], type: 'cycle', until: 99999, epsilon: 0.001 });
  assert.ok(r.capped);
  assert.ok(r.keys.length <= Loop.MAX_KEYS);
});
test('The loop unit is taken from the end for out and the start for in', () => {
  assert.deepEqual(Loop.selectUnit([0, 1, 2, 3], [10, 20, 30, 40], 2, 'out'), { times: [2, 3], values: [30, 40] });
  assert.deepEqual(Loop.selectUnit([0, 1, 2, 3], [10, 20, 30, 40], 2, 'in'), { times: [0, 1], values: [10, 20] });
  assert.deepEqual(Loop.selectUnit([0, 1], [10, 20], 0, 'out'), { times: [0, 1], values: [10, 20] });
});

// ── Host endpoints ──────────────────────────────────────────────────────────
const HOST = ['_motionProp', '_motionKeyable', '_motionKeyTimes', '_motionReadAt', '_motionWriteAt',
  '_motionRemoveRange', 'motionMakeTime', 'motionSourceTime', 'motionClipRelative',
  'motionInspectKeyframes', 'motionReadKeyValues', 'motionSampleValues', 'motionBakeKeys', 'motionEditKeys'];

function collection(items) { Object.defineProperty(items, 'numItems', { get() { return this.length; }, configurable: true }); return items; }
function makeProp(name, keys) {
  const store = new Map(Object.entries(keys || {}).map(([t, v]) => [Number(t), v]));
  return {
    displayName: name, varying: store.size > 0, interp: [],
    areKeyframesSupported: () => true,
    isTimeVarying() { return this.varying; },
    setTimeVarying(v) { this.varying = !!v; },
    getKeys() { return collection([...store.keys()].sort((a, b) => a - b).map(s => ({ seconds: s }))); },
    getValueAtKey(t) { const v = store.get(Number(t.seconds)); return v === undefined ? null : v; },
    // Stands in for Premiere's interpolated read. Deliberately NOT linear, so a
    // test can tell sampling apart from lerping between the stored keys.
    getValueAtTime(t) {
      const ks = [...store.keys()].sort((a, b) => a - b), x = Number(t.seconds);
      if (!ks.length) return null;
      if (x <= ks[0]) return store.get(ks[0]);
      if (x >= ks[ks.length - 1]) return store.get(ks[ks.length - 1]);
      for (let i = 0; i < ks.length - 1; i++) if (x >= ks[i] && x <= ks[i + 1]) {
        const k = (x - ks[i]) / (ks[i + 1] - ks[i]), a = store.get(ks[i]), b = store.get(ks[i + 1]);
        return a + (b - a) * (k * k);            // quadratic ease-in
      }
      return null;
    },
    addKey(t) { if (!store.has(Number(t.seconds))) store.set(Number(t.seconds), 0); },
    setValueAtKey(t, v) { store.set(Number(t.seconds), v); return 0; },
    removeKeyRange(a, b) { for (const k of [...store.keys()]) if (k >= a.seconds && k <= b.seconds) store.delete(k); },
    setInterpolationTypeAtKey(t, type) { this.interp.push([Number(t.seconds), type]); },
    _store: store
  };
}
function clipFixture(props, opts = {}) {
  const inPoint = opts.inPoint === undefined ? 5 : opts.inPoint;
  const clip = {
    name: 'Shot', start: { seconds: 10 }, end: { seconds: 14 }, inPoint: { seconds: inPoint },
    components: collection([{ displayName: 'Motion', properties: collection(props) }])
  };
  const seq = {
    timebase: String(Math.round(254016000000 / 30)), getSelection: () => [clip],
    getPlayerPosition: () => ({ seconds: opts.playhead === undefined ? 12 : opts.playhead })
  };
  const ctx = load({
    app: { beginUndoGroup() {}, endUndoGroup() {} },
    getActiveSequence: () => seq,
    Time: function Time() { this.seconds = 0; this.ticks = '0'; },
    JSON, Math, Number, String, isNaN, isFinite, parseInt, console
  }, HOST);
  return { ctx, clip, props };
}

test('Inspection reports keys clip-relative, not in source time', () => {
  const scale = makeProp('Scale', { 5: 100, 6: 150 });   // source time, inPoint 5
  const { ctx } = clipFixture([scale]);
  const res = JSON.parse(ctx.motionInspectKeyframes());
  assert.equal(res.ok, true);
  assert.equal(res.fps, 30);
  const prop = res.clips[0].properties[0];
  assert.equal(prop.animated, true);
  assert.deepEqual(prop.keys, [0, 1], 'keys must be reported relative to the clip, got ' + JSON.stringify(prop.keys));
});
test('A property with no keyframes is listed but not marked animated', () => {
  const { ctx } = clipFixture([makeProp('Opacity', null)]);
  const prop = JSON.parse(ctx.motionInspectKeyframes()).clips[0].properties[0];
  assert.equal(prop.animated, false);
  assert.deepEqual(prop.keys, []);
});
test('Reading key values returns matched times and values', () => {
  const { ctx } = clipFixture([makeProp('Scale', { 5: 100, 6: 150 })]);
  const res = JSON.parse(ctx.motionReadKeyValues(JSON.stringify({ clipIndex: 0, component: 0, property: 0 })));
  assert.deepEqual(res.times, [0, 1]);
  assert.deepEqual(res.values, [100, 150]);
});
test('A single keyframe is refused rather than baked into nothing', () => {
  const { ctx } = clipFixture([makeProp('Scale', { 5: 100 })]);
  const res = JSON.parse(ctx.motionReadKeyValues(JSON.stringify({ clipIndex: 0, component: 0, property: 0 })));
  assert.match(res.error, /at least two keyframes/);
});
test('Baking clears the old span, writes clip-relative keys at source time, and forces linear', () => {
  const scale = makeProp('Scale', { 5: 100, 5.5: 999, 6: 150 });
  const { ctx } = clipFixture([scale]);
  const keys = [{ t: 0, v: 100 }, { t: 0.5, v: 120 }, { t: 1, v: 150 }];
  const res = JSON.parse(ctx.motionBakeKeys(JSON.stringify({
    entries: [{ clipIndex: 0, component: 0, property: 0, replaceFrom: 0, replaceTo: 1, keys }]
  })));
  assert.equal(res.ok, true);
  assert.equal(res.keys, 3);
  // inPoint is 5, so clip-relative 0/0.5/1 must land on source 5/5.5/6.
  assert.deepEqual([...scale._store.keys()].sort((a, b) => a - b), [5, 5.5, 6]);
  assert.equal(scale._store.get(5.5), 120, 'the stale 999 key should have been replaced');
  assert.equal(scale.interp.length, 3, 'every baked key should be set linear');
  assert.ok(scale.interp.every(([, type]) => type === 0));
});
test('Baking a clip that is no longer selected reports it instead of throwing', () => {
  const { ctx } = clipFixture([makeProp('Scale', { 5: 100, 6: 150 })]);
  const res = JSON.parse(ctx.motionBakeKeys(JSON.stringify({
    entries: [{ clipIndex: 9, component: 0, property: 0, keys: [{ t: 0, v: 1 }] }]
  })));
  assert.match(res.error, /no longer selected/);
});
test('Shift moves every key and leaves none behind', () => {
  const scale = makeProp('Scale', { 5: 100, 6: 150 });
  const { ctx } = clipFixture([scale]);
  const res = JSON.parse(ctx.motionEditKeys(JSON.stringify({
    op: 'shift', offset: 0.5, entries: [{ clipIndex: 0, component: 0, property: 0 }]
  })));
  assert.equal(res.ok, true);
  assert.deepEqual([...scale._store.keys()].sort((a, b) => a - b), [5.5, 6.5]);
  assert.equal(scale._store.get(5.5), 100);
  assert.equal(scale._store.get(6.5), 150);
});
test('Swap exchanges the end values and keeps the times', () => {
  const scale = makeProp('Scale', { 5: 100, 5.5: 130, 6: 150 });
  const { ctx } = clipFixture([scale]);
  JSON.parse(ctx.motionEditKeys(JSON.stringify({ op: 'swap', entries: [{ clipIndex: 0, component: 0, property: 0 }] })));
  assert.deepEqual([...scale._store.keys()].sort((a, b) => a - b), [5, 5.5, 6]);
  assert.equal(scale._store.get(5), 150);
  assert.equal(scale._store.get(6), 100);
  assert.equal(scale._store.get(5.5), 130, 'the middle key must not move');
});
test('Clear removes the keyframes in range', () => {
  const scale = makeProp('Scale', { 5: 100, 6: 150 });
  const { ctx } = clipFixture([scale]);
  const res = JSON.parse(ctx.motionEditKeys(JSON.stringify({ op: 'clear', entries: [{ clipIndex: 0, component: 0, property: 0 }] })));
  assert.equal(res.ok, true);
  assert.equal(scale._store.size, 0);
});
test('An unknown keyframe operation is refused', () => {
  const { ctx } = clipFixture([makeProp('Scale', { 5: 100, 6: 150 })]);
  assert.match(JSON.parse(ctx.motionEditKeys(JSON.stringify({ op: 'explode', entries: [{ clipIndex: 0, component: 0, property: 0 }] }))).error, /Unknown keyframe operation/);
});
test('Inspection reports the playhead clip-relative too', () => {
  const { ctx } = clipFixture([makeProp('Scale', { 5: 100, 6: 150 })], { playhead: 12 });
  // clip.start is 10, so a playhead at 12s is 2s into the clip.
  assert.equal(JSON.parse(ctx.motionInspectKeyframes()).clips[0].playhead, 2);
});
test('Sampling captures the shape between keys, not a straight line', () => {
  const { ctx } = clipFixture([makeProp('Scale', { 5: 0, 6: 100 })]);
  const res = JSON.parse(ctx.motionSampleValues(JSON.stringify({
    clipIndex: 0, component: 0, property: 0, from: 0, to: 1, step: 0.25
  })));
  assert.deepEqual(res.times, [0, 0.25, 0.5, 0.75, 1]);
  // A linear read would give 50 at the midpoint; the eased shape gives 25.
  assert.equal(res.values[2], 25);
  assert.equal(res.values[0], 0);
  assert.equal(res.values[4], 100);
});
test('An empty sample range is refused', () => {
  const { ctx } = clipFixture([makeProp('Scale', { 5: 0, 6: 100 })]);
  assert.match(JSON.parse(ctx.motionSampleValues(JSON.stringify({
    clipIndex: 0, component: 0, property: 0, from: 1, to: 1, step: 0.1
  }))).error, /Empty sample range/);
});
test('motionMakeTime never mutates the clip boundary', () => {
  const { ctx, clip } = clipFixture([makeProp('Scale', { 5: 100, 6: 150 })]);
  const before = clip.start.seconds;
  ctx.motionMakeTime(clip, 99);
  ctx.motionSourceTime(clip, 99);
  assert.equal(clip.start.seconds, before, 'building a timestamp moved the clip');
});

(async () => {
  for (const item of queue) { await item.fn(); count++; console.log('PASS ' + item.name); }
  console.log(count + ' motion tests passed; real Premiere behavior remains unverified.');
})().catch(err => { console.error('FAIL ' + err.message); process.exitCode = 1; });
