# Premiere wiring audit — 2026-09-02

Main source: `D:\app\Compx adobe after effect\Extension\Compx Engine\CompX-Orbit-Premiere`

## Confirmed fixes

- Follow-up screenshot showed `orbitGetTrackList is not a function` after the license fix. JSX was evaluated inside an IIFE, with its readiness check in the same transient scope. Loader now evaluates the file at engine top level and verifies persistent endpoints through a separate CEP call before injecting entry scripts. Regression mocks now use caller-scope evaluation instead of artificially injecting global functions.
- Follow-up root cause: secure bootstrap called `CompXLicense.isActivated()`, but the shipped license module exposes `check()` and no `isActivated()`. Consequently licensed startup never evaluated the JSX or injected main/premiere-edition. The bootstrap now awaits a verified `{licensed: true}` result, waits for gate initialization, and shares an in-flight boot promise. No license or integrity verification was removed.
- CSInterface now loads once before CEP helpers/features, matching the supplied MachiCut reference's bridge-first ordering.
- Cut refreshes after actual host readiness and renders persistent inline loading/success/error status even if main.js has not started. It no longer silently leaves `load tracks` when a request fails.
- Central rail routing no longer stops feature click handlers.
- Host-loader-ready refreshes the selected route after the licensed JSX has loaded.
- Cut, Captions, Beat and Punch use `orbitGetTrackList`, with explicit no-sequence/error responses.
- Beat, Audio, Motion, Punch and Multicam refresh their track/selection state when opened.
- Host bootstrap now checks the evalFile result and required endpoints; errors and timeouts cannot report a successful bootstrap.
- Runtime health checks now cover ten module exports, ten rail views and track discovery.
- Integrity hashes and script cache versions were updated together.

## Verification scope

| Rail feature | Wiring/code check | Premiere integration |
| --- | --- | --- |
| Tools | DOM controls and literal host endpoints present | Apply actions not exercised |
| Cut | Route refresh and populated A/V discovery tested with mocks | Real waveform/cut not exercised |
| Captions | SRT parser, Bengali text, timing, UTF-16 decoder tested | Native picker/style/timeline apply not exercised |
| Beat | DOM/endpoints present; shared track response wired | Analysis/markers/cuts not exercised |
| Audio | DOM/endpoints present; selection refresh wired | DSP/output insert not exercised |
| Motion | DOM/endpoints present; selection refresh wired | Keyframes not exercised |
| Punch | DOM/endpoints present; track response/refresh wired | Keyframes not exercised |
| Library | Nested SFX/MOGRT selectors and main controller present | Native file picker/insert not exercised |
| Project Doctor | DOM/endpoints present | Live project scan not exercised |
| Multicam | DOM/endpoints present; open-time inspect wired | Live preview/markers not exercised |

Run `node tests/wiring-regression.cjs`: 19 read-only regressions passed. These cover the shipped license API, bridge ordering, licensed/denied/error startup, activation retry, concurrent boot, scope-loss reproduction, independent host probes and probe timeout. The real CEP wrapper calls the actual extracted JSX track function across separate VM evaluations, checking both no sequence and populated A1. Adobe objects and evalFile semantics remain simulated; this does not prove real Premiere operation. Earlier mocks invented `isActivated()` and injected functions globally, hiding both production mismatches.

All loaded JavaScript passed syntax checking. Literal feature-to-host calls resolved to named JSX functions. The requested rail order is Tools, Cut, Captions, Beat, Audio, Motion, Punch, Library, Project Doctor, Multicam.

## Remaining limitations

- Windows UI automation could not start because its sandbox helper failed (`apply deny-read ACLs`). No automated Premiere click test was completed.
- Release 2.4.16 removed an unused private block of 63 legacy declarations. The remaining 423 global host functions have no duplicate global declarations.
- Current Multicam suggestions use audio clip boundaries, not speech/activity analysis of samples. Its action creates review markers, not actual camera cuts.
- Two installed CEP folders share the same extension ID. They were synchronized with the same source to prevent a stale-copy mismatch; neither was deleted.

## Required live check

Save the project and restart Premiere, open a sequence containing audio, then open Cut and Refresh Tracks. A populated A1 must appear (or a concrete error must replace the silent loading state). Check Library → MOGRT and import a small SRT. Test timeline-changing actions only on a duplicate test sequence.
