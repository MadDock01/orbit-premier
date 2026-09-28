# Motion Lab — Easify 3 assessment + the new Motion rail

**Date:** 2026-09-25 · **Version:** 2.4.48 (unreleased) · **Scope chosen:** both sections, one-way bake

16 files written. **22 new tests**, all suites green (beat · 27 wiring · 24 tools · 9 dock · 3 diagnostic · 22 motion). Nothing verified inside Premiere.

---

## What Easify 3 actually is, on each host

Its manifest declares both `AEFT` and `PPRO`, but the two halves are nearly different products.

**The After Effects half does not port.** Its core is `KeyframeEase`, `setTemporalEaseAtKey`, `keyInTemporalEase`, `keyInSpatialTangent` — real bezier handle manipulation. Premiere's ExtendScript has no bezier-handle API on clip keyframes: `setInterpolationTypeAtKey` only picks Linear / Bezier / Hold, and the handles behind Bezier can be neither read nor written. That is a host limit, not something their Premiere build solved.

**The Premiere half works around it by baking.** Since it cannot set handles, it writes the curve into the *values*: replace the span between two keys with many keys that trace the curve, at a chosen interval in frames or milliseconds. That is the whole trick, and it is what the new Motion rail does.

The rest of what they ship on Premiere, from the code and their asset names:

| Feature | Evidence |
|---|---|
| Easing across a key range | `Bezier`, `Bounce`, `BackInOut` in the jsx strings |
| Keyframe utilities | `removeKeyRange`, `findNextKey`, `findPreviousKey`, `findNearestKey` |
| Move keys by an offset | `moveKeys(prop, firstKey, lastKey, offset)` |
| Swap two keys | `keyframeSwap.png` |
| Scope: all / between in–out / path | `all.png`, `between.png`, `path.png`, and `getInPoint()`/`getOutPoint()` scoping |
| Re-editable easing | writes curve data into project XMP under `premierePrivateProjectMetaData`, key `"ED"` |
| UI | CSS classes: clip list, per-property controls, preset thumbnails, custom saved presets, `decay`, `inOut`, sliders |

The XMP trick is the clever bit: Premiere cannot read a curve back, so they remember their own. You chose not to copy it — the bake here is one-way, undo works normally, and nothing hidden goes into your project file.

---

## What I built

### The rail

`MOTION` is back in the rail, between AUDIO and LIBRARY. Three cards:

**Presets** — one-click animations for clips with no keyframes. Reuses your existing `motion-presets.json` (15 presets: Pop, Zoom, Slide, Bounce, Rotate, Fade, in/out/combo) and `motion-engine.js` for duration, intensity and direction. Place at clip start or clip end.

**Easing** — re-curve keyframes you already made. 11 curves (sine, quad, cubic, quart, quint, expo, circ, back, elastic, bounce, linear) × ease in / out / both, with a strength slider, a bounce slider that appears only for bounce, and a bake interval in frames. A live SVG graph draws the curve against a dashed linear baseline, so strength and bounce are legible before you apply anything. Below it, every animated property on the selection with its effect name and key count, each tickable.

**Keyframes** — nudge earlier, nudge later (by the bake interval), swap the end values, clear.

### Host endpoints (`jsx/hostscript.jsx`)

- `motionInspectKeyframes()` — every keyframable property on the selection, with key times reported **clip-relative**
- `motionReadKeyValues(payload)` — the value at each key; Premiere exposes no way to read a curve, only values, so the panel must fetch these before it can bake
- `motionBakeKeys(payload)` — clears the old span, writes the baked keys, forces linear interpolation on each (the curve lives in the values, so any easing Premiere added on top would double-apply)
- `motionEditKeys(payload)` — shift / swap / clear

Properties are addressed by **component + property index**, never `displayName`, because Premiere localises display names.

### A latent bug fixed on the way

`motionMakeTime` did this:

```javascript
var t = ti.start;        // live Time object
t.seconds = Number(seconds);
```

That is the *exact assignment* `_composerSetTimelineBoundary` uses to trim a clip. On any build where a TrackItem boundary is writable, building a keyframe timestamp would have **moved the clip**. It now builds a fresh `Time`. There is a test that fails if anyone reintroduces it.

Also added `motionSourceTime` / `motionClipRelative`: component keyframes are addressed in the clip's **source** time (`clip.inPoint + (sequenceTime − clip.start)`), not sequence time. Easify does the same conversion; getting it wrong puts keyframes at the wrong place on any clip that is trimmed at the head.

### Curve engine (`modules/motion-curves.js`)

Pure maths, no Premiere API, so it is unit-tested directly. Two bugs caught by writing the tests:

- **bounce with decay did not start at zero** — the old formula returned 0.7 at t=0, so a clip would have jumped before it began moving. It now blends toward a plain ease-out instead of scaling the curve.
- **elastic's strength term was dead code** (`Math.pow(1, power)` is always 1). Strength now blends every shape against a straight line, which preserves the endpoints and gives one consistent meaning everywhere: 0 is linear, 1 is the full curve.

Guards: every shape satisfies f(0)=0 and f(1)=1 across all strengths and decays (tested exhaustively), and a span is capped at 600 keys so a long clip at a 1-frame interval cannot flood the timeline — the UI says when it capped.

### Cleanup done in passing

`rail-order.css` and `orbit-dock.css` both set `order` on the same shelf buttons with different numbers — the same duplicate-mechanism problem we cleaned up before. Dropped the losing copy; `orbit-dock.css` is now the single source of rail order.

---

## Files

| File | |
|---|---|
| `modules/motion-curves.js` | **new** — curve library + baking |
| `modules/motion-lab.js` | **new** — the rail |
| `css/motion-lab.css` | **new** — panel styling, single-column below 340px |
| `tests/motion-regression.cjs` | **new** — 22 tests |
| `jsx/hostscript.jsx` | 4 endpoints, 3 helpers, `motionMakeTime` fix |
| `index.html` | Motion panel, shelf button, scripts, stylesheet |
| `modules/rail-router.js`, `utils/orbitCore.js`, `utils/panelSwitcher.js`, `js/premiere-edition.js` | 7 rails → 8, consistently |
| `css/orbit-dock.css`, `css/rail-order.css` | motion order; duplicate order block dropped |
| `scripts/build-release.cjs` | motion suite gated; `motion-engine.js` ships again |
| `js/compx-loader.js` | integrity hashes refreshed |
| `tests/wiring-regression.cjs`, `tests/dock-regression.cjs` | updated for 8 rails |

---

## Test on a duplicate sequence

1. Open **MOTION**. The header should read *N clips · N animated properties · 30 fps*.
2. Select a clip with **no** keyframes → pick **Pop** → Apply preset. Check Effect Controls for Scale and Opacity keys at the clip head.
3. Set Place to **At clip end**, apply **Fade** — the animation should finish exactly at the tail.
4. Now the important one: select a clip that **already** has two Scale keyframes. Refresh. Scale should be listed with its key count. Pick **Bounce**, Ease out, Apply easing. You should get many keys tracing the bounce, and the first and last should sit exactly where they were.
5. **Undo once** — the whole bake must disappear in a single step.
6. Raise **Bake every** to 5 frames and re-apply. Fewer keys, same shape.
7. **Nudge →**, then **Swap ends**, then **Clear**.
8. Try it on a clip **trimmed at the head** (in-point not 0) — this is where the source-time conversion matters; the keys must land on the visible animation, not offset.

## Known limits

- **Bezier handles stay out of reach.** A baked curve is many linear keys, so Effect Controls shows a dense key run rather than two keys with handles. That is the only way on this host, and it is what Easify does too.
- **Preset properties match on English names** (`Scale`, `Position`, `Rotation`, `Opacity`). On a localised Premiere the preset section will not find them; the easing section is unaffected because it works from indices. Say the word and I will match on `matchName` instead.
- Undo is one step per action, but Premiere occasionally splits an undo group on keyframe writes — worth checking at step 5.
