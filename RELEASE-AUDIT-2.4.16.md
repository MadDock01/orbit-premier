# Release 2.4.16

Main source remains CompX-Orbit-Premiere. Removed 63 unused private legacy declarations; prevented the legacy asset handler from overriding central rail routing; preserved existing Library grid content during fallback rendering.

The new studio-theme.css follows Orbit Studio's dark-green styling, including Library SFX/MOGRT tabs, filters, toolbar, cards and Apply buttons. Compact 380px and 700px headless layouts were checked without horizontal document overflow in tested views.

Verification: 41 JavaScript files parsed, 423 global host functions, 61 referenced assets, no static audit failures. All 19 simulated bridge/startup/SRT/router regressions passed. Final ZXP signature verified. Packaged theme matches source; package contains JSXBIN and no source JSX. Artifact hashes are in dist/release-2.4.16.json.

Live Premiere operations remain unverified because the Windows automation runtime could not start. Test track refresh, SRT import/apply and MOGRT insertion on a duplicate sequence. Existing Multicam generates review markers from clip boundaries, not automatic speaker-based camera cuts.

Source JSX remains editable. The release uses compiled JSXBIN and recalculated integrity hashes; license checks remain enabled. Installed C-drive copies were not updated in this build pass.
