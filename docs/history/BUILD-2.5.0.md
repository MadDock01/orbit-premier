# 2.5.0 — Library cross-platform audit, version bump, build readiness

**Date:** 2026-09-25 · **Previous shipped release:** 2.4.47

Suites: **7 green** — beat · 27 wiring · 24 tools · 9 dock · 3 diagnostic · 35 motion · **9 library (new)**.

---

## 1. Library (SFX / MOGRT) on Windows and macOS

Audited the whole library path. It is in better shape than expected: paths are built with
`path.join`, the MOGRT cache is derived from `os.tmpdir()`, extension matching runs through
`path.extname().toLowerCase()`, SFX preview reads with `fs.promises.readFile` and decodes via
WebAudio, and `revealInFolder` already branches `darwin` → `open -R`, `win32` → `explorer.exe`,
everything else → `xdg-open`.

### One real bug, macOS only

Drag-and-drop from the library built its file URL like this:

```javascript
const cleanPath = item.path.replace(/\\/g, "/");
const fileUrlRaw = "file:///" + cleanPath;
```

A Windows path (`C:\Sounds\hit.wav`) has no leading slash, so three are correct →
`file:///C:/Sounds/hit.wav`. A macOS path (`/Users/sonjoy/Sounds/hit.wav`) **already starts with
one**, so this produced `file:////Users/...` — four slashes, not a URL Premiere can resolve.

That corrupted the `text/uri-list` and `DownloadURL` drag flavours on macOS. Premiere may still
have accepted the drop through `com.adobe.cep.dnd.file.0`, which is passed raw, so the symptom
would have been "drag works sometimes / not in some drop targets" rather than a clean failure.

Fixed with a named `libraryFileUrl(nativePath, encode)` helper, so it is testable:

| input | output |
|---|---|
| `C:\Sounds\hit.wav` | `file:///C:/Sounds/hit.wav` |
| `/Users/sonjoy/Sounds/hit.wav` | `file:///Users/sonjoy/Sounds/hit.wav` |
| `/Users/x/My Sounds/hit.wav` (encoded) | `file:///Users/x/My%20Sounds/hit.wav` |
| `/Users/x/বাংলা/hit.wav` (encoded) | percent-encoded correctly |

### New suite: `tests/library-regression.cjs` (9 tests)

Extracts named functions out of `js/main.js` with acorn and runs them, so **both** platform path
shapes are exercised wherever the build runs. Also guards the things that would silently break the
other OS later: extension lists must stay lowercase, no Windows binary may be invoked without a
`process.platform` guard, no hardcoded drive-letter paths, the MOGRT cache must come from
`os.tmpdir()`, and `revealInFolder` must keep all three branches.

### Worth knowing, not fixed

`AUDIO_EXT` includes `.aiff` / `.aif`, and **Chromium cannot decode AIFF**. Those files import and
insert fine but will not preview, on either OS — more noticeable on macOS where AIFF is common. It
fails gracefully (a diagnostic is recorded, nothing throws). Say the word and I will either drop
AIFF from the accepted list or transcode it through the bundled FFmpeg for preview.

## 2. Version → 2.5.0

A judgement call: your history runs 2.4.9 → 2.4.47 as a single patch series, but this release adds
a whole new rail (Motion Lab, with Loop), a new diagnostic subsystem and a platform fix. That is a
minor bump under any scheme. **One line in `scripts/build-release.cjs` if you would rather it were
2.4.48.**

`build-release.cjs` rewrites all three constants from its own `version`, so these stay in lockstep:

| | |
|---|---|
| `CSXS/manifest.xml` | 2.5.0 |
| `scripts/build-release.cjs` | 2.5.0 |
| `js/update-checker.js` | 2.5.0 |
| `js/license-gate.js` | 2.5.0 |

## 3. A build-stopping bug, caught by a dry run

Before asking you to run the build I simulated its staging, version rewrite and hash steps. It
failed immediately — on my own code from two passes ago:

```javascript
const after = before.replace(pattern, m => m.replace(/"[^"]+"$/, '"' + version + '"'));
if (after === before) throw Error('Version constant not found in ' + file);
```

When the source file **already** carries the target version, the rewrite is a no-op and
`after === before` — so the guard reported "constant not found" and killed the build. Since I had
just set the source files to 2.5.0, this would have fired on your very first run.

It now tests whether the *pattern* matched, which is what the guard was actually for.

After the fix the dry run is clean: staging excludes the right 12 files, both version constants
rewrite, every hash target resolves, and every asset `index.html` references is present.

## 4. Running the build

I could not run it from here — your machine dropped off the bridge partway through this pass, and
the signing step needs `ZXPSignCmd.exe`, the certificate and `ORBIT_SIGN_PASSWORD`, all of which
live on your side by design.

```
cd "D:\app\Compx adobe after effect\Extension\Compx Engine\CompX-Orbit-Premiere"
set ORBIT_SIGN_PASSWORD=<your cert password>
node scripts\build-release.cjs
```

It will, in order: run all 7 suites → stage → compile `jsx/hostscript.jsx` to JSXBIN → rewrite the
version constants → recompute the integrity hashes over the staged files → point the loader at
`hostscript.jsxbin` → rewrite the manifest → sign → verify → write
`dist/CompX-Orbit-Premiere-v2.5.0.zxp` and `dist/release-2.5.0.json`.

**If it stops, the message is specific.** Most likely causes, in order:

1. `Set ORBIT_SIGN_PASSWORD before building a release` — expected; the plaintext fallback was
   removed deliberately.
2. A test suite fails — read which one; that is the gate doing its job.
3. `Cannot find module .../CompX-Orbit-Studio/tools/node_modules/acorn` — three suites need it.
   `cd ..\CompX-Orbit-Studio\tools && npm install acorn`
4. `SKIP dock wiring suite: jsdom is not installed` — harmless, it skips. `npm install jsdom` in the
   same folder to actually run those 9 tests.
5. `Release already exists` — only if a 2.5.0 zxp is already in `dist`.

Paste me whatever it prints and I will fix it.

## Files changed this pass

`js/main.js` · `tests/library-regression.cjs` (new) · `scripts/build-release.cjs` ·
`js/update-checker.js` · `js/license-gate.js` · `CSXS/manifest.xml` · `js/compx-loader.js`
