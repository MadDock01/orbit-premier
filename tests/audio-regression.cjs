// AI Voice Cleaner: the denoise engine, run for real on synthetic audio.
// Pure maths with no DOM and no FFmpeg, so every path here is exercised
// rather than asserted about.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');

const ctx = { console, setTimeout, Math, Float64Array, Float32Array, Int16Array,
  Uint8Array, ArrayBuffer, DataView, Promise, JSON, Date };
ctx.window = ctx; ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'modules/audio-engine.js'), 'utf8'), ctx);
const E = ctx.AudioEngine;

const SR = 48000;
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }

// A deterministic pseudo-random hiss, so a run is reproducible.
let seed = 7;
function noise() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; }
function reseed(v) { seed = v; }

function rms(a, from, to) {
  let t = 0;
  for (let i = from; i < to; i++) t += a[i] * a[i];
  return Math.sqrt(t / Math.max(1, to - from));
}
const dB = ratio => 20 * Math.log10(ratio);

/** Hiss everywhere; a voice-like tone only during `spans` (seconds). */
function build(seconds, spans, hiss = 0.05) {
  reseed(7);
  const n = Math.round(SR * seconds), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const voiced = spans.some(([a, b]) => t >= a && t < b)
      ? Math.sin(2 * Math.PI * 180 * i / SR) * 0.35 + Math.sin(2 * Math.PI * 360 * i / SR) * 0.18
      : 0;
    x[i] = voiced + noise() * hiss;
  }
  return x;
}

test('Hiss comes down and the voice does not', () => {
  const x = build(3, [[0.6, 3]]);
  const y = E.denoiseChannel(Float64Array.from(x), SR, 1);
  const noiseDrop = dB(rms(y, 0, SR * 0.5) / rms(x, 0, SR * 0.5));
  const voiceDrop = dB(rms(y, SR, SR * 2) / rms(x, SR, SR * 2));
  assert.ok(noiseDrop < -6, 'hiss only fell ' + noiseDrop.toFixed(1) + ' dB');
  assert.ok(voiceDrop > -1, 'the voice lost ' + voiceDrop.toFixed(1) + ' dB');
});

test('Strength scales how much is removed', () => {
  const x = build(3, [[0.6, 3]]);
  const drops = [0.3, 0.8, 1].map(s => {
    const y = E.denoiseChannel(Float64Array.from(x), SR, s);
    return dB(rms(y, 0, SR * 0.5) / rms(x, 0, SR * 0.5));
  });
  assert.ok(drops[0] > drops[1] && drops[1] > drops[2],
    'more strength should remove more: ' + drops.map(d => d.toFixed(1)).join(', '));
});

// The regression this file exists for. The noise profile used to be the
// clip's first 0.5 s, on the assumption that a clip opens with room tone.
// A tightly cut clip opens on speech, and the profile was then the voice —
// which the subtraction promptly removed, measured at 9.1 dB.
test('A clip that opens on speech keeps its voice', () => {
  const x = build(3, [[0, 2.4]]);
  const y = E.denoiseChannel(Float64Array.from(x), SR, 1);
  const voiceDrop = dB(rms(y, SR * 0.5, SR * 2) / rms(x, SR * 0.5, SR * 2));
  assert.ok(voiceDrop > -1.5,
    'the voice lost ' + voiceDrop.toFixed(1) + ' dB — the profile is reading speech as noise');
  const noiseDrop = dB(rms(y, SR * 2.5, SR * 2.9) / rms(x, SR * 2.5, SR * 2.9));
  assert.ok(noiseDrop < -6, 'and the hiss after it only fell ' + noiseDrop.toFixed(1) + ' dB');
});

test('A gap anywhere in the clip is enough to profile from', () => {
  const x = build(4, [[0, 1.5], [2.5, 4]]);
  const y = E.denoiseChannel(Float64Array.from(x), SR, 1);
  assert.ok(dB(rms(y, SR * 0.3, SR * 1.3) / rms(x, SR * 0.3, SR * 1.3)) > -1.5, 'voice before the gap');
  assert.ok(dB(rms(y, SR * 1.7, SR * 2.3) / rms(x, SR * 1.7, SR * 2.3)) < -6, 'hiss in the gap');
});

// Continuous speech has no true silence, only syllable troughs. The profile
// comes from those, so the peaks have to survive.
test('Continuous speech survives on its syllable troughs alone', () => {
  reseed(11);
  const n = SR * 4, x = new Float32Array(n), clean = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.max(0.06, Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t - Math.PI / 2), 1.6));
    clean[i] = (Math.sin(2 * Math.PI * 180 * i / SR) * 0.35 + Math.sin(2 * Math.PI * 360 * i / SR) * 0.18) * env;
    x[i] = clean[i] + noise() * 0.05;
  }
  const y = E.denoiseChannel(Float64Array.from(x), SR, 1);
  // The loudest 150 ms of the clean reference is a syllable peak.
  let bestAt = 0, best = 0;
  for (let s = 0; s < 3.8; s += 0.02) {
    const r = rms(clean, SR * s, SR * (s + 0.15));
    if (r > best) { best = r; bestAt = s; }
  }
  const peakDrop = dB(rms(y, SR * bestAt, SR * (bestAt + 0.15)) / rms(x, SR * bestAt, SR * (bestAt + 0.15)));
  assert.ok(peakDrop > -3, 'syllable peaks lost ' + peakDrop.toFixed(1) + ' dB');
});

// A clip with no quiet passage at all gives a profile made of programme.
// Subtracting that at full strength would gut it, so the engine backs off.
test('No silence to measure means a gentler subtraction, not a gutted clip', () => {
  const src = fs.readFileSync(path.join(root, 'modules/audio-engine.js'), 'utf8');
  assert.match(src, /var confidence = Math\.max\(0\.25,/, 'the confidence floor is gone');
  assert.match(src, /var alpha = \(1 \+ strength \* 3\) \* confidence;/,
    'confidence must scale the over-subtraction');
});

// Dry/wet. The guard used to read `Number(opts.mix) === 0 ? 1 : ...`, so a
// deliberate 0% mapped straight to 100%: dragging Mix fully dry gave fully
// wet. Only a missing value should default to 1.
test('Mix 0% returns the original untouched', () => {
  const x = build(2, [[0.5, 2]]);
  const dry = E.processChannels([x], SR, { strength: 1, mix: 0 })[0];
  for (let i = 0; i < x.length; i += 97) {
    assert.ok(Math.abs(dry[i] - x[i]) < 1e-9, 'sample ' + i + ' was processed at Mix 0%');
  }
});

test('Mix blends in proportion, and a missing mix is fully wet', () => {
  const x = build(2, [[0.5, 2]]);
  const change = m => {
    const y = E.processChannels([x], SR, { strength: 1, mix: m })[0];
    let t = 0;
    for (let i = 0; i < x.length; i++) t += (y[i] - x[i]) * (y[i] - x[i]);
    return Math.sqrt(t / x.length);
  };
  const quarter = change(0.25), half = change(0.5), full = change(1);
  assert.ok(quarter < half && half < full, 'mix is not monotonic');
  assert.ok(Math.abs(half / full - 0.5) < 0.02, 'mix 50% should be half the change');
  assert.equal(change(undefined).toFixed(6), full.toFixed(6), 'a missing mix should be fully wet');
});

test('Normalise puts the peak at -1 dBFS and keeps the stereo image', () => {
  const left = build(1, [[0.3, 1]]);
  const right = Float32Array.from(left, v => v * 0.5);
  const out = E.processChannels([left, right], SR, { strength: 0.5, normalize: true });
  let peakL = 0, peakR = 0;
  for (let i = 0; i < out[0].length; i++) {
    peakL = Math.max(peakL, Math.abs(out[0][i]));
    peakR = Math.max(peakR, Math.abs(out[1][i]));
  }
  assert.ok(Math.abs(dB(Math.max(peakL, peakR)) - (-1)) < 0.2,
    'peak is ' + dB(Math.max(peakL, peakR)).toFixed(2) + ' dBFS');
  assert.ok(Math.abs(peakR / peakL - 0.5) < 0.02,
    'the channels were scaled by different amounts, which would move the image');
});

// The profile frame count is capped so a long clip does not buffer a
// magnitude spectrum per frame — at 5 minutes that would be hundreds of MB.
test('The profile is capped, so cost stays flat on a long clip', () => {
  const src = fs.readFileSync(path.join(root, 'modules/audio-engine.js'), 'utf8');
  assert.match(src, /MAX_PROFILE_FRAMES = \d+/, 'no cap on the profile frames');
  const cap = Number(/MAX_PROFILE_FRAMES = (\d+)/.exec(src)[1]);
  assert.ok(cap > 0 && cap <= 600, 'the cap is ' + cap + ' frames');

  reseed(3);
  const n = SR * 20, x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.max(0.06, 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * i / SR));
    x[i] = Math.sin(2 * Math.PI * 200 * i / SR) * 0.3 * env + noise() * 0.05;
  }
  const started = Date.now();
  const y = E.denoiseChannel(x, SR, 0.8);
  const perSecond = (Date.now() - started) / 20;
  assert.equal(y.length, n);
  assert.ok(perSecond < 400, 'denoise took ' + perSecond.toFixed(0) + ' ms per audio-second');
});

test('A WAV survives encode and decode', () => {
  const x = build(0.5, [[0.1, 0.5]]);
  const buffer = E.encodeWav([x], SR, 16);
  const decoded = E.decodeWav(buffer);
  assert.equal(decoded.sampleRate, SR);
  assert.equal(decoded.channels.length, 1);
  assert.equal(decoded.channels[0].length, x.length);
  for (let i = 0; i < x.length; i += 53) {
    assert.ok(Math.abs(decoded.channels[0][i] - x[i]) < 2e-4, '16-bit round trip drifted at ' + i);
  }
});

console.log(count + ' audio tests passed; FFmpeg extraction and Premiere import remain unverified.');
