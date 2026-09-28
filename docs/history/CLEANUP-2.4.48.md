# Dead-code cleanup — 2.4.47 → 2.4.48

**Date:** 2026-09-24 · **Scope:** remove code that cannot run, fix the version drift, close the signing-password hole.
**Not in this pass:** the After Effects code in `jsx/hostscript.jsx` and `js/main.js` (deferred by decision — it needs a call-graph pass of its own).

19 files edited in place. All 47 JS/CJS files and `hostscript.jsx` parse. All 27 wiring regressions and the beat suite still pass. **Nothing was verified in Premiere** — see *Before you ship* at the end.

**Net: −223,619 bytes of source.** Plus 16 files no longer packaged (see *Delete list*).

---

## 1. `jsx/hostscript.jsx` — the duplicate block is gone

Removed lines 10117–13309: the IIFE commented *"Legacy duplicated MachiCut adapter block. Keep it private so its function declarations cannot override the canonical global adapters below."*

**890,179 → 720,089 bytes (−170 KB, −3,193 lines).**

Verified before and after:

- the 12 largest functions in the block were byte-identical to the canonical globals below it
- global function declarations: 432 → 431, **duplicate global names 62 → 0**
- the one name that disappeared, `motionApplyClipKeyframesFile`, existed *only* inside the private block and is called by nothing
- `getSequenceInfo` and `orbitGetTrackList` — the two endpoints `compx-loader.js` probes at startup — are both still at top level
- the file parses

That 62-duplicate situation was the trap `WIRING-AUDIT.md` spent a release chasing. It is now impossible to patch the wrong copy.

## 2. Tools, Motion and Punch removed

Per your call: all three, keeping the bottom dock.

**Deleted from `index.html`** (−19,597 bytes): `#composerToolsView` (153 lines), `#motionView` (57 lines), `#punchView` (63 lines), the two `motion-*.js` script tags, and the three Tools-only stylesheet links. `lxml` confirms the document still parses and that all seven live views, the dock, the license gate and the toast are intact. `.orbit-view-panel` count is now 6 + `sfxMogrtView` = 7, matching the 7 shelf buttons.

**`modules/composer-tools.js` rewritten as a dock-only module** (25,872 → 9,403 bytes, 413 → 175 lines).

This one mattered: deleting the panel alone would have **broken the dock**. `timeline()` and `createMatte()` both call `refresh()`, and the old `refresh()` did `el.selection.textContent = …` on an element that no longer exists — every dock cut, trim and matte click would have thrown a `TypeError`. The rewrite keeps `host()`, `status()`, `busy()`, `timeline()`, `createMatte()`, `createAdj()`, `wireDock()` and the same public API (`ComposerTools.{refresh,timeline,createMatte,createAdj}`), and drops the panel-only code: MOGRT parameter rendering, the align/anchor pads, diagnostics, the text generator, `runQuick`, `applyParam`, `replaceMedia`.

Host endpoints the dock still calls: `composerInspectSelection`, `composerTimelineAction`, `composerCreateColorMatte`, `composerCreateAdjustmentLayer`, `getActiveSequenceSpec`. The Documents-folder matte path from `TEST-PASS-REFERENCE.md` is preserved.

**Rail count now agrees in all five places — 7:**

| Source | Before | After |
|---|---|---|
| Shelf buttons in `index.html` | 7 | 7 |
| `rail-router.js` `views` map | 9 | 7 |
| `wiring-regression.cjs` | 8 | 7 |
| `orbitCore.js` health check | 10 | 7 |
| CSS hide-rules fighting the router | 3 mechanisms | 1 |

Specifically:

- **`modules/rail-router.js`** — `composer` and `motion` removed from `views`; the dead `ComposerTools.refresh()` branch removed; the hardcoded retired-shelf list replaced with `if (!views[initial]) initial = 'library'`, so it can't go stale again.
- **`utils/orbitCore.js`** — `MotionPanel` and `PunchPanel` dropped from the module list, `motionView`/`punchView`/`composerToolsView` from the view list. The hardcoded `'10/10'` strings are now computed from the array lengths. **Your health check will report 7/7 instead of the permanent 9/10.** `ComposerTools` stays in the list because it still drives the dock.
- **`js/premiere-edition.js`** — allowlist trimmed from 10 to the real 7, and the duplicated regex replaced with a lookup against that same array.
- **`utils/panelSwitcher.js`** — `motion`/`punch`/`composer` removed from all three maps (`panelMap`, `serviceMap`, `viewToPanel`).
- **`tests/wiring-regression.cjs`** — `routeIds` 9 → 7, test renamed to *"All seven rail routes…"*. The rail-click test indexed `shelves[1]` and asserted `'silence'`; with `composer` gone that index shifted to `captions`, so it now uses `shelves[0]`. Without that fix the suite would have gone red.

**CSS pruned** (6 files, −18,352 bytes): 106 fully dead rules dropped plus dead parts trimmed out of mixed selector lists. Every removal was gated on two checks — the selector anchors on a class or id that existed *only* inside the three deleted panels, **and** that token appears nowhere in `index.html` or any shipping JS. That gate is why `.motion-card`, `.motion-preview`, `#shakeList` and `#expressionList` were **left alone**: they belong to the AE half of `main.js`, which is still in the build. All 27 stylesheets remain brace-balanced.

The stale comment in `rail-order.css` — *"Motion removed — use Align + Punch instead"*, pointing at two things that no longer existed — now describes what actually ships.

## 3. Version drift fixed

`build-release.cjs` now rewrites **all three** version constants in the staging directory from its single `version` value, and throws if a constant isn't found rather than shipping a stale one.

| Location | Was | Now |
|---|---|---|
| `CSXS/manifest.xml` | 2.4.47 | 2.4.48 |
| `build-release.cjs` const | 2.4.47 | 2.4.48 |
| `js/update-checker.js` `currentVersion` | **2.4.15** | 2.4.48 |
| `js/license-gate.js` `appVersion` | **2.3.1** | 2.4.48 |

I bumped to **2.4.48** because `build-release.cjs` refuses to overwrite an existing ZXP and `dist/…v2.4.47.zxp` is already there — at 2.4.47 the build could not run at all.

One ordering trap caught while wiring this up: `js/license-gate.js` is one of the eight files in the loader's integrity manifest. My first version of this ran the rewrite *after* the hashes were computed, which would have made every install fail its own integrity check on startup. The rewrite now runs **before** the hash block, and there's a comment on it saying why.

## 4. Signing password

Removed the fallback that scraped `const CERT_PASS = "…"` out of `../CompX-Orbit-Studio/tools/build-premiere-zxp.js`. The build now reads `ORBIT_SIGN_PASSWORD` only and fails with `Set ORBIT_SIGN_PASSWORD before building a release`.

**Still on you:** that password has been sitting in plaintext in a source file across 31 shipped builds. Rotate the certificate.

## 5. Tools regression re-enabled

`tests/tools-regression.cjs` was commented out of the build gate with *"run manually when hostscript is restored"*. It's back in. The `composer*` host functions it exercises all survive in `hostscript.jsx`.

I could not run it here — it requires `acorn` from your sibling `CompX-Orbit-Studio/tools`, which isn't in this folder. If it fails on your machine, tell me what it says; don't just re-comment it.

## 6. Source integrity hashes refreshed

`js/compx-loader.js` `HASHES` recomputed for the three files this cleanup touched (`/jsx/hostscript.jsx`, `js/license-gate.js`, `js/premiere-edition.js`). All eight now match their on-disk contents, so your editable dev install still starts. The build recomputes them for the package anyway.

---

## Delete list

This session can create and update files on your disk but **cannot delete them**. These 16 are now excluded from the ZXP by a filter in `build-release.cjs`, so they no longer ship — but they're still on disk. Delete them in File Explorer when you're happy with the build:

```
modules\auth.js                    modules\punch-engine.js
modules\authGate.js                modules\punch-panel.js
modules\loginFlow.js               modules\motion-engine.js
modules\library.js                 modules\motion-panel.js
utils\updater.js                   css\composer-tools.css
lib\CSInterface.js                 css\tools-premium.css
lib\coloris.min.js                 css\premiere-tools-studio.css
lib\coloris.min.css                css\orbit-foundation.css
```

`auth.js` + `authGate.js` + `loginFlow.js` are the superseded second auth stack — deleting them also removes two of the four duplicate copies of your Supabase config. `lib\coloris.min.js` is 76 bytes, i.e. truncated.

**Disk, separately (~3.1 GB):**

- `dist\` — 2.52 GB. Keep the last two or three ZXPs, delete the other ~28.
- `installation-backups\` — 650 MB, 829 files, four stale snapshots from 2026-09-06.

## Before you ship

Originals of all 19 edited files are in this session if you need to compare, and every prior build is still in `dist\`.

Nothing here has touched a running Premiere. The rail changes are the ones to check, in this order:

1. Panel opens, license gate clears, **HOST READY** lights up.
2. Seven shelves, no gaps: CUT · CAP · BEAT · AUDIO · LIBRARY · DOCTOR · MULTICAM.
3. Click each one — exactly one panel shows, no blank view.
4. **The dock, on a duplicate sequence** — this is the one I changed most: cut at playhead, trim before, trim after, color matte, then the volume and pitch drawers.
5. Project Doctor → health check should read **7/7 rail modules** and **7/7 rail views**.
6. Import a Bengali SRT and insert a MOGRT, to confirm the host script edit didn't disturb captions or library.

If the panel refuses to start with an integrity error, the hash block and the file on disk have drifted — run the build rather than editing hashes by hand.

## Still open

From the analysis, untouched here:

- **The After Effects code** — ~8,000 lines in `hostscript.jsx`, 92 `ae_*` references in `main.js`. The largest remaining chunk of dead weight, and the reason `main.js` is still 251 KB.
- **Empty catch blocks** — now 451 in `hostscript.jsx` (down from 650), 205 in the client. Still the reason host failures look like silent no-ops.
- **Integrity coverage** — still only 8 files; `index.html`, all of `modules/` and all of `utils/` are unprotected, and `verifyIntegrity()` still returns `true` when `crypto` is unavailable.
- **`innerHTML`** — 115 sites.
- **Three FFmpeg builds** — 207 MB, ~79 MB of it in every ZXP.
