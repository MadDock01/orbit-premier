# CompX Orbit Studio - Premiere

A CEP panel for Adobe Premiere Pro 2022 and later (CSXS 11+, Chromium 88+).

## Layout

| Path | What it is |
| --- | --- |
| `index.html`, `css/`, `js/`, `modules/`, `utils/`, `lib/` | The panel (runs in CEP with Node enabled) |
| `jsx/hostscript.jsx` | Premiere host script (ExtendScript, ES3) |
| `utils/autocaptions-runtime.json` | Download manifest for local Whisper (Windows x64) |
| `tests/`, `scripts/` | Regression suites, release audit and build scripts (not packaged) |
| `docs/` | Feature notes; `docs/history/` holds past audit and release write-ups |

## Develop

```sh
npm install      # acorn + jsdom for the test suites
npm test         # release audit + every tests/*-regression.cjs suite
npm run hashes   # refresh the loader's integrity hashes after editing a hashed file
```

`js/compx-loader.js` refuses to boot when a hashed file (`js/main.js`,
`jsx/hostscript.jsx`, ...) no longer matches its recorded SHA-256, so run
`npm run hashes` after changing one of them.

## Build

`BUILD-ZXP.bat` runs `scripts/build-release.cjs`, which needs the signing tools
in `../CompX-Orbit-Studio/tools` and `ORBIT_SIGN_PASSWORD` in the environment.
Only the folders listed in the build scripts ship; keep `SHIPPED_DIRS` in
`scripts/audit-release.cjs` in step with them.
