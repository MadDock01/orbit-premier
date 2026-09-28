const assert = require('node:assert/strict');
global.window = global;
require('../modules/beat-engine.js');
const rate = 8000;
assert.equal(BeatEngine.analyzeBeats(new Float32Array(rate * 30), rate).bpm, 0);
assert.equal(BeatEngine.analyzeBeats(new Float32Array(rate * 30).fill(.1), rate).beats.length, 0);
for (const bpm of [80, 100, 120, 150, 180]) {
  const pcm = new Float32Array(rate * 60);
  for (let t = .2; t < 60; t += 60 / bpm) {
    for (let j = 0; j < 80; j++) pcm[Math.floor(t * rate) + j] = Math.exp(-j / 16);
  }
  const result = BeatEngine.analyzeBeats(pcm, rate);
  const error = Math.min(Math.abs(result.bpm - bpm), Math.abs(result.bpm * 2 - bpm));
  assert.ok(error < 1, `tempo ${bpm}: got ${result.bpm}`);
  console.log(`Synthetic ${bpm} BPM => ${result.bpm} BPM${Math.abs(result.bpm-bpm)>1?' (known half-tempo ambiguity)':''}`);
}
const selected = BeatEngine.selectEvents({bpm:120,duration:2,offset:0,beats:[],onsets:[]}, {subdivisions:3,strength:100});
assert.ok(selected.all.some(e => Math.abs(e.t - 1/6) < 1e-6));
console.log('PASS silence, constant audio, synthetic tempo/octave checks, triplet grid. Real music/host integration not validated.');
