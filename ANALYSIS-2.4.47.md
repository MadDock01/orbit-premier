# CompX Orbit Premiere — codebase analysis

**Version analysed:** 2.4.47 (CSXS manifest) · **Date:** 2026-09-24
**Method:** static analysis of the working tree + ran the two regression suites. No Premiere host was exercised.

---

## Summary

The engineering in here is real — the license/boot ordering fix, the SRT parser, the beat detector and the regression harness are all solid work. The problems are not in the new code; they are in what never got removed.

Three things dominate:

1. **Three built features have no way into the UI.** Tools, Motion and Punch all have panels, CSS and (mostly) JavaScript, and none of them can be opened by a user.
2. **The host script is roughly half dead code.** ~118 KB is a deliberate verbatim duplicate; another ~380 KB is After Effects ExtendScript that Premiere's engine cannot run.
3. **Nothing has been verified in Premiere since 2.4.16.** Every release note says the same thing: Windows automation fails with `apply deny-read ACLs`. Eight releases have shipped on simulated tests alone.

Two things from `AUDIT_REPORT.md` (2.4.14) are genuinely fixed: `eval()` is gone from the host script, and the `isActivated()` / `check()` boot mismatch is resolved and regression-locked.

---

## 1. Rail features that cannot be reached

The shipped `#assetTypeRow` contains **7 buttons**: CUT, CAP, BEAT, AUDIO, LIBRARY, DOCTOR, MULTICAM.

| Feature | Panel in DOM | Controller loaded | Route in router | Rail button | Reachable? |
|---|---|---|---|---|---|
| Tools (`composerToolsView`) | yes | yes (`composer-tools.js`) | yes | **no** | **No** — plus CSS force-hides the panel |
| Motion (`motionView`) | yes | yes (`motion-engine/panel.js`) | yes | **no** | **No** |
| Punch (`punchView`) | yes | **no** | **no** | **no** | **No** |

**Tools.** `css/orbit-dock.css` contains:

```css
#app #assetTypeRow > .shelf[data-type="composer"] { display: none !important; }
#composerToolsView,
#composerToolsView.orbit-route-active { display: none !important; }
```

The second rule beats the router even when the route is active. What survives is the bottom `orbit-global-dock` (cut-at-playhead, trim-before, trim-after, color-matte, volume, pitch) — also handled by `composer-tools.js`. So the Align / Anchor / Transitions / Timing / Playhead work that `TOOLS-FIX-2.4.18.md` and `TEST-PASS-REFERENCE.md` describe in detail is in the build, loaded, and unopenable.

**Motion.** `css/rail-order.css` hides `[data-type="motion"]` with the comment *"Motion removed — use Align + Punch instead."* Align is hidden (above) and Punch is not loaded (below), so the stated replacement does not exist. ~23 KB of motion JS still ships and initialises.

**Punch.** `modules/punch-panel.js` (23.9 KB) and `modules/punch-engine.js` (13.6 KB) are referenced by **nothing** — not `index.html`, not the loader, not any other module. `modules/rail-router.js`'s `views` map has no `punch` entry and actively coerces a stored `punch` shelf back to `library`. Meanwhile 24 `id="punch*"` controls ship in `index.html` as dead DOM.

**Consequence in the product:** `utils/orbitCore.js` health check asserts `PunchPanel` among its 10 required globals. It can never be defined, so the built-in diagnostic permanently reports **"9/10 rail modules active"** to every user.

**Rail count is inconsistent in five places:**

| Source | Count |
|---|---|
| Shelf buttons in `index.html` | 7 |
| `rail-router.js` `views` map | 9 |
| `wiring-regression.cjs` ("All eight visible rail routes") | 8 |
| `orbitCore.js` health check | 10 |
| `WIRING-AUDIT.md` / `TEST-PASS-REFERENCE.md` | 10 |

**Three competing mechanisms** control rail visibility and fight each other: `js/premiere-edition.js` sets inline `style.display` from a 10-type allowlist, `css/rail-order.css` hides some with `!important`, `css/orbit-dock.css` hides others with `!important`. CSS wins; the JS allowlist is dead logic.

---

## 2. `jsx/hostscript.jsx` — 18,447 lines, ~45% unreachable

**The private duplicate block (lines 10119–13309).** An IIFE labelled *"Legacy duplicated MachiCut adapter block. Keep it private so its function declarations cannot override the canonical global adapters below."* It holds **3,175 lines / ~118 KB** that are byte-identical to the canonical globals that follow (verified on 12 sampled functions including `getSequenceInfo`, `removeSilenceRanges`, `createCaptionClips`, `motionApplyToClip`, `libraryInsertItem`). This is the residue of the IIFE-scope fix described in `WIRING-AUDIT.md` — the block was quarantined rather than deleted. It is parsed and evaluated on every panel load.

It is also a live trap: 62 global function names exist twice in the file. Today the copies match. The day someone patches the wrong one, the fix silently does nothing — and that is exactly the failure mode `WIRING-AUDIT.md` spent a release chasing.

**After Effects code in a Premiere host.** Lines ~1000–9000 (~8,000 lines, ~380 KB) are After Effects ExtendScript:

| API | Occurrences |
|---|---|
| `app.beginUndoGroup` | 126 |
| `.setValueAtTime(` | 209 |
| `.addProperty(` | 48 |
| `comp.layers` | 34 |
| `CompItem` | 29 |
| `KeyframeInterpolationType` | 28 |
| `app.project.activeItem` | 11 |

None of these exist in Premiere Pro's scripting engine. This includes a 709-line "CompX Curve 2.0 engine" built on AE's graph editor. 256 global functions live in this region; the Premiere half defines 176.

**Error handling:** 1,605 `try` blocks, **650 empty `catch` blocks**. This is why host failures surface as silent no-ops rather than errors — the pattern the last three release notes keep having to work around manually.

**Fixed since 2.4.14:** zero `eval()` calls remain; the JSON polyfill now throws a clear error instead.

---

## 3. `js/main.js` is the After Effects panel's main.js

251 KB / 5,135 lines, with **92 `ae_*` references** into the AE half of the host script. `js/premiere-edition.js` is a 40-line rebrand shim on top of it. This is the single largest source of the dead weight in both the client and the host — they are two halves of the same unforked codebase.

---

## 4. Orphaned files still being packaged

`scripts/build-release.cjs` copies whole directories, so everything below ships in every ZXP:

| File | Size | Status |
|---|---|---|
| `modules/library.js` | 46 KB | unreferenced |
| `modules/punch-panel.js` | 22 KB | unreferenced |
| `modules/auth.js` | 19 KB | unreferenced |
| `modules/loginFlow.js` | 15 KB | unreferenced |
| `modules/punch-engine.js` | 13 KB | unreferenced |
| `utils/updater.js` | 14 KB | superseded by `js/update-checker.js` |
| `modules/authGate.js` | 6 KB | unreferenced |
| `lib/CSInterface.js` | 44 KB | duplicate of `js/CSInterface.js` |
| `lib/coloris.min.js` | **76 bytes** | truncated/stub file, unreferenced |
| `lib/coloris.min.css` | 8 KB | unreferenced |
| `css/orbit-foundation.css` | 7 KB | unreferenced |

`auth.js` + `loginFlow.js` + `authGate.js` are a **complete second authentication stack**, superseded by `compx-license.js` + `license-gate.js`. The Supabase URL and anon key are duplicated across **four** files (`auth.js`, `loginFlow.js`, `utils/supabase.js`, `utils/ux.js`). The keys are anon keys, so shipping them is fine — four divergent copies of the same config is not.

---

## 5. Version drift

| Location | Version |
|---|---|
| `CSXS/manifest.xml` | 2.4.47 |
| `scripts/build-release.cjs` const | 2.4.47 |
| `js/update-checker.js` `currentVersion` | **2.4.15** |
| `js/license-gate.js` `appVersion` | **2.3.1** |

The build script rewrites the manifest but never touches the other two. The update checker has been telling `compxorbit.com` it is on 2.4.15 for 32 releases, so update prompts are wrong for every installed user.

Separately: `build-release.cjs` throws `Release already exists` if the target ZXP is present. `dist/CompX-Orbit-Premiere-v2.4.47.zxp` exists, so the next build fails until the hardcoded constant is bumped by hand.

---

## 6. Build and release pipeline

- **Off-tree dependency.** The build reaches into a sibling repo (`../CompX-Orbit-Studio/tools`) for `acorn`, `jsxbin`, `ZXPSignCmd.exe` and the signing certificate. Nothing in this folder can be built standalone.
- **Signing password in source.** `build-release.cjs` falls back to scraping `const CERT_PASS = "..."` out of `build-premiere-zxp.js` by regex when `ORBIT_SIGN_PASSWORD` is unset. The certificate password is sitting in plaintext in a source file. Move it to the env var and rotate the cert.
- **Tools tests are disabled in the build gate.** Line 8 comments out `tests/tools-regression.cjs` — "run manually when hostscript is restored". The six Tools JSX tests written for 2.4.18 no longer run on any release. Given Tools is also UI-hidden, that feature is now entirely uncovered.
- **Live verification.** Every release receipt writes `livePremiereVerified: false`, and every release doc since 2.4.16 cites the same blocker (`apply deny-read ACLs`). Eight releases on simulated tests.

---

## 7. Integrity check coverage

`js/compx-loader.js` hashes **8 files**. All 8 currently match their on-disk contents — good discipline. But the manifest does not cover `index.html`, any of the 23 `modules/`, any of the 8 `utils/`, or any of the 27 stylesheets. `verifyIntegrity()` also returns `true` when Node `fs`/`crypto` are unavailable, so it fails open. As written it protects the license modules but not the page that decides whether to load them.

---

## 8. Client-side code quality

Across `js/`, `modules/`, `utils/` (~31,500 lines):

| Metric | Count |
|---|---|
| `.innerHTML =` assignments | 118 |
| `localStorage` operations | 124 |
| Empty `catch` blocks | 205 (plus 650 in the host script) |
| `console.*` in production | 121 |
| `evalScript(` call sites | 23 |

CSP still allows `'unsafe-inline'` and `'unsafe-eval'`. `js/compx-license.js` is a single minified 69 KB line containing 25 empty catches — fine as a shipped artifact, but keep the readable source under version control somewhere.

---

## 9. Disk

| Directory | Size | Files |
|---|---|---|
| `dist/` | **2.52 GB** | 31 ZXPs, 11 jsxbin, 11 receipts |
| `installation-backups/` | **650 MB** | 829 files (four test snapshots, full of macOS `._` forks) |
| `lib/` | 207 MB | three FFmpeg builds: `ffmpeg` 46 MB, `ffmpeg-x64` 79 MB, `ffmpeg.exe` 83 MB |
| Everything else | **~5 MB** | the actual source |
| **Total** | **3.40 GB** | |

93% of the folder is build output and backups. Keeping the last two or three ZXPs would free ~2.4 GB; the four `installation-backups` snapshots from 2026-09-06 are stale and would free another 650 MB.

The three FFmpeg builds go into every ZXP, which is why the package is ~79 MB. Whether all three are needed is worth checking — `ffmpeg` (46 MB) and `ffmpeg-x64` (79 MB) look like the same tool for different architectures on a Windows-only, PPRO-only extension.

---

## Recommended order of work

**First — decide what the product actually is.** Tools, Motion and Punch are built, partly tested and invisible. Either wire them back in or delete them, but do not keep shipping them. Right now the code, the CSS, the tests, the health check and the release docs all disagree about how many features exist. Pick one number and make everything agree.

1. Delete `jsx/hostscript.jsx` lines 10119–13309 (the private duplicate). ~118 KB, zero behaviour change, removes 62 duplicate global names. Verify with a `getSequenceInfo` + `orbitGetTrackList` probe after.
2. Fix the version constants in `update-checker.js` and `license-gate.js`, and make `build-release.cjs` rewrite all three from one source.
3. Move the signing password to `ORBIT_SIGN_PASSWORD` only, delete the regex fallback, rotate the certificate.
4. Delete the orphaned modules and the second auth stack, or exclude them in the build's copy filter.
5. Re-enable `tests/tools-regression.cjs` in the build gate.
6. Extend the integrity manifest to `index.html` and the `modules/`/`utils/` files, and make it fail closed when `crypto` is unavailable.
7. Strip the After Effects half of `hostscript.jsx` and `main.js`. Large job — schedule it, do not squeeze it into a patch release.
8. Convert the worst empty `catch` blocks (host script first) into a single audit-logging helper. The codebase already has `compxAuditFallback` in places; use it consistently.
9. Prune `dist/` and delete `installation-backups/`.

**On live verification:** the `apply deny-read ACLs` blocker has held for eight releases and is not going to unblock itself. A manual 20-minute smoke test on a duplicate sequence — refresh tracks, import a Bengali SRT, insert a MOGRT, run the dock's cut and trim — would be worth more than the next hundred simulated assertions.

---

*Static analysis only. Nothing here was validated against a running Premiere Pro instance.*
