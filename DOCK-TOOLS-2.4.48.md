# Timeline tools on the dock — verification + implementation

**Date:** 2026-09-25 · **Version:** 2.4.48 (unreleased)
**Question asked:** do Trim before / Trim after / Ripple delete / Align / Anchor actually work in Premiere — and if so, put them on the dock as icons.

**Short answer:** Align and Anchor did. The three timeline actions did **not** — the host script was missing the implementation its own test suite was written against. That is now fixed, and all five are on the dock.

Suites: **24** JSX tests (was 11 running, 11 crashing) + **9** new dock tests + 27 wiring + beat. All green. 8 files written to your folder.

---

## 1. What I found

### Align and Anchor — working, with two defects

All 11 production-JSX tests for these pass against simulated Premiere objects. The API use is real and the guards are good: keyframed Position blocks Align, animated Position or Scale blocks Anchor, and a write that Premiere silently ignores is detected instead of reported as success.

But two things were wrong.

**A write that lands on the value already in place was reported as a rejection.** `_composerWriteMotionValue` judged success by *"did the value change"*. So Align → centre on a clip that is already centred returned `"Clip 1 rejected the Position update"` — and worse, **Anchor → centre failed on every default clip**, because a default clip's anchor is already centred. Fixed: the write is now judged by whether the *requested* value is in place, compared numerically with tolerance.

**Align alone does not do what its icon suggests — and this is deliberate.** Align writes Position straight to the pressed 3×3 spot with 5% margins. Premiere puts the clip's **anchor** at that position, and a default clip's anchor is its centre — so "Align top-left" puts the clip's *centre* at 5%,5% and most of it hangs off-frame.

This is not a bug. `TOOLS-FIX-2.4.18.md` describes a bounds-aware version that measured source size, scale and rotation — that version was reverted, and the test that replaced it is named *"Align writes the pressed spot directly so every clip visibly moves"*, with a companion named *"Full-frame clips still move: scale never blocks align"*. The bounds-aware version wouldn't move full-frame clips, so it was dropped.

So **Align and Anchor are a pair**: set Anchor to a corner, then Align to the same corner, and the clip's corner lands at 5%,5%. The dock now says this in the Align pad, because otherwise users will reasonably call it broken.

### Trim / Cut / Ripple delete — the implementation was missing

`tests/tools-regression.cjs` could not even load. It requires 25 host functions; **10 had never existed** in `hostscript.jsx`:

```
_composerExactFps          _composerTrackAt        _composerLockedTargets
_composerPlayheadSeconds   _composerQeTrackAt      _composerRazorTargetTracks
_composerPlayheadTimecode  _composerTrackLabel     _composerReselectRanges
_composerGroupList
```

I checked this against the pre-cleanup backup: my earlier cleanup removed none of them. They were never there. That is what the build comment *"run manually when hostscript is restored"* meant — the host file had gone **backwards** from the tests written for it.

The tests specify behaviour the shipped code did not have:

| Test expects | Shipped code did |
|---|---|
| Trim via **razor + remove**, so Premiere records it in undo history | Direct `clip.start = time` write |
| Trim to fall back to a verified edge write only when QE is missing | No fallback path at all |
| Ripple delete across **several clips per track**, latest first | Refused more than one clip per track |

And the direct-write path had its own defect: `_composerSetTimelineBoundary` returned `true` as soon as `clip[edge] = time` didn't throw. Assigning to a read-only ExtendScript accessor **no-ops silently rather than throwing**, so the `.seconds` and `.ticks` fallbacks below it were permanently unreachable.

## 2. What I implemented

`composerTimelineAction` rewritten to the test spec, plus the 10 missing helpers (`jsx/hostscript.jsx`, +140 lines net).

**Cut and trim now go through QE's per-track razor, then a plain remove.** Two reasons that ordering matters: Premiere ignores edge writes on many builds, and a per-track razor cannot touch tracks the user didn't select — which removes the need for the lock-every-other-track dance entirely. The sequence-wide razor is kept as a fallback for builds without `QETrack.razor`, and there the locks are still taken and restored. With no QE at all, trim falls back to a read-back-verified edge write; a **cut is refused rather than faked**.

Three details worth knowing:

- **Drop-frame is handled properly now.** The razor timecode comes from `qeSeq.CTI.timecode` — Premiere's own formatting for that sequence. The old `secondsToTimecode` arithmetic doesn't renumber dropped frames and drifts by a frame past the first minute on 29.97 / 59.94.
- **Trim never ripples** (`remove(false, false)`), so the rest of the track stays put.
- **Selection survives.** Razoring drops the timeline selection in Premiere, so `_composerReselectRanges` re-selects every clip that now falls inside a recorded range — both halves of a cut stay highlighted.

Ripple delete now allows several clips per track, removes latest-first so an earlier ripple can't move the later ones, and enforces matching ranges *across* tracks so a linked video + audio pair stays in sync.

`_composerSetTimelineBoundary` now reads the value back after each route and only then decides, so routes 2 and 3 are reachable. A clamped trim (Premiere limiting to available source media) still counts as a write, so you get the accurate *"did not reach the playhead"* rather than *"read-only"*.

## 3. The dock

Nine controls, in the existing Orbit idiom:

```
✂ cut  |  ⇤ trim before  |  ⇥ trim after  |  ⇠ ripple delete  ¦  ▣ align ▾  ✛ anchor ▾  ▤ matte  ¦  🔊 volume ▾  〜 pitch ▾
```

- **Ripple delete** is new, styled as destructive, and is the only control that confirms and takes a safety copy first — it already had that path in `OrbitCore.run`, it just had no button.
- **Align** and **Anchor** are drawers holding a 3×3 pad. Each cell carries a dot showing which part of the frame it means, and the pad marks the last cell used, per pad. The Align pad carries the pairing hint; the Anchor pad says it moves the pivot without moving the clip.
- Pops are now **clamped inside the panel** — a 128px pad opened from a button near the edge of a 240px panel used to hang off-screen.

**Layout, measured in a real browser at four widths:** single row at 240 / 280 / 420 / 700px. Below 300px the buttons drop to 23px, the gaps to 2px and the separators hide, which fits nine controls into the 228px content box of a 240px panel (9×23 + 8×2 = 223px). Wrapping to a second row stays on as a last resort, and the dock is auto-height so it can't clip.

## 4. New test suite: `tests/dock-regression.cjs`

9 tests driving the real `index.html` in a DOM with the bridge stubbed. This catches what a JSX-only suite structurally cannot: a control that exists in the markup but is wired to nothing, or wired to the wrong endpoint.

Covered: every dock action reaches its expected host endpoint · only ripple delete confirms/takes a safety copy · all 9 align cells and all 9 anchor cells pass their own mode · pads mark independently · one drawer open at a time · pop clamping · busy state disables pad cells too · the retired Tools/Motion/Punch panels are gone and the dock still works.

`jsdom` is a **soft dependency** — the suite skips with a message if it's missing, so the release build never breaks over a dev-only package. To actually run it:

```
cd ..\CompX-Orbit-Studio\tools
npm install jsdom
```

Both suites are now in the build gate in `scripts/build-release.cjs`.

---

## Files changed

| File | Change |
|---|---|
| `jsx/hostscript.jsx` | 10 new helpers, `composerTimelineAction` rewritten, 2 defect fixes |
| `index.html` | ripple-delete button, align + anchor pad drawers, separators |
| `css/orbit-dock.css` | pad grid + position dots, separators, danger state, responsive single-row |
| `modules/composer-tools.js` | `align()`, `setAnchor()`, pad wiring, pop clamping |
| `tests/dock-regression.cjs` | **new** — 9 DOM wiring tests |
| `tests/tools-regression.cjs` | 2 tests for the write-verification fix |
| `scripts/build-release.cjs` | dock suite added to the gate |
| `js/compx-loader.js` | integrity hash refreshed for the new `hostscript.jsx` |

## Before you ship — please read

**None of this has run inside Premiere.** 24 JSX tests against simulated Adobe objects and 9 DOM tests are a much stronger position than before, but they are not proof. Two things in particular can only be settled on the real host:

1. **`QETrack.razor(timecode)` is undocumented.** The whole cut/trim path leans on it. If it isn't present on your Premiere build, cut reports *"Premiere timeline scripting (QE) is unavailable"* and trim silently falls back to the edge write — so watch which path you actually get.
2. **Whether `trackItem.start` / `.end` are writable** on your build determines whether that fallback works at all.

Test on a **duplicate sequence**, in this order:

1. Select one clip, playhead inside it → **Cut**. Both halves should stay selected.
2. Select a linked V+A pair → **Trim before**, then undo, then **Trim after**. Check Premiere's undo history names the step *"Orbit - Trim …"*.
3. Put the playhead on an existing edit point → **Cut** should refuse with a clear message, not fail silently.
4. Select a clip with an unselected clip crossing the playhead on the same track → should refuse and name the track.
5. **Ripple delete** a linked pair → confirm dialog, safety copy, gap closes on both tracks.
6. Select clips with different in/out across V and A → should refuse with *"same start and end times"*.
7. **Anchor → centre** on a fresh clip → should now succeed (this was the guaranteed failure).
8. **Anchor top-left, then Align top-left** → the clip's top-left corner should land near the frame corner. Align alone will not do that, by design.
9. Try a **29.97 drop-frame** sequence for cut — that's where the timecode path matters most.

If cut or trim misbehaves, tell me what the dock status line says. The messages are specific enough now to identify which path ran.

## Still open

- **After Effects code** — ~8,000 lines in `hostscript.jsx`, 94 `ae_*` references in `main.js`. Untouched, as agreed.
- `_composerRotatedBounds` and `_composerAnchorPx` (~30 lines) have no production callers — leftovers of the reverted bounds-aware align. `_composerRotatedBounds` is still named in the test's load list, so removing it means editing that list too.
- Empty catch blocks: 451 in `hostscript.jsx`, 205 in the client.
- The 16-file delete list from the last pass is still pending.
