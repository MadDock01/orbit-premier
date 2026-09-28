# Tools correction 2.4.18

Safety copies now restore the original sequence, playhead and selection before the edit; failure to restore aborts the action. Tools preflight checks selection before creating a backup. The unchanged standalone duplicate command retains its default behavior.

Static clip alignment now uses source-frame bounds, scale, rotation and anchor rather than placing the anchor directly on the edge. This is whole-clip alignment, not individual text/shape bounds inside a graphic. Unknown source dimensions still fall back to sequence dimensions and need host validation.

Anchor updates reject animated Position/Anchor/Rotation rather than creating keys in the wrong time domain. Nonuniform scale reads Scale Width. Static Motion writes are checked by reading the value back. Unsupported/audio components are not treated as Motion.

Six new tests execute production JSX functions using simulated Adobe objects. Nineteen existing regression tests also pass. Real Premiere cut/align/anchor tests remain outstanding; this package is not proof that all host features work.

No C-drive installation was performed in this correction pass. Install the new package and test on a disposable sequence with selected timeline clips.
