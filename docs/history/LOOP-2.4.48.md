# Looper Pro assessment + the LOOP card

**Date:** 2026-09-25 · **Version:** 2.4.48 (unreleased)
**Answer to "where does it go":** the Motion tab. It is the same domain as Easing — read clip keyframes, write more of them — and it reuses the host endpoints built for it.

7 files changed. Motion suite **22 → 35 tests**, all six suites green. Nothing verified inside Premiere.

---

## What Looper Pro is

Premiere-only (`PPRO 9.1`), and small: the panel HTML is the whole feature list, URL-escaped inside `document.write(unescape(...))`. The host JSX is JSXBIN so it cannot be read, but it does not need to be.

It is **After Effects' `loopOut()` / `loopIn()` for a host with no expression engine**:

| Control | Options |
|---|---|
| direction | `Out()` / `In()` |
| type | cycle · pingpong · offset |
| keys | `all`, or a number ≥ 2 — how many keyframes form the loop unit |
| end | clip · playhead |
| interpolation | checkbox + interval in ms |
| | a clip list with cancel / confirm before applying |

That interpolation option is the same baking trick Easify uses, for the same reason: Premiere exposes no bezier handles, so a curve can only be carried by values.

## What I built

A fourth card in the Motion rail: **LOOP** — Direction, Mode, Use (all / 2–5 keyframes), Until (clip end / playhead), and a **Keep easing** checkbox.

`modules/motion-loop.js` (new, pure maths, unit-tested):

- **cycle** repeats the unit's values verbatim
- **pingpong** plays forward, then backward, then forward
- **offset** repeats the shape but accumulates the net change, so the value keeps climbing
- **Loop in** is implemented by mirroring time, running the "out" path and mirroring back — so the reversal in pingpong and the sign of the offset accumulation come out of one code path instead of two that have to agree

**Keep easing** is the interesting one. `getValueAtKey` only reports values sitting *on* keyframes, so reading a bezier-eased segment that way flattens it to a straight line. The new `motionSampleValues` host endpoint samples `getValueAtTime` across the unit instead, which captures the shape Premiere actually draws. A test proves the difference: with a quadratic ease between keys 0 and 100, a linear read returns 50 at the midpoint and sampling returns 25.

`motionInspectKeyframes` now also reports the playhead clip-relative, so "Until: playhead" has a target.

## One bug worth calling out

My first cycle implementation produced a **flat hold instead of a loop**. Each repetition's first key lands exactly on the previous repetition's last key, and I was skipping it as a duplicate. That is right for pingpong and offset — both are continuous there — but a cycle *snaps back* to the unit's first value at that moment. Skipping it left the property parked at the last value forever.

Premiere cannot stack two keyframes on one frame, so the reset key now goes one frame later. That is the closest a keyframe can get to the instantaneous jump `loopOut("cycle")` makes in After Effects. The test asserts the exact key list, so it cannot regress quietly.

## Files

| File | |
|---|---|
| `modules/motion-loop.js` | **new** — loop maths |
| `jsx/hostscript.jsx` | `motionSampleValues`; playhead added to inspection |
| `modules/motion-lab.js` | `applyLoop()` and its wiring |
| `index.html` | LOOP card |
| `css/motion-lab.css` | checkbox-with-hint style |
| `tests/motion-regression.cjs` | 13 new tests (10 loop maths, 3 host) |
| `js/compx-loader.js` | integrity hash refreshed |

## Test on a duplicate sequence

1. Put two Scale keyframes near the head of a clip, leaving room after them.
2. MOTION → Refresh → tick Scale.
3. **Loop out · Cycle · All keyframes · Clip end** → Apply loop. The animation should repeat to the end of the clip, **snapping back** at each repeat rather than holding.
4. Switch to **Ping-pong** and re-apply — it should retrace instead of snapping.
5. **Offset** — the value should keep climbing rather than returning.
6. Move the playhead to the middle, set Until to **Playhead**, apply — the loop must stop there.
7. **Loop in** with keys near the *end* of the clip — it should fill backwards towards the head.
8. Ease one of the source keyframes in Effect Controls, then apply with **Keep easing** on and off. With it on, each repeat should carry the same eased shape; with it off, straight ramps.
9. Undo after each — one step per apply.

## Limits

- The cycle reset is one frame wide, not instantaneous. Unavoidable: two keyframes cannot share a frame.
- **Keep easing** writes a key per frame across the unit, so a long unit produces a lot of keys. The 600-key cap applies and the status line says when it hits.
- Looping replaces only the span *after* the unit (or before it, for Loop in). The original keyframes are left alone.
