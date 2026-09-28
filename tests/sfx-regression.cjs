// SFX Studio: the DSP, the local index, and the view's wiring.
// The DSP and the index are pure, so they run here for real; the view is
// driven in jsdom against the production index.html.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const D = require(path.resolve(root, 'modules/sfx-dsp.js'));
const L = require(path.resolve(root, 'modules/sfx-library.js'));

const SR = 48000;
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }

function sine(hz, seconds, amp) {
  const n = Math.round(SR * seconds), a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (amp === undefined ? 0.5 : amp) * Math.sin(2 * Math.PI * hz * i / SR);
  return D.clip(SR, [a]);
}
function stereo(hz, seconds) {
  const l = sine(hz, seconds, 0.5).channels[0], r = sine(hz, seconds, 0.25).channels[0];
  return D.clip(SR, [l, r]);
}
// Pitch over the middle of the signal. Zero-crossing counting is unreliable on
// overlap-added output, but plain autocorrelation is worse: for a periodic
// signal the correlation at TWICE the period scores as high as at the period,
// so taking the global maximum reports an octave too low - it returned 440 for
// a pure 880Hz tone. Take the FIRST strong local maximum instead, and refine it
// with parabolic interpolation so a few cents are actually measurable.
function pitchOf(ch) {
  const start = Math.max(0, Math.floor(ch.length / 2) - 6000), N = Math.min(12000, ch.length - start);
  const seg = ch.slice(start, start + N);
  const minLag = Math.floor(SR / 2000), maxLag = Math.floor(SR / 80);
  const r = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let acc = 0;
    for (let i = 0; i < N - lag; i++) acc += seg[i] * seg[i + lag];
    r[lag] = acc / (N - lag);
  }
  if (!(r[0] > 0)) return 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const norm = r[lag] / r[0];
    if (norm > 0.8 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      const denom = 2 * (2 * r[lag] - r[lag - 1] - r[lag + 1]);
      const shift = denom === 0 ? 0 : (r[lag + 1] - r[lag - 1]) / denom;
      return SR / (lag + shift);
    }
  }
  return 0;
}
const cents = (a, b) => 1200 * Math.log2(a / b);

// ── Level ───────────────────────────────────────────────────────────────────
test('Gain in dB scales by the right factor, and 0 dB is a no-op', () => {
  assert.ok(Math.abs(D.peak(D.gain(sine(440, 0.2), 6)) - 0.5 * Math.pow(10, 6 / 20)) < 1e-4);
  assert.ok(Math.abs(D.peak(D.gain(sine(440, 0.2), -6)) - 0.5 * Math.pow(10, -6 / 20)) < 1e-4);
  const src = sine(440, 0.2), same = D.gain(src, 0);
  for (let i = 0; i < src.channels[0].length; i += 97) assert.equal(same.channels[0][i], src.channels[0][i]);
});
test('Normalise lands the peak on the target, whatever it started at', () => {
  for (const startAmp of [0.02, 0.5, 0.95]) {
    for (const target of [-1, -3, -12]) {
      const p = D.peak(D.normalize(sine(440, 0.2, startAmp), target));
      assert.ok(Math.abs(20 * Math.log10(p) - target) < 0.01, `amp ${startAmp} -> ${target}dB gave ${(20 * Math.log10(p)).toFixed(2)}`);
    }
  }
});
test('Normalise keeps the stereo balance', () => {
  const out = D.normalize(stereo(440, 0.2), -1);
  const ratio = D.peak(D.clip(SR, [out.channels[0]])) / D.peak(D.clip(SR, [out.channels[1]]));
  assert.ok(Math.abs(ratio - 2) < 1e-3, 'left/right ratio drifted to ' + ratio);
});
test('Normalising silence does not divide by zero', () => {
  const quiet = D.clip(SR, [new Float32Array(1000)]);
  const out = D.normalize(quiet, -1);
  assert.equal(D.peak(out), 0);
  assert.equal(D.lengthOf(out), 1000);
});

// ── Time ────────────────────────────────────────────────────────────────────
test('Reverse twice returns the original', () => {
  const src = sine(440, 0.2), back = D.reverse(D.reverse(src));
  for (let i = 0; i < src.channels[0].length; i++) assert.equal(back.channels[0][i], src.channels[0][i]);
});
test('Fades start and end at silence and use an equal-power curve', () => {
  const out = D.fade(sine(440, 0.5), 100, 100).channels[0];
  assert.ok(Math.abs(out[0]) < 1e-6);
  assert.ok(Math.abs(out[out.length - 1]) < 1e-6);
  // Halfway through a 100ms fade an equal-power curve sits at sin(45deg) = .707,
  // not at .5 as a linear ramp would.
  const src = sine(440, 0.5).channels[0], mid = Math.round(0.05 * SR);
  let ratio = 0;
  for (let i = mid - 50; i < mid + 50; i++) if (Math.abs(src[i]) > 0.2) { ratio = out[i] / src[i]; break; }
  assert.ok(Math.abs(ratio - Math.SQRT1_2) < 0.05, 'fade midpoint ratio was ' + ratio.toFixed(3));
});
test('A fade longer than the clip does not run off the end', () => {
  const out = D.fade(sine(440, 0.05), 5000, 5000);
  assert.equal(D.lengthOf(out), Math.round(0.05 * SR));
  assert.ok(out.channels[0].every(v => isFinite(v)));
});

// ── Rate ────────────────────────────────────────────────────────────────────
test('Resampling moves pitch and duration together, like tape', () => {
  const half = D.resample(sine(440, 1), 0.5);
  assert.equal(D.lengthOf(half), SR / 2);
  assert.ok(Math.abs(cents(pitchOf(half.channels[0]), 880)) < 15, 'expected an octave up');
  const dbl = D.resample(sine(440, 1), 2);
  assert.equal(D.lengthOf(dbl), SR * 2);
  assert.ok(Math.abs(cents(pitchOf(dbl.channels[0]), 220)) < 15, 'expected an octave down');
});
test('Time stretch changes duration and leaves pitch alone', () => {
  for (const ratio of [0.5, 1.5, 2]) {
    const out = D.timeStretch(sine(440, 2), ratio);
    assert.ok(Math.abs(D.lengthOf(out) - SR * 2 * ratio) < SR * 0.02, 'length wrong at ratio ' + ratio);
    const off = cents(pitchOf(out.channels[0]), 440);
    assert.ok(Math.abs(off) < 25, `ratio ${ratio} shifted pitch by ${off.toFixed(0)} cents`);
  }
});
test('Time stretch at 1.0 is a passthrough', () => {
  const src = sine(440, 0.3), out = D.timeStretch(src, 1);
  assert.equal(D.lengthOf(out), D.lengthOf(src));
  for (let i = 0; i < src.channels[0].length; i += 97) assert.equal(out.channels[0][i], src.channels[0][i]);
});
test('Time stretch keeps channels aligned', () => {
  // Both channels must use the same alignment offset or the image smears.
  const out = D.timeStretch(stereo(440, 1), 1.5);
  assert.equal(out.channels.length, 2);
  assert.equal(out.channels[0].length, out.channels[1].length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < out.channels[0].length; i++) {
    dot += out.channels[0][i] * out.channels[1][i];
    na += out.channels[0][i] ** 2; nb += out.channels[1][i] ** 2;
  }
  assert.ok(dot / Math.sqrt(na * nb) > 0.95, 'channels drifted apart');
});

// ── The rack ────────────────────────────────────────────────────────────────
test('Unlocked pitch moves speed with it', () => {
  const out = D.process(sine(440, 1), { semitones: 12, lockPitch: false });
  assert.ok(Math.abs(cents(pitchOf(out.channels[0]), 880)) < 15, 'should be an octave up');
  assert.ok(Math.abs(D.lengthOf(out) - SR / 2) < SR * 0.02, 'should also be half as long');
});
test('Locked pitch separates the two controls', () => {
  // +12 semitones at normal speed: pitch doubles, duration does not change.
  const up = D.process(sine(440, 2), { semitones: 12, speed: 1, lockPitch: true });
  assert.ok(Math.abs(cents(pitchOf(up.channels[0]), 880)) < 30, 'pitch should be an octave up');
  assert.ok(Math.abs(D.lengthOf(up) - SR * 2) < SR * 0.05, 'duration should hold');

  // Half speed at normal pitch: duration doubles, pitch does not move.
  const slow = D.process(sine(440, 2), { semitones: 0, speed: 0.5, lockPitch: true });
  assert.ok(Math.abs(cents(pitchOf(slow.channels[0]), 440)) < 30, 'pitch should hold');
  assert.ok(Math.abs(D.lengthOf(slow) - SR * 4) < SR * 0.1, 'duration should double');
});
test('Normalise runs last so nothing pushes the peak back over', () => {
  const out = D.process(sine(440, 0.3, 0.1), { gainDb: 24, normalize: true, normalizeDb: -1 });
  assert.ok(Math.abs(20 * Math.log10(D.peak(out)) + 1) < 0.01, 'peak ended at ' + (20 * Math.log10(D.peak(out))).toFixed(2));
});
test('An empty rack returns the audio untouched', () => {
  const src = sine(440, 0.2), out = D.process(src, {});
  assert.equal(D.lengthOf(out), D.lengthOf(src));
  for (let i = 0; i < src.channels[0].length; i += 97) assert.equal(out.channels[0][i], src.channels[0][i]);
});

// ── Selection and drawing ───────────────────────────────────────────────────
test('Slice takes the requested range and clamps out-of-range asks', () => {
  const src = sine(440, 1);
  assert.equal(D.lengthOf(D.slice(src, 0, SR / 2)), SR / 2);
  assert.equal(D.lengthOf(D.slice(src, -500, SR * 99)), SR);
  assert.equal(D.lengthOf(D.slice(src, SR / 2, SR / 4)), 0, 'a reversed range should be empty, not negative');
});
test('Waveform peaks bracket the real signal', () => {
  const p = D.peaks(sine(440, 1).channels[0], 200);
  assert.equal(p.length, 400);
  for (let b = 0; b < 200; b++) assert.ok(p[b * 2] <= p[b * 2 + 1], 'min above max in bucket ' + b);
  let lo = 0, hi = 0;
  for (let i = 0; i < p.length; i += 2) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i + 1]); }
  assert.ok(Math.abs(hi - 0.5) < 0.01 && Math.abs(lo + 0.5) < 0.01);
});

// ── WAV ─────────────────────────────────────────────────────────────────────
function readWav(buf) {
  const v = new DataView(buf), str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  return {
    riff: str(0, 4), wave: str(8, 4), fmt: str(12, 4), data: str(36, 4),
    format: v.getUint16(20, true), channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true), byteRate: v.getUint32(28, true),
    blockAlign: v.getUint16(32, true), bits: v.getUint16(34, true),
    dataBytes: v.getUint32(40, true), riffSize: v.getUint32(4, true), total: buf.byteLength
  };
}
test('The WAV header is well formed 24-bit PCM', () => {
  const h = readWav(D.encodeWav(stereo(440, 0.5)));
  assert.equal(h.riff, 'RIFF'); assert.equal(h.wave, 'WAVE');
  assert.equal(h.fmt, 'fmt '); assert.equal(h.data, 'data');
  assert.equal(h.format, 1); assert.equal(h.bits, 24);
  assert.equal(h.channels, 2); assert.equal(h.sampleRate, SR);
  assert.equal(h.blockAlign, 6);
  assert.equal(h.byteRate, SR * 6);
  assert.equal(h.dataBytes, Math.round(SR * 0.5) * 6);
  assert.equal(h.riffSize, h.total - 8, 'RIFF size must be the file size minus 8');
  assert.equal(h.total, 44 + h.dataBytes);
});
test('WAV samples survive a round trip', () => {
  const src = sine(440, 0.1);
  const buf = D.encodeWav(src), v = new DataView(buf);
  for (let i = 0; i < 200; i++) {
    const off = 44 + i * 3;
    let s = v.getUint8(off) | (v.getUint8(off + 1) << 8) | (v.getUint8(off + 2) << 16);
    if (s & 0x800000) s |= ~0xffffff;               // sign-extend 24-bit
    assert.ok(Math.abs(s / 8388607 - src.channels[0][i]) < 1e-5, 'sample ' + i + ' drifted');
  }
});
test('Encoding clamps instead of wrapping around', () => {
  // A sample above 1.0 must pin to full scale. Wrapping would turn the loudest
  // part of a hot clip into a full-scale inversion, which is a vicious click.
  const hot = D.clip(SR, [Float32Array.from([2, -2, 0.5])]);
  const v = new DataView(D.encodeWav(hot));
  const read = i => {
    const off = 44 + i * 3;
    let s = v.getUint8(off) | (v.getUint8(off + 1) << 8) | (v.getUint8(off + 2) << 16);
    if (s & 0x800000) s |= ~0xffffff;
    return s;
  };
  assert.equal(read(0), 8388607);
  assert.equal(read(1), -8388607);
  assert.ok(read(2) > 0 && read(2) < 8388607);
});


// ---------------------------------------------------------------------------
// The local index. A fake tree, so the scanner's real decisions — what counts
// as audio, how deep to walk, what a rescan keeps — are exercised without
// touching a disk.
// ---------------------------------------------------------------------------

function tree(files, dirs) {
  const listing = {}, stats = {};
  for (const dir of Object.keys(dirs)) { listing[dir] = dirs[dir]; stats[dir] = { dir: true }; }
  for (const f of Object.keys(files)) stats[f] = files[f];
  return {
    fs: {
      readdirSync: p => listing[p] || [],
      statSync: p => {
        const s = stats[p];
        if (!s) throw new Error('ENOENT ' + p);
        return { isDirectory: () => !!s.dir, size: s.size || 0, mtimeMs: s.m || 0 };
      }
    },
    path: { join: (a, b) => a + '/' + b, dirname: p => p.slice(0, p.lastIndexOf('/')) }
  };
}

function memory() {
  const cells = {};
  return { getItem: k => (k in cells ? cells[k] : null), setItem: (k, v) => { cells[k] = String(v); }, cells };
}

function fixture() {
  const t = tree(
    { '/lib/a.wav': { size: 10, m: 1 }, '/lib/notes.txt': { size: 1, m: 2 },
      '/lib/.DS_Store': { size: 1, m: 3 }, '/lib/sub/door-wood-slam.wav': { size: 3, m: 4 },
      '/lib/sub/room-tone.wav': { size: 4, m: 5 } },
    { '/lib': ['a.wav', 'notes.txt', '.DS_Store', 'sub'], '/lib/sub': ['door-wood-slam.wav', 'room-tone.wav'] });
  const storage = memory();
  const lib = L.create({ fs: t.fs, path: t.path, storage });
  return { lib, storage, t };
}

test('A scan takes audio, skips everything else, and walks subfolders', () => {
  const { lib } = fixture();
  const added = lib.addFolder('/lib');
  assert.equal(added.added, 3, 'expected three sounds');
  const names = lib.all().map(i => i.name).sort();
  assert.deepEqual(names, ['a.wav', 'door-wood-slam.wav', 'room-tone.wav']);
});

test('A folder already covered by an indexed parent is refused', () => {
  const { lib } = fixture();
  lib.addFolder('/lib');
  assert.match(lib.addFolder('/lib/sub').error, /already covered/);
  assert.match(lib.addFolder('/lib').error, /already in the library/);
  assert.equal(lib.folders().length, 1);
});

// A scan reads no audio, so duration arrives later, from the studio. Sorting
// and the one-shot filter have to cope with it being absent.
test('Unmeasured durations sort last instead of as zero', () => {
  const { lib } = fixture();
  lib.addFolder('/lib');
  lib.note('/lib/sub/room-tone.wav', { duration: 30 });
  lib.note('/lib/sub/door-wood-slam.wav', { duration: 0.8 });
  const order = lib.query({ sort: 'duration' }).map(i => i.name);
  assert.deepEqual(order, ['door-wood-slam.wav', 'room-tone.wav', 'a.wav'],
    'the unmeasured file must not sort as the shortest');
});

test('One shot and ambience split on duration, and unmeasured is neither', () => {
  const { lib } = fixture();
  lib.addFolder('/lib');
  lib.note('/lib/sub/door-wood-slam.wav', { duration: 0.8 });
  lib.note('/lib/sub/room-tone.wav', { duration: 30 });
  assert.deepEqual(lib.query({ filter: 'oneshot' }).map(i => i.name), ['door-wood-slam.wav']);
  assert.deepEqual(lib.query({ filter: 'ambience' }).map(i => i.name), ['room-tone.wav']);
  assert.equal(lib.query({ filter: 'oneshot' }).concat(lib.query({ filter: 'ambience' }))
    .some(i => i.name === 'a.wav'), false);
});

// Every word has to land somewhere, in any order — which is how anyone
// actually remembers a file they named months ago.
test('Search matches all words, in any order, across name and path', () => {
  const { lib } = fixture();
  lib.addFolder('/lib');
  assert.deepEqual(lib.query({ search: 'wood door' }).map(i => i.name), ['door-wood-slam.wav']);
  assert.deepEqual(lib.query({ search: 'sub room' }).map(i => i.name), ['room-tone.wav'],
    'a word in the folder path should count');
  assert.equal(lib.query({ search: 'door piano' }).length, 0);
});

test('Pinning floats a sound to the top of any sort', () => {
  const { lib } = fixture();
  lib.addFolder('/lib');
  lib.mark('/lib/sub/room-tone.wav', { pinned: true });
  for (const sort of ['name', 'duration', 'label']) {
    assert.equal(lib.query({ sort }).map(i => i.name)[0], 'room-tone.wav', 'sort: ' + sort);
  }
});

// A drive that was offline during a scan must not cost the user their
// markings, and a file they marked must not vanish silently.
test('A rescan keeps marked files as missing and drops unmarked ones', () => {
  const { lib, t } = fixture();
  lib.addFolder('/lib');
  lib.mark('/lib/a.wav', { favorite: true });
  t.fs.readdirSync = p => (p === '/lib' ? ['sub'] : (p === '/lib/sub' ? ['room-tone.wav'] : []));
  const result = lib.rescan();
  assert.equal(result.removed, 1, 'the unmarked door slam should be gone');
  assert.equal(lib.get('/lib/a.wav').missing, true, 'the favourite should be kept and flagged');
  assert.equal(lib.get('/lib/sub/door-wood-slam.wav'), null);
});

// An edited file's measured duration is no longer its duration.
test('A changed mtime clears what was measured from the audio', () => {
  const { lib, t } = fixture();
  lib.addFolder('/lib');
  lib.note('/lib/a.wav', { duration: 5, channels: 2 });
  t.fs.statSync = p => ({ isDirectory: () => p === '/lib' || p === '/lib/sub', size: 10, m: 99, mtimeMs: 99 });
  lib.rescan();
  assert.equal(lib.get('/lib/a.wav').duration, null);
});

test('The index survives a round trip, and a corrupt one does not throw', () => {
  const { lib, storage, t } = fixture();
  lib.addFolder('/lib');
  lib.mark('/lib/a.wav', { favorite: true, label: 'green' });
  const again = L.create({ fs: t.fs, path: t.path, storage });
  assert.equal(again.counts().total, 3);
  assert.equal(again.get('/lib/a.wav').label, 'green');

  storage.cells[L.STORAGE_KEY] = '{not json';
  const broken = L.create({ fs: t.fs, path: t.path, storage });
  assert.equal(broken.counts().total, 0, 'a corrupt index should start clean, not crash');
});

// ---------------------------------------------------------------------------
// The view. jsdom against the real index.html, so a control that exists in the
// markup but reaches nothing is caught here.
// ---------------------------------------------------------------------------
let JSDOM;
try { JSDOM = require('./dev-require.cjs')('jsdom').JSDOM; }
catch (_) { try { JSDOM = require('jsdom').JSDOM; } catch (_2) { JSDOM = null; } }

if (!JSDOM) {
  console.log('SKIP SFX Studio wiring: jsdom is not installed.');
} else {
  const boot = () => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'),
      { runScripts: 'outside-only', pretendToBeVisual: true });
    const win = dom.window;
    const calls = [];
    win.OrbitCore = { host: { call: (name, args) => { calls.push({ name, args }); return Promise.resolve({ ok: true }); } } };
    win.HTMLCanvasElement.prototype.getContext = () => ({
      setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {},
      moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {}, fillText() {},
      set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set font(v) {}, set textBaseline(v) {}
    });
    win.eval(fs.readFileSync(path.join(root, 'modules/sfx-dsp.js'), 'utf8'));
    win.eval(fs.readFileSync(path.join(root, 'modules/sfx-library.js'), 'utf8'));
    win.eval(fs.readFileSync(path.join(root, 'modules/sfx-studio.js'), 'utf8'));
    // jsdom reports readyState 'loading', so the module defers to
    // DOMContentLoaded exactly as it does in the panel. Fire it.
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
    return { win, doc: win.document, calls };
  };

  test('The studio view exists, wires itself, and replaced the old SFX library', () => {
    const { doc } = boot();
    const view = doc.getElementById('sfxStudioView');
    assert.ok(view, 'sfxStudioView missing from index.html');
    assert.equal(view.getAttribute('data-sfxs-wired'), '1');
    assert.equal(doc.getElementById('sfxDesign'), null, 'the old SFX drawer is still in the markup');
    assert.equal(doc.getElementById('libraryTypeTabs'), null, 'the old SFX|MOGRT tab pair is still there');
    for (const id of ['sfxsSearch', 'sfxsList', 'sfxsWave', 'sfxsIn', 'sfxsOut', 'sfxsGain',
      'sfxsPitch', 'sfxsSpeed', 'sfxsLock', 'sfxsReverse', 'sfxsNormalize', 'sfxsTarget']) {
      assert.ok(doc.getElementById(id), id + ' is missing');
    }
  });

  test('Every studio action is a real branch, not a dead attribute', () => {
    const { doc } = boot();
    const src = fs.readFileSync(path.join(root, 'modules/sfx-studio.js'), 'utf8');
    const run = src.slice(src.indexOf('function run(action)'), src.indexOf('if (document.readyState'));
    const actions = [...doc.querySelectorAll('#sfxStudioView [data-sfxs-action]')]
      .map(b => b.getAttribute('data-sfxs-action'));
    assert.ok(actions.length >= 14, 'expected the full control set, saw ' + actions.length);
    for (const action of new Set(actions)) {
      assert.ok(run.indexOf("'" + action + "'") >= 0, action + ' is wired to nothing');
    }
  });

  // The whole point of the view: what you hear is what gets written. Both
  // paths have to go through render(), or preview becomes a lie.
  test('Preview and insert share one definition of the processed sound', () => {
    const src = fs.readFileSync(path.join(root, 'modules/sfx-studio.js'), 'utf8');
    const play = src.slice(src.indexOf('function play('), src.indexOf('/* ------------------------------------------------------------ insert'));
    const insert = src.slice(src.indexOf('function insert('), src.indexOf('/* ------------------------------------------------------------ select'));
    assert.match(play, /render\(/, 'preview does not call render()');
    assert.match(insert, /render\(/, 'insert does not call render()');
    assert.equal((src.match(/SfxDsp\.process\(/g) || []).length, 1,
      'process() should be called in exactly one place — render()');
  });

  const stubIndex = rows => ({
    all: () => rows,
    query: () => rows,
    counts: () => ({ total: rows.length }),
    kind: i => (i.duration > 0 ? (i.duration <= 2 ? 'oneshot' : 'ambience') : 'unknown'),
    mark: () => {}, note: () => {}, folders: () => []
  });

  test('A card carries its marks, its length and its format', () => {
    const { win, doc } = boot();
    const S = win.SfxStudio;
    S._state.lib = stubIndex([
      { path: 'a', name: 'hit.wav', duration: 0.5, size: 388 * 1024, favorite: true, label: 'orange' },
      { path: 'b', name: 'bed.mp3', duration: 42, size: 2 * 1048576, favorite: false, label: '' }
    ]);
    S.renderList();
    const cards = doc.querySelectorAll('#sfxsList .sfxs-card');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].querySelector('.sfxs-label').getAttribute('data-label'), 'orange');
    assert.ok(cards[0].querySelector('.sfxs-heart').classList.contains('on'));
    assert.equal(cards[0].querySelector('.sfxs-carddur').textContent, '0:00.50');
    assert.match(cards[0].querySelector('.sfxs-cardfmt').textContent, /WAV · 388 KB/);
    assert.equal(cards[1].querySelector('.sfxs-carddur').textContent, '0:42.00');
    assert.match(cards[1].querySelector('.sfxs-cardfmt').textContent, /MP3 · 2\.0 MB/);
    assert.ok(cards[0].querySelector('canvas.sfxs-cardwave'), 'no mini waveform on the card');
  });

  // The chip counts are what tell you a filter is worth pressing.
  test('Filter chips count the whole index, not the current results', () => {
    const { win, doc } = boot();
    const S = win.SfxStudio;
    S._state.lib = stubIndex([
      { path: 'a', name: 'hit.wav', duration: 0.5, favorite: true },
      { path: 'b', name: 'bed.wav', duration: 42, favorite: false },
      { path: 'c', name: 'new.wav', duration: null, favorite: false }
    ]);
    S.renderList();
    assert.equal(doc.getElementById('sfxsCountAll').textContent, '3');
    assert.equal(doc.getElementById('sfxsCountOneshot').textContent, '1');
    assert.equal(doc.getElementById('sfxsCountAmbience').textContent, '1');
    assert.equal(doc.getElementById('sfxsCountFav').textContent, '1');
  });

  test('An empty index says how to fill it', () => {
    const { win, doc } = boot();
    win.SfxStudio._state.lib = stubIndex([]);
    win.SfxStudio.renderList();
    assert.match(doc.getElementById('sfxsList').textContent, /Add a folder/);
  });

  // A card is a click target and so are the two controls inside it. Without
  // the inner checks, every heart press would just select the row.
  test('The heart and the row play button do not fall through to select', () => {
    const src = fs.readFileSync(path.join(root, 'modules/sfx-studio.js'), 'utf8');
    const handler = src.slice(src.indexOf("view.addEventListener('click'"), src.indexOf('function run(action)'));
    const favAt = handler.indexOf('data-sfxs-row-fav');
    const playAt = handler.indexOf('data-sfxs-row-play');
    const cardAt = handler.indexOf('data-sfxs-index');
    assert.ok(favAt > 0 && playAt > 0 && cardAt > 0, 'a row handler is missing');
    assert.ok(favAt < cardAt, 'the favourite must be checked before the card');
    assert.ok(playAt < cardAt, 'the row play must be checked before the card');
  });

  // The preview used to spend 172px at 420px and 255px at 240px on a facts
  // grid of four bordered cells, a two-line heading and a 96px waveform,
  // leaving the results list under a quarter of a narrow panel. jsdom has no
  // layout, so this pins the decisions that made it compact rather than the
  // pixels they produce.
  // The folder column the After Effects panel has. It was behind the gear
  // here, which meant the one thing that tells you what the library contains
  // took two clicks to see.
  test('The sources column lists every folder with its own count', () => {
    const { win, doc } = boot();
    const S = win.SfxStudio;
    S._state.lib = {
      folders: () => ['D:/SFX/Botanica V4', 'D:/SFX/Impacts'],
      folderCounts: () => ({ 'D:/SFX/Botanica V4': 544, 'D:/SFX/Impacts': 12 }),
      counts: () => ({ total: 556 }),
      all: () => [], query: () => [], kind: () => 'oneshot', mark() {}, note() {}
    };
    S.renderFolders();
    const sources = doc.querySelectorAll('#sfxsFolders .sfxs-src');
    assert.equal(sources.length, 3, 'expected All plus two folders');
    assert.equal(sources[0].getAttribute('data-sfxs-root'), '', 'All local sounds must clear the filter');
    assert.equal(sources[0].querySelector('.sfxs-srcn').textContent, '556');
    assert.match(sources[1].querySelector('.sfxs-srcname').textContent, /Botanica V4/);
    assert.equal(sources[1].querySelector('.sfxs-srcn').textContent, '544');
    assert.equal(doc.getElementById('sfxsSourceCount').textContent, '2 sources active');
    assert.equal(doc.getElementById('sfxsIndexedCount').textContent, '556 indexed sounds');
  });

  test('Picking a source scopes the query, and the filter box narrows the list', () => {
    const { win, doc } = boot();
    const S = win.SfxStudio;
    let askedRoot = null;
    S._state.lib = {
      folders: () => ['D:/SFX/Botanica V4', 'D:/SFX/Impacts'],
      folderCounts: () => ({ 'D:/SFX/Botanica V4': 544, 'D:/SFX/Impacts': 12 }),
      counts: () => ({ total: 556 }),
      all: () => [], kind: () => 'oneshot', mark() {}, note() {},
      query: o => { askedRoot = o.root; return []; }
    };
    S.renderFolders();
    const impacts = doc.querySelector('[data-sfxs-root="D:/SFX/Impacts"]');
    impacts.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.equal(S._state.root, 'D:/SFX/Impacts');
    assert.equal(askedRoot, 'D:/SFX/Impacts', 'the query was not scoped to the picked folder');

    doc.getElementById('sfxsFolderFilter').value = 'botanica';
    S.renderFolders();
    const shown = [...doc.querySelectorAll('#sfxsFolders .sfxs-src')].map(b => b.getAttribute('data-sfxs-root'));
    assert.deepEqual(shown, ['', 'D:/SFX/Botanica V4'], 'the folder filter did not narrow the column');
  });

  // The × sits inside the source button, so without the inner check every
  // press of it would select the folder instead of removing it.
  test('Removing a source is checked before selecting it', () => {
    const src = fs.readFileSync(path.join(root, 'modules/sfx-studio.js'), 'utf8');
    const handler = src.slice(src.indexOf("view.addEventListener('click'"), src.indexOf('function run(action)'));
    assert.ok(handler.indexOf('data-sfxs-drop') < handler.indexOf('data-sfxs-root'),
      'the remove button must be checked before the source button');
    assert.match(handler, /if \(state\.root === going\) state\.root = '';/,
      'removing the selected folder must clear the scope, or the list goes empty with no way back');
  });

  test('The preview stays compact: one fact line, one-line heading', () => {
    const { doc } = boot();
    assert.ok(doc.getElementById('sfxsFacts'), 'the single fact line is gone');
    for (const id of ['sfxsFactFormat', 'sfxsFactSize', 'sfxsFactLength', 'sfxsFactRate']) {
      assert.equal(doc.getElementById(id), null, id + ': the boxed facts grid came back');
    }
    assert.equal(doc.querySelectorAll('#sfxStudioView .sfxs-title').length, 0,
      'the two-line PREVIEW heading came back');
    const css = fs.readFileSync(path.join(root, 'css/sfx-studio.css'), 'utf8');
    const wave = css.slice(css.indexOf('.sfxs-wave {'));
    const height = /height:\s*(\d+)px/.exec(wave.slice(0, wave.indexOf('}')));
    assert.ok(height && Number(height[1]) <= 60, 'the waveform is ' + (height && height[1]) + 'px');
  });

  // Every mode button and both segment fields must survive the narrow
  // breakpoints — they are how a rough drag becomes an exact range.
  test('Narrowing the panel shrinks the preview, it does not gut it', () => {
    const css = fs.readFileSync(path.join(root, 'css/sfx-studio.css'), 'utf8');
    // Only the @media blocks — the :not(.has-sound) rules legitimately hide
    // the whole preview when there is nothing selected.
    const narrow = css.slice(css.indexOf('@media (max-width'));
    for (const sel of ['.sfxs-seg input', '.sfxs-modes > button', '.sfxs-factline', '.sfxs-wave']) {
      const rule = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{[^}]*display:\\s*none');
      assert.equal(rule.test(narrow), false, sel + ' is hidden at a narrow width');
    }
    assert.match(narrow, /\.sfxs-modes \{ flex-wrap: wrap; \}/,
      'the mode row must wrap rather than overflow');
  });

  test('The rack reads every control the markup offers', () => {
    const { win, doc } = boot();
    doc.getElementById('sfxsGain').value = '-6';
    doc.getElementById('sfxsPitch').value = '7';
    doc.getElementById('sfxsSpeed').value = '50';
    doc.getElementById('sfxsReverse').checked = true;
    doc.getElementById('sfxsNormalize').checked = true;
    const S = win.SfxStudio;
    const sr = 8000, a = new Float32Array(sr);
    for (let i = 0; i < sr; i++) a[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.3;
    S._state.clip = win.SfxDsp.clip(sr, [a]);
    S._state.selFrom = 0.25; S._state.selTo = 0.75;
    const whole = S.render(false), part = S.render(true);
    assert.ok(whole && part, 'render returned nothing');
    // speed 50% with pitch locked doubles the length; the selection is half
    // the source, so the segment must be half of the whole.
    assert.ok(Math.abs(win.SfxDsp.lengthOf(part) / win.SfxDsp.lengthOf(whole) - 0.5) < 0.02,
      'segment length ' + win.SfxDsp.lengthOf(part) + ' vs whole ' + win.SfxDsp.lengthOf(whole));
    assert.ok(win.SfxDsp.peak(whole) <= 1.0001, 'normalise should hold the peak at or under full scale');
  });
}


console.log(count + ' SFX Studio tests passed; real Premiere import remains unverified.');
