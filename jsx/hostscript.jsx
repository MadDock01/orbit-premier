// SFX Command Center - Host script (ExtendScript)
// Runs inside Premiere Pro (PPRO) or After Effects (AEFT).

// Persistent FX clipboard, kept in the ExtendScript engine's own memory for
// the lifetime of the AE session. Copy FX / Paste FX read and write this
// directly instead of round-tripping the data through evalScript(), since
// that bridge silently truncates very large strings (many effects/
// keyframes/shape contents) in both directions.
var compxClipboardSlots = { 1: null, 2: null, 3: null };
var compxHostFallbackTotal = 0;
var compxHostFallbackCounts = {};

// Empty catches in the host script represent optional/version-dependent Adobe
// API probes. Every one is routed here so it remains non-fatal but auditable.
function compxAuditFallback(code, error) {
  var key = String(code || "HOST_OPTIONAL_FALLBACK");
  compxHostFallbackTotal++;
  compxHostFallbackCounts[key] = (compxHostFallbackCounts[key] || 0) + 1;
}

function compx_getHostDiagnostics() {
  var json = '{"total":' + compxHostFallbackTotal + ',"codes":[';
  var first = true;
  for (var key in compxHostFallbackCounts) {
    if (!compxHostFallbackCounts.hasOwnProperty(key)) continue;
    if (!first) json += ',';
    first = false;
    json += '{"code":"' + escapeJson(key) + '","count":' + compxHostFallbackCounts[key] + '}';
  }
  json += ']}';
  return dataResult(true, null, json);
}

// ---------- JSON helpers (no JSON.stringify in ExtendScript ES3) ----------

function escapeJson(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/"/g,  '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function makeResult(success, inserted, error, warning) {
  var r = "{";
  r += '"success":'  + (success  ? "true" : "false");
  r += ',"inserted":' + (inserted ? "true" : "false");
  if (error)   r += ',"error":"'   + escapeJson(error)   + '"';
  if (warning) r += ',"warning":"' + escapeJson(warning) + '"';
  r += "}";
  return r;
}

// ---------- Host detection ----------
// NOTE: Do NOT rely on app.name string matching — the name changes across
// versions (e.g. "Adobe After Effects 2025").  Instead, detect by the
// presence of host-specific API objects.

function isAfterEffects() {
  try {
    // CompItem class is only defined in After Effects.
    return typeof CompItem !== "undefined";
  } catch (e) { return false; }
}

function isPremiere() {
  try {
    // activeSequence is only defined in Premiere Pro's project object.
    return typeof app !== "undefined" &&
           app.project &&
           typeof app.project.activeSequence !== "undefined";
  } catch (e) { return false; }
}

// ---------- Track / clip helpers ----------

// Pad a string to length n with leading zeros (for safe string-based numeric compare).
function padLeft(s, n) {
  s = String(s);
  while (s.length < n) s = "0" + s;
  return s;
}

// Compare two ticks values (strings or numbers) without overflow.
// Returns true when a < b.
function ticksLessThan(a, b) {
  a = padLeft(a, 20);
  b = padLeft(b, 20);
  return a < b;
}

/// Returns true when the new clip [newStart, newEnd] would overlap an existing
// clip on this track.  Uses the standard interval-intersection formula:
//   A overlaps B  ⟺  A.start < B.end  AND  A.end > B.start
function trackHasOverlap(track, newStart, newEnd) {
  try {
    var n = track.clips.numItems;
    for (var i = 0; i < n; i++) {
      try {
        var clip = track.clips[i];
        var existStart, existEnd;

        // Strategy 1: .seconds (float) — most reliable when available
        try {
          existStart = Number(clip.start.seconds);
          existEnd   = Number(clip.end.seconds);
          if (isNaN(existStart) || isNaN(existEnd) || existEnd <= 0) throw "bad";
        } catch (se) {
          // Strategy 2: padded-string ticks comparison converted to pseudo-seconds
          // (sufficient for ordering; we just need a consistent numeric scale)
          existStart = Number(clip.start.ticks) / 254016000;
          existEnd   = Number(clip.end.ticks)   / 254016000;
        }

        // Interval overlap: new clip overlaps existing iff newStart < existEnd AND newEnd > existStart
        if (newStart < existEnd && newEnd > existStart) return true;
      } catch (clipErr) { compxAuditFallback("HOST_TRACKHASOVERLAP_001", clipErr); }
    }
  } catch (e) { compxAuditFallback("HOST_TRACKHASOVERLAP_002", e); }
  return false;
}

function findFreeAudioTrack(seq, newStart, newEnd) {
  try {
    var n = seq.audioTracks.numTracks;
    for (var i = 0; i < n; i++) {
      if (!trackHasOverlap(seq.audioTracks[i], newStart, newEnd)) return seq.audioTracks[i];
    }
  } catch (e) { compxAuditFallback("HOST_FINDFREEAUDIOTRACK_001", e); }
  return null;
}

// Same idea as findFreeAudioTrack, but returns a numeric track index
// (0-based) instead of a track object — sequence.importMGT() takes track
// *indices*, not track objects.
function findFreeTrackIndex(tracksCollection, newStart, newEnd) {
  try {
    var n = tracksCollection.numTracks;
    for (var i = 0; i < n; i++) {
      if (!trackHasOverlap(tracksCollection[i], newStart, newEnd)) return i;
    }
  } catch (e) { compxAuditFallback("HOST_FINDFREETRACKINDEX_001", e); }
  return -1;
}

// Get item duration in seconds.
// projectItem.getMediaDuration() returns a Time object in Premiere Pro.
function getItemDurationSec(item) {
  try {
    var dur = item.getMediaDuration();
    // Time object with .seconds property
    if (dur && typeof dur.seconds !== "undefined") return Number(dur.seconds);
    // Numeric ticks value (some API variants)
    if (typeof dur === "number" && dur > 0) return dur / 254016000000;
    // String ticks
    var n = Number(dur);
    if (!isNaN(n) && n > 0) return n / 254016000000;
  } catch (e) { compxAuditFallback("HOST_GETITEMDURATIONSEC_001", e); }
  // Fallback: assume a generous 5-minute clip so we never miss an overlap
  return 300;
}


// ---------- insertClip: try multiple argument styles defensively ----------

function tryInsertClip(track, item, playhead) {
  // Premiere's insertClip API signature differs across versions.
  // Try the documented (Time object) form first, then numeric fallbacks.

  // Attempt 1: Time object (documented API)
  try { track.insertClip(item, playhead); return true; } catch (e1) { compxAuditFallback("HOST_TRYINSERTCLIP_001", e1); }

  // Attempt 2: seconds as a number
  try { track.insertClip(item, playhead.seconds); return true; } catch (e2) { compxAuditFallback("HOST_TRYINSERTCLIP_002", e2); }

  // Attempt 3: ticks as a plain number (may lose precision on very long timelines)
  try {
    var tn = Number(playhead.ticks);
    if (!isNaN(tn)) { track.insertClip(item, tn); return true; }
  } catch (e3) { compxAuditFallback("HOST_TRYINSERTCLIP_003", e3); }

  // Attempt 4: ticks as a string (some older CEP versions accept this)
  try { track.insertClip(item, String(playhead.ticks)); return true; } catch (e4) { compxAuditFallback("HOST_TRYINSERTCLIP_004", e4); }

  return false;
}

// ---------- importMGT: try multiple argument styles defensively ----------
// sequence.importMGT(path, time, videoTrackIndex, audioTrackIndex) is the
// real Premiere API for placing a .mogrt directly onto the timeline as a
// graphic clip — .mogrt files can't be imported into the Project panel
// (Premiere always routes them to the Graphics Templates/Local Templates
// panel instead), so the old importFiles()+insertClip() approach used for
// audio never actually worked for MOGRTs.
function tryImportMGT(seq, filePath, playhead, videoTrackIndex, audioTrackIndex) {
  // Attempt 1: ticks (documented/most commonly working form)
  try {
    var r1 = seq.importMGT(filePath, playhead.ticks, videoTrackIndex, audioTrackIndex);
    if (r1) return r1;
  } catch (e1) { compxAuditFallback("HOST_TRYIMPORTMGT_001", e1); }

  // Attempt 2: seconds as a number
  try {
    var r2 = seq.importMGT(filePath, playhead.seconds, videoTrackIndex, audioTrackIndex);
    if (r2) return r2;
  } catch (e2) { compxAuditFallback("HOST_TRYIMPORTMGT_002", e2); }

  // Attempt 3: ticks as a plain Number
  try {
    var tn = Number(playhead.ticks);
    if (!isNaN(tn)) {
      var r3 = seq.importMGT(filePath, tn, videoTrackIndex, audioTrackIndex);
      if (r3) return r3;
    }
  } catch (e3) { compxAuditFallback("HOST_TRYIMPORTMGT_003", e3); }

  // Attempt 4: ticks as a string
  try {
    var r4 = seq.importMGT(filePath, String(playhead.ticks), videoTrackIndex, audioTrackIndex);
    if (r4) return r4;
  } catch (e4) { compxAuditFallback("HOST_TRYIMPORTMGT_004", e4); }

  return null;
}

function tryAddAudioTrack(seq) {
  try {
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    qeSeq.addTracks(0, 0, 1); // 0 video, insert-at 0, 1 audio
    var n = seq.audioTracks.numTracks;
    return n > 0 ? seq.audioTracks[n - 1] : null;
  } catch (e) { return null; }
}

function tryAddVideoTrack(seq) {
  try {
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    qeSeq.addTracks(1, 0, 0); // 1 video, insert-at 0, 0 audio
    var n = seq.videoTracks.numTracks;
    return n > 0 ? seq.videoTracks[n - 1] : null;
  } catch (e) { return null; }
}

function findProjectItemByName(bin, name) {
  try {
    var n = bin.children.numItems;
    for (var i = 0; i < n; i++) {
      var child = bin.children[i];
      if (child.name === name) return child;
      if (child.children) {
        var found = findProjectItemByName(child, name);
        if (found) return found;
      }
    }
  } catch (e) { compxAuditFallback("HOST_FINDPROJECTITEMBYNAME_001", e); }
  return null;
}

function compxVolumePercentToDb(percent) {
  var p = Number(percent);
  if (isNaN(p)) p = 100;
  if (p <= 0) return -192;
  return 20 * (Math.log(p / 100) / Math.LN10);
}

function compxSetPropertyValue(prop, value) {
  if (!prop) return false;
  try { prop.setValue(value, 1); return true; } catch (e1) { compxAuditFallback("HOST_COMPXSETPROPERTYVALUE_001", e1); }
  try { prop.setValue(value, true); return true; } catch (e2) { compxAuditFallback("HOST_COMPXSETPROPERTYVALUE_002", e2); }
  try { prop.setValue(value); return true; } catch (e3) { compxAuditFallback("HOST_COMPXSETPROPERTYVALUE_003", e3); }
  return false;
}

function pproApplyTrackItemVolume(trackItem, volumePercent) {
  // Premiere's visible effect stack contains Volume, Channel Volume and
  // Panner. Only Volume > Level is the clip gain control. The old broad
  // "audio/volume" search could write a dB value into Channel Volume and
  // silence the clip when the slider was below 100%.
  var percent = Number(volumePercent);
  if (isNaN(percent)) percent = 100;
  percent = Math.max(0, Math.min(200, percent));
  var db = compxVolumePercentToDb(percent); // 100% = 0 dB unity gain
  try {
    var components = trackItem && trackItem.components;
    if (!components) return false;
    var count = components.numItems || components.length || 0;
    var volumeComponent = null;

    // Prefer the component whose name is exactly "Volume". Do not use
    // Channel Volume or Panner: those have incompatible parameter shapes.
    for (var i = 0; i < count; i++) {
      var component = components[i];
      var name = String((component && (component.displayName || component.name || component.matchName)) || "").toLowerCase();
      if (name === "volume" || name === "audio volume") { volumeComponent = component; break; }
    }
    if (!volumeComponent) return false;

    var props = volumeComponent.properties || volumeComponent.parameters;
    var propCount = props ? (props.numItems || props.length || 0) : 0;
    for (var j = 0; j < propCount; j++) {
      var prop = props[j];
      var propName = String((prop && (prop.displayName || prop.name || prop.matchName)) || "").toLowerCase();
      // Native Premiere clip gain parameter is named Level. No fallback to
      // generic volume/channel parameters—those were the mute regression.
      if (propName === "level" || propName === "volume level") {
        return compxSetPropertyValue(prop, db);
      }
    }
  } catch (e) { compxAuditFallback("HOST_PPROAPPLYTRACKITEMVOLUME_001", e); }
  return false;
}

function pproApplyTrackItemPitch(trackItem, track, sequence, pitchSemitones) {
  var semis = Number(pitchSemitones) || 0;
  if (semis === 0) return true;
  var ratio = Math.pow(2, semis / 12);

  // Some Premiere releases expose a direct speed setter. Keep audio pitch
  // unlocked: changing clip speed is the most predictable semitone shift.
  try { if (trackItem && typeof trackItem.setSpeed === "function") { trackItem.setSpeed(ratio, false); return true; } } catch (e1) { compxAuditFallback("HOST_PPRO_PITCH_SPEED_001", e1); }
  try { if (trackItem && typeof trackItem.setPlaybackSpeed === "function") { trackItem.setPlaybackSpeed(ratio, false); return true; } } catch (e2) { compxAuditFallback("HOST_PPRO_PITCH_SPEED_002", e2); }

  // Preferred fallback: add Premiere's native Pitch Shifter through QE, then
  // set its Transpose/Semitones parameter through the public component list.
  try {
    app.enableQE();
    var qeSeq = qe && qe.project ? qe.project.getActiveSequence() : null;
    var effect = qe && qe.project ? qe.project.getAudioEffectByName("Pitch Shifter") : null;
    if (!effect && qe && qe.project) effect = qe.project.getAudioEffectByName("PitchShifter");
    if (qeSeq && effect && sequence && track) {
      var trackIndex = -1;
      for (var ti = 0; ti < sequence.audioTracks.numTracks; ti++) {
        try { if (sequence.audioTracks[ti] === track) { trackIndex = ti; break; } } catch (te) {}
      }
      if (trackIndex >= 0) {
        var qeTrack = qeSeq.getAudioTrackAt(trackIndex);
        var qeCount = qeTrack ? (qeTrack.numItems || 0) : 0;
        var qeClip = null;
        for (var qi = 0; qi < qeCount; qi++) {
          var candidate = qeTrack.getItemAt(qi);
          try {
            var qs = Number(candidate.start.secs !== undefined ? candidate.start.secs : candidate.start.seconds);
            var ts = Number(trackItem.start.seconds);
            if (!isNaN(qs) && !isNaN(ts) && Math.abs(qs - ts) < 0.06) { qeClip = candidate; break; }
          } catch (qeMatchErr) {}
        }
        if (qeClip && typeof qeClip.addAudioEffect === "function") qeClip.addAudioEffect(effect);
      }
    }

    var components = trackItem && trackItem.components;
    var count = components ? (components.numItems || components.length || 0) : 0;
    for (var i = 0; i < count; i++) {
      var component = components[i];
      var cn = String((component && (component.displayName || component.name || component.matchName)) || "").toLowerCase();
      if (cn.indexOf("pitch") === -1 && cn.indexOf("transpose") === -1) continue;
      var props = component.properties || component.parameters;
      var pc = props ? (props.numItems || props.length || 0) : 0;
      for (var j = 0; j < pc; j++) {
        var prop = props[j];
        var pn = String((prop && (prop.displayName || prop.name || prop.matchName)) || "").toLowerCase();
        var value = null;
        if (pn.indexOf("semitone") >= 0 || pn.indexOf("pitch") >= 0) value = semis;
        else if (pn.indexOf("transpose") >= 0 || pn.indexOf("ratio") >= 0) value = ratio;
        else if (pn.indexOf("cent") >= 0) value = semis * 100;
        if (value !== null && compxSetPropertyValue(prop, value)) return true;
      }
    }
  } catch (e3) { compxAuditFallback("HOST_PPRO_PITCH_SHIFTER_001", e3); }
  return false;
}

function pproFindInsertedClip(track, item, playheadSec) {
  try {
    var n = track.clips.numItems;
    var best = null;
    var bestDelta = 999999;
    for (var i = 0; i < n; i++) {
      var clip = track.clips[i];
      var same = false;
      try { same = clip.projectItem === item; } catch (e1) { compxAuditFallback("HOST_PPROFINDINSERTEDCLIP_001", e1); }
      if (!same) {
        try { same = String(clip.name || "") === String(item.name || ""); } catch (e2) { compxAuditFallback("HOST_PPROFINDINSERTEDCLIP_002", e2); }
      }
      if (!same) continue;
      var startSec = 0, endSec = 0;
      try { startSec = Number(clip.start.seconds); endSec = Number(clip.end.seconds); }
      catch (e3) { compxAuditFallback("HOST_PPROFINDINSERTEDCLIP_003", e3); }
      if (isNaN(startSec) || isNaN(endSec)) continue;
      if (playheadSec < startSec - 0.05 || playheadSec > endSec + 0.05) continue;
      var delta = Math.abs(startSec - playheadSec);
      if (!best || delta < bestDelta) { best = clip; bestDelta = delta; }
    }
    return best;
  } catch (e) { compxAuditFallback("HOST_PPROFINDINSERTEDCLIP_004", e); }
  return null;
}

function aeftApplyLayerVolume(layer, volumePercent) {
  var percent = Number(volumePercent);
  if (isNaN(percent) || percent === 100) return true;
  var db = compxVolumePercentToDb(percent);
  try {
    var audioGroup = layer.property("ADBE Audio Group");
    var audioLevels = audioGroup ? audioGroup.property("ADBE Audio Levels") : null;
    if (!audioLevels) return false;
    audioLevels.setValue([db, db]);
    return true;
  } catch (e) { compxAuditFallback("HOST_AEFTAPPLYLAYERVOLUME_001", e); }
  return false;
}

// ---------- Premiere Pro — SFX ----------

function ppro_importAndInsert(filePath, insertOnTimeline, pitchSemitones, volumePercent) {
  var step = "init";
  try {
    step = "check-project";
    if (!app.project) return makeResult(false, false, "No open project.");

    // importFiles() return value is unreliable across Premiere versions —
    // we verify success by finding the item in the bin afterwards.
    step = "import";
    try {
      app.project.importFiles(
        [filePath], true,
        app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem,
        false
      );
    } catch (importErr) {
      // importFiles throws if already imported — that's fine, continue.
    }

    step = "find-item";
    var name = filePath.replace(/^.*[\\\/]/, "");
    var item = findProjectItemByName(app.project.rootItem, name);
    if (!item) {
      return makeResult(false, false, "Import failed: \"" + name + "\" not found in project bin.");
    }

    if (!insertOnTimeline) return makeResult(true, false);

    step = "get-sequence";
    var seq = app.project.activeSequence;
    if (!seq) return makeResult(true, false, null, "No active sequence to insert into.");

    step = "get-playhead";
    var playhead    = seq.getPlayerPosition();
    var playheadSec   = Number(playhead.seconds);
    var playheadTicks = String(playhead.ticks);

    step = "find-track";
    var duration = getItemDurationSec(item);
    var track = findFreeAudioTrack(seq, playheadSec, playheadSec + duration);
    if (!track) track = tryAddAudioTrack(seq);
    if (!track) {
      return makeResult(true, false, null,
        "Imported to project, but every audio track is occupied at the playhead range. " +
        "Add a free audio track and try again.");
    }

    step = "insert-clip";
    var ok = tryInsertClip(track, item, playhead);
    if (!ok) {
      return makeResult(false, false,
        "insertClip failed at step '" + step + "'. " +
        "File was imported to the project bin but could not be placed on the timeline.");
    }

    step = "apply-audio-settings";
    var volumeApplied = true;
    var pitchApplied = true;
    var insertedClip = pproFindInsertedClip(track, item, playheadSec);
    // Write 0 dB even at 100% so a stale/muted Volume > Level value is
    // corrected on every new SFX insert.
    volumeApplied = insertedClip ? pproApplyTrackItemVolume(insertedClip, volumePercent) : false;
    if (Number(pitchSemitones) !== 0) pitchApplied = insertedClip ? pproApplyTrackItemPitch(insertedClip, track, seq, pitchSemitones) : false;

    if (volumeApplied && pitchApplied) return makeResult(true, true);
    var missed = [];
    if (!volumeApplied) missed.push("volume");
    if (!pitchApplied) missed.push("pitch");
    return makeResult(true, true, null, "Inserted on the timeline, but automatic " + missed.join(" and ") + " adjustment could not be applied in this Premiere version.");
  } catch (e) {
    return makeResult(false, false, "Unexpected error at step '" + step + "': " + String(e));
  }
}

// ---------- After Effects — SFX ----------

function aeft_importAndInsert(filePath, insertOnTimeline, pitchSemitones, volumePercent) {
  var step = "init";
  try {
    step = "check-project";
    var proj = app.project;
    if (!proj) return makeResult(false, false, "No open project.");

    var semis = Number(pitchSemitones) || 0;
    var speedRatio = Math.pow(2, semis / 12); // semitones → speed multiplier

    step = "import";
    app.beginUndoGroup("Import SFX");
    var file          = new File(filePath);
    var importOptions = new ImportOptions(file);
    var footageItem   = proj.importFile(importOptions);

    var inserted = false;
    if (insertOnTimeline) {
      step = "add-to-comp";
      var comp = proj.activeItem;
      if (comp && comp instanceof CompItem) {
        var layer = comp.layers.add(footageItem);
        layer.startTime = comp.time;
        // Apply pitch via time stretch (converted from semitones)
        if (speedRatio !== 1) {
          layer.stretch = (1 / speedRatio) * 100;
        }
        aeftApplyLayerVolume(layer, volumePercent);
        inserted = true;
      }
    }

    app.endUndoGroup();
    return makeResult(true, inserted);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AEFT_IMPORTANDINSERT_001", e2); }
    return makeResult(false, false, "Error at step '" + step + "': " + String(e));
  }
}

// ---------- Premiere Pro — MOGRT ----------

function ppro_importAndInsertMogrt(filePath, insertOnTimeline) {
  var step = "init";
  try {
    step = "check-project";
    if (!app.project) return makeResult(false, false, "No open project.");

    step = "get-sequence";
    var seq = app.project.activeSequence;

    // .mogrt files can never land in the Project panel — Premiere always
    // routes app.project.importFiles() for a .mogrt into the Graphics
    // Templates / Local Templates panel instead (that's Premiere's own
    // behavior, not a bug in this script). So when there's no active
    // sequence to insert into, importFiles() is the only thing we *can* do.
    if (!seq) {
      step = "import-fallback";
      try {
        app.project.importFiles(
          [filePath], true,
          app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem,
          false
        );
      } catch (importErr) { compxAuditFallback("HOST_PPRO_IMPORTANDINSERTMOGRT_001", importErr); }
      return makeResult(true, false, null,
        "No active sequence — added to Graphics Templates only. Open/select a sequence and try again to insert on the timeline.");
    }

    if (!insertOnTimeline) {
      step = "import-only";
      try {
        app.project.importFiles(
          [filePath], true,
          app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem,
          false
        );
      } catch (importErr) { compxAuditFallback("HOST_PPRO_IMPORTANDINSERTMOGRT_002", importErr); }
      return makeResult(true, false);
    }

    step = "get-playhead";
    var playhead    = seq.getPlayerPosition();
    var playheadSec = Number(playhead.seconds);

    // MOGRT duration isn't known until after it's placed, so this is a
    // heuristic footprint used only to pick a free track slot at the
    // playhead — it doesn't affect the clip's actual inserted length.
    var ASSUMED_FOOTPRINT_SEC = 5;

    step = "find-video-track";
    var videoTrackIndex = findFreeTrackIndex(seq.videoTracks, playheadSec, playheadSec + ASSUMED_FOOTPRINT_SEC);
    if (videoTrackIndex === -1) {
      if (tryAddVideoTrack(seq)) videoTrackIndex = seq.videoTracks.numTracks - 1;
    }
    if (videoTrackIndex === -1) {
      return makeResult(false, false, null,
        "Every video track is occupied at the playhead. Add a free video track and try again.");
    }

    step = "find-audio-track";
    // Most MOGRTs are video-only; audioTrackIndex is only used if the
    // template happens to carry audio, so default to 0 when nothing better
    // is free.
    var audioTrackIndex = 0;
    try {
      var freeAudio = findFreeTrackIndex(seq.audioTracks, playheadSec, playheadSec + ASSUMED_FOOTPRINT_SEC);
      if (freeAudio !== -1) audioTrackIndex = freeAudio;
    } catch (audioErr) { compxAuditFallback("HOST_PPRO_IMPORTANDINSERTMOGRT_003", audioErr); }

    step = "import-mgt";
    var trackItem = tryImportMGT(seq, filePath, playhead, videoTrackIndex, audioTrackIndex);
    if (!trackItem) {
      return makeResult(false, false,
        "importMGT failed at step '" + step + "'. The .mogrt may be invalid or incompatible with this Premiere version.");
    }

    return makeResult(true, true);
  } catch (e) {
    return makeResult(false, false, "Unexpected error at step '" + step + "': " + String(e));
  }
}

// ---------- After Effects — MOGRT ----------
// Strategy:
//   1. Try app.project.importFile() — AE 2022+ can import .mogrt and
//      automatically creates a comp from the template.
//   2. If that fails, reveal the file in Explorer/Finder so the user
//      can drag it to the Essential Graphics panel manually.

function aeft_importMogrt(filePath) {
  try {
    var f = new File(filePath);
    if (!f || !f.exists) {
      return makeResult(false, false, "File not found: " + filePath);
    }

    // Attempt 1: importFile — works in AE 2022+ for .mogrt files
    var importedItem = null;
    try {
      var opts = new ImportOptions(f);
      importedItem = app.project.importFile(opts);
    } catch (importErr) {
      importedItem = null;
    }

    if (importedItem) {
      // If AE created a comp, open it in the viewer
      if (importedItem instanceof CompItem) {
        importedItem.openInViewer();
        return makeResult(true, true,
          "\"" + importedItem.name + "\" imported as a comp from MOGRT template.");
      }
      // Footage item — still usable
      return makeResult(true, false,
        "\"" + f.name + "\" added to project. Drag it from the Project panel to your comp.");
    }

    // Attempt 2: reveal file so user can drag to Essential Graphics panel
    f.parent.execute(); // opens the containing folder in Explorer/Finder
    return makeResult(false, false,
      "AE could not auto-import this MOGRT (requires AE 2022+). " +
      "The folder has been opened for you — drag the file into the " +
      "Essential Graphics panel (Window > Essential Graphics) to apply it.");

  } catch (e) {
    return makeResult(false, false, String(e));
  }
}

// ---------- After Effects — MOGRT via unpacked AE project ----------
// The panel unzips the .mogrt and hands us the internal AE project (.aep)
// plus, when known, the primary comp name (from definition.json). We import
// that project, locate the template comp, and either add it to the active
// comp at the playhead (the AE equivalent of "applying" a graphic) or open
// it in the viewer. This lets the SAME .mogrt work in both Premiere and AE.
function aeft_importMogrtProject(aepPath, compName, insertOnTimeline) {
  try {
    var f = new File(aepPath);
    if (!f || !f.exists) return makeResult(false, false, "Extracted AE project not found: " + aepPath);

    var proj = app.project;

    // Remember which comps already existed so we can detect the new ones.
    var before = {};
    for (var i = 1; i <= proj.numItems; i++) {
      if (proj.item(i) instanceof CompItem) before[proj.item(i).id] = true;
    }

    app.beginUndoGroup("Import MOGRT Template");

    var io = new ImportOptions(f);
    var imported = null;
    try {
      imported = proj.importFile(io);
    } catch (impErr) {
      app.endUndoGroup();
      return makeResult(false, false, "AE could not import the template project: " + String(impErr));
    }

    // Collect comps that appeared after the import.
    var newComps = [];
    for (var j = 1; j <= proj.numItems; j++) {
      var it = proj.item(j);
      if (it instanceof CompItem && !before[it.id]) newComps.push(it);
    }

    // Pick the target comp. Preference order:
    //   1) exact name match from definition.json (capsule/template name),
    //   2) a "root" comp — one NOT used as a layer source inside any other new
    //      comp (i.e. the main template, not a precomp),
    //   3) the new comp with the most layers,
    //   4) whatever importFile() returned.
    var target = null;
    if (compName) {
      for (var k = 0; k < newComps.length; k++) {
        if (newComps[k].name === compName) { target = newComps[k]; break; }
      }
    }
    if (!target && newComps.length) {
      // Mark every comp that is used as a layer source within the new set.
      var usedAsSource = {};
      for (var a = 0; a < newComps.length; a++) {
        var c = newComps[a];
        for (var L = 1; L <= c.numLayers; L++) {
          try {
            var src = c.layer(L).source;
            if (src && src instanceof CompItem) usedAsSource[src.id] = true;
          } catch (srcErr) { compxAuditFallback("HOST_AEFT_IMPORTMOGRTPROJECT_001", srcErr); }
        }
      }
      // Roots = new comps that nobody else references.
      var roots = [];
      for (var b = 0; b < newComps.length; b++) {
        if (!usedAsSource[newComps[b].id]) roots.push(newComps[b]);
      }
      var pool = roots.length ? roots : newComps;
      target = pool[0];
      for (var m = 1; m < pool.length; m++) {
        if (pool[m].numLayers > target.numLayers) target = pool[m];
      }
    }
    if (!target && imported instanceof CompItem) target = imported;

    if (!target) {
      app.endUndoGroup();
      return makeResult(true, false, null,
        "Template imported into the Project panel, but no comp was found to place. Open it from there.");
    }

    // If there's a different active comp, drop the template into it as a layer
    // at the current playhead — the AE equivalent of "applying" a mogrt.
    var active = getActiveComp();
    if (insertOnTimeline && active && active.id !== target.id) {
      var layer = active.layers.add(target);
      try { layer.startTime = active.time; } catch (stErr) { compxAuditFallback("HOST_AEFT_IMPORTMOGRTPROJECT_002", stErr); }
      app.endUndoGroup();
      return makeResult(true, true, null, null);
    }

    // Otherwise just open the imported template comp.
    target.openInViewer();
    app.endUndoGroup();
    return makeResult(true, false, null,
      "Template comp \"" + target.name + "\" opened. Open a comp and insert again to place it as a layer.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AEFT_IMPORTMOGRTPROJECT_003", e2); }
    return makeResult(false, false, String(e));
  }
}

// Honest fallback: a Premiere-authored .mogrt has no AE project inside, so
// AE truly cannot use it. Reveal the file and say so plainly.
function aeft_revealMogrt(filePath) {
  try {
    var f = new File(filePath);
    if (f && f.exists && f.parent) f.parent.execute();
  } catch (e) { compxAuditFallback("HOST_AEFT_REVEALMOGRT_001", e); }
  return makeResult(false, false,
    "This .mogrt has no After Effects project inside it (it was authored in Premiere), so AE can't use it \u2014 it works in Premiere Pro. The containing folder has been opened.");
}

// Returns cache-backed footage paths currently referenced by the open AE
// project. The panel uses this list to protect active assets when the user
// explicitly clears unused MOGRT cache folders.
function aeft_getReferencedCompXCachePaths(cacheRoot) {
  try {
    if (!isAfterEffects()) return dataResult(true, null, '{"paths":[]}');
    var root = String(cacheRoot || "").replace(/\\/g, "/").toLowerCase();
    var paths = [];
    var seen = {};
    if (root && app.project) {
      for (var i = 1; i <= app.project.numItems; i++) {
        try {
          var item = app.project.item(i);
          if (!(item instanceof FootageItem) || !item.file) continue;
          var filePath = String(item.file.fsName || item.file.fullName || "");
          var normalized = filePath.replace(/\\/g, "/").toLowerCase();
          if (normalized.indexOf(root + "/") !== 0 || seen[filePath]) continue;
          seen[filePath] = true;
          paths.push(filePath);
        } catch (itemError) { compxAuditFallback("HOST_AEFT_GETREFERENCEDCOMPXCACHEPATHS_001", itemError); }
      }
    }
    var json = '{"paths":[';
    for (var p = 0; p < paths.length; p++) {
      if (p) json += ',';
      json += '"' + escapeJson(paths[p]) + '"';
    }
    json += ']}';
    return dataResult(true, null, json);
  } catch (e) {
    return dataResult(false, "Could not inspect active cache references.", '{"paths":[]}');
  }
}

// ---------- Unified entry points called from the panel ----------

function importMogrt(filePath, insertOnTimeline) {
  if (isAfterEffects()) return aeft_importMogrt(filePath);
  if (isPremiere())     return ppro_importAndInsertMogrt(filePath, insertOnTimeline);
  // Last-resort fallback
  return makeResult(false, false, "Could not detect host application. Restart the app and try again.");
}

function importSfx(filePath, insertOnTimeline, pitchSemitones, volumePercent) {
  if (isAfterEffects()) return aeft_importAndInsert(filePath, insertOnTimeline, pitchSemitones, volumePercent);
  if (isPremiere())     return ppro_importAndInsert(filePath, insertOnTimeline, pitchSemitones, volumePercent);
  // Last-resort fallback
  return makeResult(false, false, "Could not detect host application. Restart the app and try again.");
}

// ================================================================
// AE TOOLS TAB — Align / Anchor / Precomp / Layer Creation /
// Number Counter / Utilities. All original ExtendScript, AEFT only.
// ================================================================
function toolResult(success, msg) {
  var r = "{";
  r += '"success":' + (success ? "true" : "false");
  if (msg) r += ',"message":"' + escapeJson(msg) + '"';
  r += "}";
  return r;
}
// ---------- COMPOSITION LIBRARY ----------
// Saves a reduced standalone project, a poster PNG and preview frames. This
// is After Effects-only; the panel presents the host error in Premiere.
function compxCompositionPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function compxCompositionName(value) {
  var s = String(value || "");
  var i, ch, start = 0, end = s.length - 1;
  while (start <= end && s.charCodeAt(start) <= 32) start++;
  while (end >= start && s.charCodeAt(end) <= 32) end--;
  s = s.slice(start, end + 1);
  var out = "";
  var forbidden = "\\/:<>|?*\"";
  for (i = 0; i < s.length; i++) {
    ch = s.charAt(i);
    if (ch.charCodeAt(0) <= 32 || forbidden.indexOf(ch) >= 0) {
      out += "_";
    } else {
      out += ch;
    }
  }
  return out;
}


function compxRemoveFile(file) {
  if (!file || !file.exists) return true;
  try { return file.remove(); } catch (e) { return false; }
}

function compx_saveActiveComposition(targetPath, customName) {
  if (!isAfterEffects()) return toolResult(false, "Composition Library is available in After Effects only.");
  var comp = getActiveComp();
  if (!comp) return toolResult(false, "Open and select an active composition first.");
  // reduceProject() changes the open project while producing the standalone
  // package. A saved source project is required so it can be reopened safely.
  if (!app.project.file) return toolResult(false, "Save the current After Effects project before adding a composition.");
  targetPath = compxCompositionPath(targetPath);
  if (!targetPath) return toolResult(false, "Choose a composition storage folder first.");
  var folder = new Folder(targetPath);
  if (!folder.exists && !folder.create()) return toolResult(false, "Could not create the composition storage folder.");
  var compName = compxCompositionName(customName) || compxCompositionName(comp.name);
  if (!compName) return toolResult(false, "The composition needs a valid name.");
  var aepFile = new File(folder.fsName + "/" + compName + ".aep");
  var posterFile = new File(folder.fsName + "/" + compName + ".png");
  var framesFolder = new Folder(folder.fsName + "/" + compName + "_frames");
  try {
    if (!compxRemoveFile(aepFile)) return toolResult(false, "Cannot overwrite the existing AEP file. Close any app using it and try again.");
    compxRemoveFile(posterFile);
    if (!framesFolder.exists && !framesFolder.create()) return toolResult(false, "Could not create the preview frames folder.");
    var oldFrames = framesFolder.getFiles("*.png");
    for (var oldIndex = 0; oldIndex < oldFrames.length; oldIndex++) compxRemoveFile(oldFrames[oldIndex]);
    comp.saveFrameToPng(0, posterFile);
    var fps = Number(comp.frameRate) || 30;
    var duration = Math.max(0, Number(comp.duration) || 0);
    var sampleDuration = Math.min(1, duration);
    var maxTime = Math.max(0, duration - (1 / fps));
    for (var i = 0; i < 12; i++) {
      var time = sampleDuration * i / 11;
      time = Math.min(maxTime, Math.max(0, Math.floor(time * fps) / fps));
      var suffix = i < 10 ? "0" + i : String(i);
      comp.saveFrameToPng(time, new File(framesFolder.fsName + "/frame_" + suffix + ".png"));
    }
    var originalProject = app.project.file;
    if (originalProject) app.project.save();
    app.project.reduceProject([comp]);
    app.project.save(aepFile);
    if (originalProject && originalProject.exists) app.open(originalProject);
    return dataResult(true, "Composition saved", '"' + escapeJson(compName) + '"');
  } catch (e) {
    return toolResult(false, "Could not save composition: " + e.toString());
  }
}

function compx_importComposition(filePath) {
  if (!isAfterEffects()) return toolResult(false, "Composition Library is available in After Effects only.");
  var file = new File(compxCompositionPath(filePath));
  if (!file.exists) return toolResult(false, "Composition file was not found.");
  try { app.project.importFile(new ImportOptions(file)); return toolResult(true, "Composition imported"); }
  catch (e) { return toolResult(false, "Could not import composition: " + e.toString()); }
}

function compx_renameComposition(filePath, newName) {
  var file = new File(compxCompositionPath(filePath));
  if (!file.exists) return toolResult(false, "Composition file was not found.");
  var cleanName = compxCompositionName(newName);
  if (!cleanName) return toolResult(false, "Enter a valid composition name.");
  var poster = new File(file.fsName.replace(/\\.aep$/i, ".png"));
  var frames = new Folder(file.fsName.replace(/\\.aep$/i, "_frames"));
  try {
    if (!file.rename(cleanName + ".aep")) return toolResult(false, "Could not rename the composition file.");
    if (poster.exists && !poster.rename(cleanName + ".png")) return toolResult(false, "AEP renamed, but the poster preview could not be renamed.");
    if (frames.exists && !frames.rename(cleanName + "_frames")) return toolResult(false, "AEP renamed, but the preview frames folder could not be renamed.");
    return dataResult(true, "Composition renamed", '"' + escapeJson(cleanName) + '"');
  } catch (e) { return toolResult(false, "Could not rename composition: " + e.toString()); }
}

function compx_deleteComposition(filePath) {
  var file = new File(compxCompositionPath(filePath));
  if (!file.exists) return toolResult(false, "Composition file was not found.");
  var poster = new File(file.fsName.replace(/\\.aep$/i, ".png"));
  var frames = new Folder(file.fsName.replace(/\\.aep$/i, "_frames"));
  try {
    if (!file.remove()) return toolResult(false, "Could not delete the composition file. It may be in use.");
    if (poster.exists && !poster.remove()) return toolResult(false, "AEP deleted, but the poster preview could not be removed.");
    if (frames.exists) {
      var files = frames.getFiles("*.png");
      for (var i = 0; i < files.length; i++) if (!files[i].remove()) return toolResult(false, "AEP deleted, but a preview frame is locked.");
      if (!frames.remove()) return toolResult(false, "AEP deleted, but the preview folder could not be removed.");
    }
    return toolResult(true, "Composition deleted");
  } catch (e) { return toolResult(false, "Could not delete composition: " + e.toString()); }
}

function getActiveComp() {
  var proj = app.project;
  if (!proj) return null;
  var item = proj.activeItem;
  if (item && item instanceof CompItem) return item;
  return null;
}

function getSelectedLayers(comp) {
  var sel = [];
  for (var i = 0; i < comp.selectedLayers.length; i++) sel.push(comp.selectedLayers[i]);
  return sel;
}

// ---------- ALIGN ----------
// Aligns selected layers relative to the comp bounds (single layer)
// or relative to the overall bounding box of the selection (multi-layer).
function ae_align(mode) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Align Layers");

    // Compute reference bounding box: comp bounds if 1 layer, else selection bbox.
    var refLeft, refTop, refRight, refBottom;
    if (layers.length === 1) {
      refLeft = 0; refTop = 0; refRight = comp.width; refBottom = comp.height;
    } else {
      refLeft = Infinity; refTop = Infinity; refRight = -Infinity; refBottom = -Infinity;
      for (var i = 0; i < layers.length; i++) {
        var b = layerBoundsInComp(layers[i]);
        if (b.left   < refLeft)   refLeft   = b.left;
        if (b.top    < refTop)    refTop    = b.top;
        if (b.right  > refRight)  refRight  = b.right;
        if (b.bottom > refBottom) refBottom = b.bottom;
      }
    }

    for (var j = 0; j < layers.length; j++) {
      var layer = layers[j];
      var b2 = layerBoundsInComp(layer);
      var pos = layer.property("Position");
      if (!pos || pos.numKeys > 0) continue; // skip animated position to avoid breaking keyframes
      var val = pos.value;
      var dx = 0, dy = 0;

      if (mode === "left")    dx = refLeft   - b2.left;
      if (mode === "right")   dx = refRight  - b2.right;
      if (mode === "hcenter") dx = (refLeft + refRight) / 2 - (b2.left + b2.right) / 2;
      if (mode === "top")     dy = refTop    - b2.top;
      if (mode === "bottom")  dy = refBottom - b2.bottom;
      if (mode === "vcenter") dy = (refTop + refBottom) / 2 - (b2.top + b2.bottom) / 2;

      if (val.length === 3) pos.setValue([val[0] + dx, val[1] + dy, val[2]]);
      else pos.setValue([val[0] + dx, val[1] + dy]);
    }

    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_ALIGN_001", e2); }
    return toolResult(false, String(e));
  }
}

// Returns the layer's source-content bounding box mapped into comp space,
// using position/anchorPoint/scale (rotation ignored for simplicity).
function layerBoundsInComp(layer) {
  var w, h;
  try {
    var rect = layer.sourceRectAtTime ? layer.sourceRectAtTime(comp_currentTimeSafe(layer), false) : null;
    if (rect) {
      w = rect.width;
      h = rect.height;
      var pos = layer.property("Position").value;
      var anchor = layer.property("Anchor Point").value;
      var scale = layer.property("Scale").value;
      var sx = scale[0] / 100, sy = scale[1] / 100;
      var left = pos[0] - (anchor[0] - rect.left) * sx;
      var top  = pos[1] - (anchor[1] - rect.top)  * sy;
      return { left: left, top: top, right: left + w * sx, bottom: top + h * sy };
    }
  } catch (e) { compxAuditFallback("HOST_LAYERBOUNDSINCOMP_001", e); }
  // Fallback: treat as a point at Position.
  var p = layer.property("Position").value;
  return { left: p[0], top: p[1], right: p[0], bottom: p[1] };
}

function comp_currentTimeSafe(layer) {
  try { return layer.containingComp.time; } catch (e) { return 0; }
}

// ---------- ANCHOR ----------
// pos is one of: tl, t, tr, l, c, r, bl, b, br
// Moves the anchor point to the requested position within the layer's
// own bounding box while compensating Position so the layer does not
// visually shift on screen.
function ae_setAnchor(pos) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Set Anchor Point");

    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var rect = layer.sourceRectAtTime ? layer.sourceRectAtTime(comp.time, false) : null;
      if (!rect) continue;

      var nx, ny;
      var left = rect.left, top = rect.top, right = rect.left + rect.width, bottom = rect.top + rect.height;
      var midX = (left + right) / 2, midY = (top + bottom) / 2;

      if (pos === "tl") { nx = left;  ny = top; }
      if (pos === "t")  { nx = midX;  ny = top; }
      if (pos === "tr") { nx = right; ny = top; }
      if (pos === "l")  { nx = left;  ny = midY; }
      if (pos === "c")  { nx = midX;  ny = midY; }
      if (pos === "r")  { nx = right; ny = midY; }
      if (pos === "bl") { nx = left;  ny = bottom; }
      if (pos === "b")  { nx = midX;  ny = bottom; }
      if (pos === "br") { nx = right; ny = bottom; }

      var anchorProp = layer.property("Anchor Point");
      var posProp    = layer.property("Position");
      var oldAnchor  = anchorProp.value;
      var oldPos     = posProp.value;
      var scale      = layer.property("Scale").value;
      var sx = scale[0] / 100, sy = scale[1] / 100;

      var dxScreen = (nx - oldAnchor[0]) * sx;
      var dyScreen = (ny - oldAnchor[1]) * sy;

      var newAnchor = oldAnchor.length === 3 ? [nx, ny, oldAnchor[2]] : [nx, ny];
      var newPos    = oldPos.length === 3
        ? [oldPos[0] + dxScreen, oldPos[1] + dyScreen, oldPos[2]]
        : [oldPos[0] + dxScreen, oldPos[1] + dyScreen];

      anchorProp.setValue(newAnchor);
      if (posProp.numKeys === 0) posProp.setValue(newPos);
    }

    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_SETANCHOR_001", e2); }
    return toolResult(false, String(e));
  }
}

// ---------- PRECOMP ----------
function ae_precompose(moveAllAttributes) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var indices = [];
    for (var i = 0; i < layers.length; i++) indices.push(layers[i].index);

    app.beginUndoGroup("Precompose");
    var name = layers.length === 1 ? (layers[0].name + " Precomp") : (comp.name + " Precomp");
    comp.layers.precompose(indices, name, !!moveAllAttributes);
    app.endUndoGroup();
    return toolResult(true, "Precomposed: \"" + name + "\".");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_PRECOMPOSE_001", e2); }
    return toolResult(false, String(e));
  }
}

// PRECOMP SEP — precomposes each selected layer into its own individual
// comp (as opposed to ae_precompose, which bundles the whole selection
// into a single comp).
function ae_precomposeSeparate() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    // FIX: sort HIGH-to-LOW so each precompose call does not shift the
    // indices of layers still waiting to be processed.
    layers.sort(function (a, b) { return b.index - a.index; });
    var toProcess = [];
    for (var i = 0; i < layers.length; i++) {
      toProcess.push({ idx: layers[i].index, nm: layers[i].name });
    }

    app.beginUndoGroup("Precompose Separately");
    for (var i = 0; i < toProcess.length; i++) {
      comp.layers.precompose([toProcess[i].idx], toProcess[i].nm + " Precomp", true);
    }
    app.endUndoGroup();
    return toolResult(true, layers.length + " layer(s) precomposed separately.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_PRECOMPOSESEPARATE_001", e2); }
    return toolResult(false, String(e));
  }
}

// UNPRECOMP — the inverse of precompose: pulls the layers out of a selected
// precomp layer's source comp back into the current comp (preserving their
// timing via copyToComp + a startTime offset), then removes the precomp
// layer. Skips any selected layer that isn't a precomp.
// Copies a source property's value (or full keyframe animation, or
// expression) onto a destination property of the same type.
function copyAnimatedProp(fromProp, toProp) {
  try {
    if (fromProp.expressionEnabled && fromProp.expression) {
      toProp.expression = fromProp.expression;
      return;
    }
    if (fromProp.numKeys > 0) {
      for (var k = 1; k <= fromProp.numKeys; k++) {
        toProp.setValueAtTime(fromProp.keyTime(k), fromProp.keyValue(k));
      }
    } else {
      toProp.setValue(fromProp.value);
    }
  } catch (e) { compxAuditFallback("HOST_COPYANIMATEDPROP_001", e); }
}

function ae_unprecompose() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Unprecompose");
    var done = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var src = layer.source;
      if (!src || !(src instanceof CompItem)) continue;

      var offset = layer.startTime;
      var count = src.numLayers;

      // Preserve the precomp layer's own transform (Position/Scale/
      // Rotation/Opacity/Anchor Point, including keyframes) by parenting
      // every extracted top-level sublayer to a carrier null that holds
      // the same transform — AE resolves the parenting math itself, so
      // the visual result matches what the precomp layer looked like.
      var carrier = comp.layers.addNull(comp.duration);
      carrier.name = layer.name + "_TRANSFORM";
      carrier.moveBefore(layer);
      carrier.startTime = layer.startTime;
      try { copyAnimatedProp(layer.property("Anchor Point"), carrier.property("Anchor Point")); } catch (e0) { compxAuditFallback("HOST_AE_UNPRECOMPOSE_001", e0); }
      try { copyAnimatedProp(layer.property("Position"), carrier.property("Position")); } catch (e1) { compxAuditFallback("HOST_AE_UNPRECOMPOSE_002", e1); }
      try { copyAnimatedProp(layer.property("Scale"), carrier.property("Scale")); } catch (e2) { compxAuditFallback("HOST_AE_UNPRECOMPOSE_003", e2); }
      try { copyAnimatedProp(layer.property("Rotation"), carrier.property("Rotation")); } catch (e3) { compxAuditFallback("HOST_AE_UNPRECOMPOSE_004", e3); }
      try { copyAnimatedProp(layer.property("Opacity"), carrier.property("Opacity")); } catch (e4) { compxAuditFallback("HOST_AE_UNPRECOMPOSE_005", e4); }

      // Copy sublayers bottom-to-top: copyToComp() always inserts the new
      // copy at index 1 (top) of the target comp, so copying in reverse
      // source order is what keeps the final stacking order matching the
      // original precomp's layer order (copying top-to-bottom would
      // silently reverse the stack).
      for (var j = count; j >= 1; j--) {
        var subLayer = src.layer(j);
        var hadNoParent = !subLayer.parent;
        subLayer.copyToComp(comp);
        var newLayer = comp.layer(1); // copyToComp adds the copy at the top
        newLayer.startTime += offset;
        newLayer.moveBefore(layer);
        // Only re-parent sublayers that were top-level inside the precomp —
        // ones already parented to another sublayer keep that relationship
        // (or lose it gracefully) rather than being forced onto the carrier.
        if (hadNoParent) { try { newLayer.parent = carrier; } catch (pe) { compxAuditFallback("HOST_AE_UNPRECOMPOSE_006", pe); } }
      }
      layer.remove();
      done++;
    }
    app.endUndoGroup();
    return toolResult(done > 0, done > 0 ? done + " layer(s) unprecomposed." : "Select a precomposed layer to unprecompose.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_UNPRECOMPOSE_007", e2); }
    return toolResult(false, String(e));
  }
}

// Groups the selected layers under one parent null for organizational
// control (does not remove them from the current comp's layer stack).
function ae_organizeUnderNull() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Organize Under Null");
    var nullLayer = comp.layers.addNull();
    nullLayer.name = "ORGANIZE_" + layers[0].name;
    nullLayer.moveBefore(layers[0]);
    for (var i = 0; i < layers.length; i++) {
      layers[i].parent = nullLayer;
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_ORGANIZEUNDERNULL_001", e2); }
    return toolResult(false, String(e));
  }
}

// ---------- LAYER CREATION ----------
function ae_createLayer(kind, matchSelected) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    // Capture the reference layer BEFORE creating anything — creating a new
    // layer changes the selection. When "matchSelected" is ON and a layer is
    // selected, the new layer is trimmed to that layer's in/out points so it
    // spans exactly the same time range (e.g. a 10s text -> 10s null).
    var refLayer = null;
    if (matchSelected) {
      var sel = getSelectedLayers(comp);
      if (sel.length > 0) refLayer = sel[0];
    }

    var t = comp.time;
    var inPt  = (refLayer !== null) ? refLayer.inPoint  : t;
    var outPt = (refLayer !== null) ? refLayer.outPoint : comp.duration;

    app.beginUndoGroup("Create Layer");
    var newLayer = null;
    // Solid/Null/Adjustment sources are created spanning the FULL comp duration
    // so that trimming in/out to the reference range below is always valid.
    if (kind === "solid") {
      newLayer = comp.layers.addSolid([1, 1, 1], "Solid", comp.width, comp.height, comp.pixelAspect, comp.duration);
    } else if (kind === "null") {
      newLayer = comp.layers.addNull(comp.duration);
    } else if (kind === "camera") {
      newLayer = comp.layers.addCamera("Camera", [comp.width / 2, comp.height / 2]);
    } else if (kind === "text") {
      newLayer = comp.layers.addText("Text");
    } else if (kind === "adjustment") {
      newLayer = comp.layers.addSolid([1, 1, 1], "Adjustment Layer", comp.width, comp.height, comp.pixelAspect, comp.duration);
      newLayer.adjustmentLayer = true;
    } else {
      app.endUndoGroup();
      return toolResult(false, "Unknown layer type: " + kind);
    }

    if (newLayer) {
      try {
        if (refLayer !== null) {
          // Match the selected layer's timing. Setting startTime first shifts
          // the source so trimming to [inPt, outPt] stays inside the source.
          newLayer.startTime = inPt;
          newLayer.inPoint   = inPt;
          newLayer.outPoint  = outPt;
        } else if (t > 0) {
          // Default behavior: layer starts at the playhead.
          newLayer.startTime = t;
        }
      } catch (ste) { compxAuditFallback("HOST_AE_CREATELAYER_001", ste); }
    }

    app.endUndoGroup();

    if (refLayer !== null) {
      var dur = Math.round((outPt - inPt) * 100) / 100;
      return toolResult(true, kind + " layer created \u2014 matched \"" + refLayer.name + "\" (" + dur + "s).");
    }
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_CREATELAYER_002", e2); }
    return toolResult(false, String(e));
  }
}

// ---------- NUMBER COUNTER ----------
// Creates a text layer whose Source Text is driven by a Slider Control
// counting from `fromVal` to `toVal` over the comp duration, with
// optional prefix/suffix and decimal places.
function ae_createNumberCounter(fromVal, toVal, decimals, prefix, suffix, style, locale, symbolPos) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    fromVal   = Number(fromVal);
    toVal     = Number(toVal);
    decimals  = Math.max(0, Math.min(6, Math.floor(Number(decimals) || 0)));
    prefix    = prefix || "";
    suffix    = suffix || "";
    style     = style || "custom";
    locale    = locale || "us";
    symbolPos = symbolPos || "prefix";

    var groupChar = (locale === "eu") ? "." : ",";
    var decChar   = (locale === "eu") ? "," : ".";
    var indian    = (locale === "in");
    var doGroup   = (style !== "custom") && (locale !== "none");

    var symbol = "";
    if (style === "currency") symbol = "$";
    if (style === "percent")  symbol = "%";

    var pre = (style === "custom") ? prefix : ((symbol && symbolPos === "prefix") ? symbol : "");
    var suf = (style === "custom") ? suffix : ((symbol && symbolPos === "suffix") ? symbol : "");

    app.beginUndoGroup("Create Number Counter");
    var layer = comp.layers.addText(String(fromVal));
    layer.name = "Number Counter";

    var effects = layer.property("Effects");
    var slider = effects.addProperty("ADBE Slider Control");
    slider.name = "Progress";
    var sliderVal = slider.property("Slider");
    sliderVal.setValueAtTime(0, 0);
    sliderVal.setValueAtTime(comp.duration, 100);

    var textProp = layer.property("Source Text");
    var exprLines = [];
    exprLines.push('function groupStd(s, sep){');
    exprLines.push('  var out = ""; var count = 0;');
    exprLines.push('  for (var i = s.length - 1; i >= 0; i--){');
    exprLines.push('    out = s.charAt(i) + out; count++;');
    exprLines.push('    if (count % 3 === 0 && i !== 0) out = sep + out;');
    exprLines.push('  }');
    exprLines.push('  return out;');
    exprLines.push('}');
    exprLines.push('function groupIndian(s, sep){');
    exprLines.push('  if (s.length <= 3) return s;');
    exprLines.push('  var last3 = s.substring(s.length - 3);');
    exprLines.push('  var rest = s.substring(0, s.length - 3);');
    exprLines.push('  var out = ""; var count = 0;');
    exprLines.push('  for (var i = rest.length - 1; i >= 0; i--){');
    exprLines.push('    out = rest.charAt(i) + out; count++;');
    exprLines.push('    if (count % 2 === 0 && i !== 0) out = sep + out;');
    exprLines.push('  }');
    exprLines.push('  return out + sep + last3;');
    exprLines.push('}');
    exprLines.push('var progress = effect("Progress")("Slider") / 100;');
    exprLines.push('var fromVal = ' + fromVal + ';');
    exprLines.push('var toVal = ' + toVal + ';');
    exprLines.push('var decimals = ' + decimals + ';');
    exprLines.push('var val = fromVal + (toVal - fromVal) * progress;');
    exprLines.push('var neg = val < 0;');
    exprLines.push('var s = Math.abs(val).toFixed(decimals);');
    exprLines.push('var parts = s.split(".");');
    exprLines.push('var intPart = parts[0];');
    exprLines.push('var decPart = parts.length > 1 ? parts[1] : "";');
    exprLines.push('var groupedInt = ' + (doGroup ? ('(' + (indian ? 'groupIndian' : 'groupStd') + '(intPart, "' + groupChar + '"))') : 'intPart') + ';');
    exprLines.push('var numStr = groupedInt + (decPart ? "' + decChar + '" + decPart : "");');
    exprLines.push('if (neg) numStr = "-" + numStr;');
    exprLines.push('"' + escapeJsonForExpr(pre) + '" + numStr + "' + escapeJsonForExpr(suf) + '";');
    textProp.expression = exprLines.join("\n");

    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_GROUPINDIAN_001", e2); }
    return toolResult(false, String(e));
  }
}

// Links the Y position of the selected layer(s) to the nearest "Number
// Counter" layer's Progress slider (0-100), offsetting by up to pxPerUnit
// pixels as the counter completes its run. Create a Number Counter first.
function ae_applyCounterPosition(pxPerUnit) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var counterLayer = null;
    for (var i = 1; i <= comp.numLayers; i++) {
      var L = comp.layer(i);
      if (L.name === "Number Counter") {
        try {
          if (L.property("Effects").property("Progress")) { counterLayer = L; break; }
        } catch (e2) { compxAuditFallback("HOST_AE_APPLYCOUNTERPOSITION_001", e2); }
      }
    }
    if (!counterLayer) return toolResult(false, "No Number Counter layer found in this comp — create one first.");

    pxPerUnit = Number(pxPerUnit) || 0;
    var expr = [
      'var counterLayer = thisComp.layer("' + counterLayer.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '");',
      'var progress = counterLayer.effect("Progress")("Slider") / 100;',
      'var offset = progress * ' + pxPerUnit + ';',
      'value + [0, offset];'
    ].join('\n');

    app.beginUndoGroup("Apply Position to Counter");
    var applied = 0;
    for (var j = 0; j < layers.length; j++) {
      try { layers[j].property("Position").expression = expr; applied++; } catch (inner) { compxAuditFallback("HOST_AE_APPLYCOUNTERPOSITION_002", inner); }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "" : "Could not set a Position expression on the selection.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_APPLYCOUNTERPOSITION_003", e2); }
    return toolResult(false, String(e));
  }
}

// Escape a string for safe embedding inside a double-quoted ExtendScript
// expression string literal (used only for prefix/suffix text).
function escapeJsonForExpr(str) {
  return String(str == null ? "" : str)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

// ---------- UTILITIES ----------

// Scales/positions a layer to exactly fill the comp frame.
function ae_fitToComp() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Fit to Comp");
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var rect = layer.sourceRectAtTime ? layer.sourceRectAtTime(comp.time, false) : null;
      if (!rect || rect.width === 0 || rect.height === 0) continue;
      var scaleX = (comp.width  / rect.width)  * 100;
      var scaleY = (comp.height / rect.height) * 100;
      var scaleProp = layer.property("Scale");
      if (scaleProp.numKeys === 0) scaleProp.setValue([scaleX, scaleY, 100]);
      var posProp = layer.property("Position");
      if (posProp.numKeys === 0) posProp.setValue([comp.width / 2, comp.height / 2, 0]);
      var anchorProp = layer.property("Anchor Point");
      if (anchorProp.numKeys === 0) anchorProp.setValue([rect.left + rect.width / 2, rect.top + rect.height / 2, 0]);
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_FITTOCOMP_001", e2); }
    return toolResult(false, String(e));
  }
}

// True duplicate of the selected layer(s). For a precomp layer, AE's
// normal duplicate() still points at the SAME source comp — editing one
// changes both. This also duplicates the underlying source comp and
// re-points the new layer at that copy, so the two are fully independent.
function ae_trueDuplicate() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("True Duplicate");
    var done = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var dup = layer.duplicate();
      dup.name = layer.name + " Copy";
      try {
        if (layer.source && (layer.source instanceof CompItem)) {
          var srcCopy = layer.source.duplicate();
          srcCopy.name = layer.source.name + " Copy";
          dup.replaceSource(srcCopy, false);
        }
      } catch (se) { compxAuditFallback("HOST_AE_TRUEDUPLICATE_001", se); }
      done++;
    }
    app.endUndoGroup();
    return toolResult(done > 0, done > 0 ? done + " independent duplicate(s) created." : "");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_TRUEDUPLICATE_002", e2); }
    return toolResult(false, String(e));
  }
}

// Sequences selected layers one after another in time order (by current
// stacking order), each starting where the previous one ends, with an
// optional overlap in seconds.
function ae_sequenceLayers(overlapSec) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length < 2) return toolResult(false, "Select at least 2 layers.");

    overlapSec = Number(overlapSec) || 0;
    layers.sort(function (a, b) { return a.index - b.index; });

    app.beginUndoGroup("Sequence Layers");
    var cursor = layers[0].startTime;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var dur = layer.outPoint - layer.inPoint;
      layer.startTime = cursor - layer.inPoint;
      cursor += dur - overlapSec;
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_SEQUENCELAYERS_001", e2); }
    return toolResult(false, String(e));
  }
}

// Freezes the frame at the current playhead time for the selected layer(s)
// by enabling Time Remap and pinning a key at the current time.
function ae_freezeFrame() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Freeze Frame");
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      try {
        if (!layer.timeRemapEnabled) layer.timeRemapEnabled = true;
        var tr = layer.property("Time Remap");
        var t = comp.time - layer.startTime;
        tr.setValueAtTime(comp.time, t);
        applied++;
      } catch (inner) { compxAuditFallback("HOST_AE_FREEZEFRAME_001", inner); }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "Froze " + applied + " layer(s) at the playhead." : "Time Remap isn't available on the selected layer(s) — it needs video footage with more than one frame.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_FREEZEFRAME_002", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// LAYER CREATION & EFFECTS — extra tools
// ================================================================

// Generic helper: apply a built-in effect (by match name) to all selected
// layers, using sensible defaults set by AE itself.
function ae_applyEffect(matchName, effectLabel) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Apply " + effectLabel);
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      try { layers[i].property("Effects").addProperty(matchName); applied++; } catch (inner) { compxAuditFallback("HOST_AE_APPLYEFFECT_001", inner); }
    }
    app.endUndoGroup();
    return toolResult(applied > 0,
      applied > 0 ? effectLabel + " applied to " + applied + " layer(s)." : effectLabel + " couldn't be applied to the selected layer(s) (wrong layer type, or the effect needs a paid plugin that isn't installed).");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_APPLYEFFECT_002", e2); }
    return toolResult(false, String(e));
  }
}

// BOUNCE — adds a spring/overshoot expression to Scale (or Position if the
// layer has no meaningful scale animation) so the layer settles with a
// bouncy ease after its last keyframe. Classic amplitude/decay/frequency
// spring expression, applied to whichever property already has keyframes.
function ae_addBounce(dataStr) {
  try {
    var opts = { amp: 0.06, freq: 3.0, decay: 6.0, target: "auto" };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.amp !== undefined) opts.amp = Number(parsed.amp);
        if (parsed.freq !== undefined) opts.freq = Number(parsed.freq);
        if (parsed.decay !== undefined) opts.decay = Number(parsed.decay);
        if (parsed.target) opts.target = String(parsed.target).toLowerCase();
      } catch (pe) { compxAuditFallback("HOST_AE_ADDBOUNCE_001", pe); }
    }

    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var ampStr = String(opts.amp);
    var freqStr = String(opts.freq);
    var decayStr = String(opts.decay);

    var bounceExpr = [
      'n = 0;',
      'if (numKeys > 0){',
      '  n = nearestKey(time).index;',
      '  if (key(n).time > time) n--;',
      '}',
      'if (n == 0){',
      '  t = 0;',
      '} else {',
      '  t = time - key(n).time;',
      '}',
      'if (n > 0 && t < 2){',
      '  v = velocityAtTime(key(n).time - thisComp.frameDuration/10);',
      '  amp = ' + ampStr + ';',
      '  freq = ' + freqStr + ';',
      '  decay = ' + decayStr + ';',
      '  value + v*amp*Math.sin(freq*t*2*Math.PI)/Math.exp(decay*t);',
      '} else {',
      '  value;',
      '}'
    ].join('\n');

    var targetProps = [];
    if (opts.target === "auto") {
      targetProps = ["Scale", "Position"];
    } else if (opts.target === "scale") {
      targetProps = ["Scale"];
    } else if (opts.target === "position") {
      targetProps = ["Position"];
    } else if (opts.target === "rotation") {
      targetProps = ["Rotation", "Rotate Z", "ADBE Rotate Z"];
    } else if (opts.target === "opacity") {
      targetProps = ["Opacity"];
    } else {
      targetProps = [opts.target];
    }

    app.beginUndoGroup("Add Bounce");
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var prop = null;
      for (var p = 0; p < targetProps.length; p++) {
        try { prop = layer.property(targetProps[p]); if (prop && prop.numKeys > 0) break; } catch (pe) { compxAuditFallback("HOST_AE_ADDBOUNCE_002", pe); }
      }
      if (prop && prop.numKeys > 0) {
        try { prop.expression = bounceExpr; applied++; } catch (inner) { compxAuditFallback("HOST_AE_ADDBOUNCE_003", inner); }
      }
    }
    app.endUndoGroup();
    return toolResult(applied > 0,
      applied > 0 ? "Bounce added to " + applied + " layer(s)." : "Select layer(s) with an animated property first.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_ADDBOUNCE_004", e2); }
    return toolResult(false, String(e));
  }
}

// BOUNCE (advanced) — multi-property spring/bounce with auto-keyframe,
// direction (in/out/both) and per-layer delay stagger for multi-select.
function ae_addBounceAdvanced(dataStr) {
  try {
    var opts = {
      amount: 20, bounces: 4, decay: 65, gravity: 50, elasticity: 70,
      overshoot: true, autoEase: true,
      properties: ["scale"], direction: "in", delayFrames: 0,
      textMode: false, textStaggerFrames: 2
    };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.amount !== undefined) opts.amount = Number(parsed.amount);
        if (parsed.bounces !== undefined) opts.bounces = Number(parsed.bounces);
        if (parsed.decay !== undefined) opts.decay = Number(parsed.decay);
        if (parsed.gravity !== undefined) opts.gravity = Number(parsed.gravity);
        if (parsed.elasticity !== undefined) opts.elasticity = Number(parsed.elasticity);
        if (parsed.overshoot !== undefined) opts.overshoot = !!parsed.overshoot;
        if (parsed.autoEase !== undefined) opts.autoEase = !!parsed.autoEase;
        if (parsed.properties && parsed.properties.length) opts.properties = parsed.properties;
        if (parsed.direction) opts.direction = String(parsed.direction).toLowerCase();
        if (parsed.delayFrames !== undefined) opts.delayFrames = Number(parsed.delayFrames) || 0;
        if (parsed.textMode !== undefined) opts.textMode = !!parsed.textMode;
        if (parsed.textStaggerFrames !== undefined) opts.textStaggerFrames = Number(parsed.textStaggerFrames) || 0;
      } catch (pe) { compxAuditFallback("HOST_AE_ADDBOUNCEADVANCED_001", pe); }
    }

    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    // This applies a real, visible "Expression" on the property (same as
    // classic overshoot-bounce tools) instead of baking keyframes. The
    // bounce amount is a fixed literal offset (not scaled by prior
    // velocity), so it always produces a visible result as long as the
    // property has at least one keyframe — we auto-add one if it has none.
    var amountFrac = Math.max(0.01, Math.min(2, opts.amount / 100));
    var baseFreq = Math.max(1, Math.min(8, Math.round(opts.bounces)));
    var baseDecayVal = 2 + (Math.max(0, Math.min(100, opts.decay)) / 100) * 10;
    // Gravity: higher gravity = faster, tighter oscillation (compresses the
    // bounce in time). Elasticity: higher elasticity = amplitude held longer
    // (slower decay) and slightly stronger swings; low elasticity settles fast.
    var gravityFrac = Math.max(0, Math.min(100, opts.gravity)) / 100;
    var elasticityFrac = Math.max(0, Math.min(100, opts.elasticity)) / 100;
    // "Bounces" used to map directly to cycles per second. For a preset
    // such as Hard (5), that made 5–6 rapid oscillations per second and read
    // as a shake. Map it to a controlled 1.2–2.2 Hz bounce instead.
    var freq = Math.max(1.2, Math.min(2.2, baseFreq * 0.35 * (0.8 + gravityFrac * 0.25)));
    var decayVal = baseDecayVal * (0.5 + gravityFrac) * (1.3 - elasticityFrac);
    decayVal = Math.max(0.5, decayVal);
    var elasticAmountFrac = amountFrac * (0.6 + elasticityFrac * 0.6);
    var oscExpr = opts.overshoot
      ? "Math.sin(freq*t*2*Math.PI)"
      : "Math.max(0, Math.sin(freq*t*2*Math.PI))";
    var frameDur = comp.frameDuration || (1 / (comp.frameRate || 30));
    var outBuffer = 1.2; // seconds of lead-in before outPoint so the bounce is visible before the layer ends

    function propNamesFor(key) {
      if (key === "scale") return ["Scale"];
      if (key === "position") return ["Position"];
      if (key === "rotation") return ["Rotation", "Rotate Z", "ADBE Rotate Z"];
      if (key === "opacity") return ["Opacity"];
      return [];
    }

    function ampFor(key) {
      // Elasticity scales the amplitude too (more elasticity = energy held
      // longer AND slightly bigger swings), not just the decay rate.
      // Scale must never swing from 0% to 200% just because Amount is 50.
      // Keep the maximum visual overshoot at 35%, which reads as a pop.
      if (key === "scale") return Math.max(0.01, Math.min(0.35, elasticAmountFrac * 0.5));
      if (key === "position") return elasticAmountFrac * (comp.height || 1080) * 0.08;
      if (key === "rotation") return elasticAmountFrac * 45;
      if (key === "opacity") return elasticAmountFrac * 40;
      return elasticAmountFrac;
    }

    // Classic overshoot-style expression, shown in the Timeline as
    // "Expression: <Property>" — matches how other bounce tools work.
    // It triggers a decaying sine wiggle after every keyframe on the
    // property (n > 0), using a fixed amplitude rather than velocity,
    // so it never silently does nothing.
    function buildExpr(key) {
      var amt = ampFor(key);
      // Position must follow the incoming motion velocity. A fixed Y offset
      // looks like a shake, especially when the source animation already has
      // multiple keys. 20% amount maps to the classic amp=0.05 value.
      // Keep Position deliberately slow enough to read as a rebound instead
      // of rapid vibration, even if an Elastic preset has many bounces.
      var velocityAmp = Math.max(0.015, Math.min(0.08, amountFrac * 0.25));
      var positionFreq = Math.max(1.2, Math.min(3.0, baseFreq * 0.5));
      var positionDecay = Math.max(3.0, Math.min(9.0, decayVal));
      var lines = [
        "n = 0;",
        "if (numKeys > 0){",
        "  n = nearestKey(time).index;",
        "  if (key(n).time > time) n--;",
        "}",
        "if (n == 0){",
        "  t = 0;",
        "} else {",
        "  t = time - key(n).time;",
        "}",
        // A short settle window prevents lingering oscillation/vibration.
        "if (n > 0 && t < 1.15){",
        "  amt = " + amt + ";",
        "  freq = " + freq + ";",
        "  decay = " + decayVal + ";",
        "  osc = " + oscExpr + ";"
      ];
      if (key === "scale") {
        lines.push("  value * (1 + amt*osc/Math.exp(decay*t));");
      } else if (key === "position") {
        // The standard AE velocity bounce: it rebounds along the actual
        // travel vector after the landing key. No fixed X/Y offset, wiggle,
        // or random value is used here.
        lines.push("  if (n > 1){");
        lines.push("    v = velocityAtTime(key(n).time - thisComp.frameDuration/10);");
        lines.push("    value + v*" + velocityAmp + "*Math.sin(" + positionFreq + "*t*2*Math.PI)/Math.exp(" + positionDecay + "*t);");
        lines.push("  } else {");
        lines.push("    value;");
        lines.push("  }");
      } else if (key === "rotation") {
        lines.push("  value + amt*osc/Math.exp(decay*t);");
      } else if (key === "opacity") {
        lines.push("  clamp(value + amt*osc/Math.exp(decay*t), 0, 100);");
      } else {
        lines.push("  value;");
      }
      lines.push("} else {", "  value;", "}");
      return lines.join("\n");
    }

    // Per-character text bounce: instead of a property expression, add a
    // Text Animator per property with an Expression Selector whose Amount
    // uses textIndex to stagger each character's spring-settle bounce.
    var textStaggerSec = (opts.textStaggerFrames || 0) * frameDur;

    function buildCharAmountExpr(startT) {
      return [
        "n = textIndex;",
        "staggerSec = " + textStaggerSec + ";",
        "delay = (n-1) * staggerSec;",
        "startT = " + startT + ";",
        "t = time - startT - delay;",
        "freq = " + freq + ";",
        "decay = " + decayVal + ";",
        "if (t < 0){",
        "  100;",
        "} else if (t < 2){",
        "  100 * Math.exp(-decay*t) * Math.cos(freq*t*2*Math.PI);",
        "} else {",
        "  0;",
        "}"
      ].join("\n");
    }

    // Characters start fully offset (Amount 100%) and spring-settle to their
    // natural place (Amount 0%) with a decaying overshoot in between.
    function addCharAnimator(layer, key, startT) {
      var textProp = layer.property("ADBE Text Properties");
      if (!textProp) return false;
      var animators = textProp.property("ADBE Text Animators");
      if (!animators) return false;
      var anim = animators.addProperty("ADBE Text Animator");
      if (!anim) return false;
      try { anim.name = "Bounce In (" + key + ")"; } catch (ne) { compxAuditFallback("HOST_ADDCHARANIMATOR_001", ne); }
      var selectors = null;
      try { selectors = anim.property("ADBE Text Selectors"); } catch (se1) { compxAuditFallback("HOST_ADDCHARANIMATOR_002", se1); }
      if (!selectors) { try { selectors = anim.property(1); } catch (se2) { compxAuditFallback("HOST_ADDCHARANIMATOR_003", se2); } }
      var propsGroup = null;
      try { propsGroup = anim.property("ADBE Text Animator Properties"); } catch (pg1) { compxAuditFallback("HOST_ADDCHARANIMATOR_004", pg1); }
      if (!propsGroup) { try { propsGroup = anim.property(2); } catch (pg2) { compxAuditFallback("HOST_ADDCHARANIMATOR_005", pg2); } }
      if (!selectors || !propsGroup) return false;

      var sel = null;
      try { sel = selectors.addProperty("ADBE Text Expressible Selector"); } catch (aes) { compxAuditFallback("HOST_ADDCHARANIMATOR_006", aes); }
      if (sel) {
        var amtProp = null;
        try { amtProp = sel.property("Amount"); } catch (a1) { compxAuditFallback("HOST_ADDCHARANIMATOR_007", a1); }
        if (!amtProp) { try { amtProp = sel.property(1); } catch (a2) { compxAuditFallback("HOST_ADDCHARANIMATOR_008", a2); } }
        if (amtProp) { try { amtProp.expression = buildCharAmountExpr(startT); } catch (a3) { compxAuditFallback("HOST_ADDCHARANIMATOR_009", a3); } }
      }

      var amt = ampFor(key);
      var added = null;
      try {
        if (key === "position") {
          added = propsGroup.addProperty("ADBE Text Position 3D");
          added.setValue([0, amt * 2.5, 0]);
        } else if (key === "scale") {
          added = propsGroup.addProperty("ADBE Text Scale 3D");
          added.setValue([0, 0, 100]);
        } else if (key === "opacity") {
          added = propsGroup.addProperty("ADBE Text Opacity");
          added.setValue(-100);
        } else if (key === "rotation") {
          added = propsGroup.addProperty("ADBE Text Rotation X");
          added.setValue(amt * 4);
        }
      } catch (addErr) { compxAuditFallback("HOST_ADDCHARANIMATOR_010", addErr); }
      return !!added;
    }

    app.beginUndoGroup("Add Bounce");
    var appliedLayers = 0;
    var expressionFailures = [];

    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var delaySec = i * (opts.delayFrames || 0) * frameDur;
      var anchors = [];
      if (opts.direction === "out") {
        anchors = [Math.max(layer.inPoint, layer.outPoint - outBuffer) + delaySec];
      } else if (opts.direction === "both") {
        anchors = [layer.inPoint + delaySec, Math.max(layer.inPoint, layer.outPoint - outBuffer) + delaySec];
      } else {
        anchors = [layer.inPoint + delaySec];
      }
      for (var ai2 = 0; ai2 < anchors.length; ai2++) {
        if (anchors[ai2] < 0) anchors[ai2] = 0;
        if (anchors[ai2] > comp.duration) anchors[ai2] = comp.duration;
      }

      var isTextLayer = false;
      try { isTextLayer = !!layer.property("ADBE Text Properties"); } catch (tle) { compxAuditFallback("HOST_ADDCHARANIMATOR_011", tle); }

      if (opts.textMode && isTextLayer) {
        var appliedChar = false;
        for (var pc = 0; pc < opts.properties.length; pc++) {
          var ckey = String(opts.properties[pc]).toLowerCase();
          try {
            if (addCharAnimator(layer, ckey, anchors[0])) appliedChar = true;
          } catch (charErr) { compxAuditFallback("HOST_ADDCHARANIMATOR_012", charErr); }
        }
        if (appliedChar) { appliedLayers++; continue; }
        // Fall through to the normal property-expression path if the
        // character-animator approach failed for every property.
      }

      var appliedOnLayer = false;
      for (var p2 = 0; p2 < opts.properties.length; p2++) {
        var key = String(opts.properties[p2]).toLowerCase();
        var names = propNamesFor(key);
        var prop = null;
        // Prefer stable AE match names under Transform; keep display-name
        // lookup as a fallback for compatibility with existing projects.
        try {
          var transformGroup = layer.property("ADBE Transform Group");
          if (transformGroup) {
            if (key === "position") prop = transformGroup.property("ADBE Position");
            else if (key === "scale") prop = transformGroup.property("ADBE Scale");
            else if (key === "rotation") prop = transformGroup.property("ADBE Rotate Z") || transformGroup.property("ADBE Rotation");
            else if (key === "opacity") prop = transformGroup.property("ADBE Opacity");
          }
        } catch (matchErr) { compxAuditFallback("HOST_ADDCHARANIMATOR_013", matchErr); }
        for (var ni = 0; ni < names.length; ni++) {
          if (prop) break;
          try { prop = layer.property(names[ni]); if (prop) break; } catch (pe2) { compxAuditFallback("HOST_ADDCHARANIMATOR_014", pe2); }
        }
        if (!prop) continue;

        // BOUNCr-compatible Position handling: when Separate Dimensions is
        // enabled, AE's Position leader cannot reliably hold an expression.
        // Apply the expression independently to X/Y/(Z) followers instead.
        var propTargets = [prop];
        if (key === "position") {
          var separated = false;
          try { separated = !!prop.dimensionsSeparated; } catch (sepCheck) { compxAuditFallback("HOST_ADDCHARANIMATOR_015", sepCheck); }
          if (separated) {
            propTargets = [];
            var followerCount = layer.threeDLayer ? 3 : 2;
            for (var sf = 0; sf < followerCount; sf++) {
              try {
                var follower = prop.getSeparationFollower(sf);
                if (follower) propTargets.push(follower);
              } catch (sepFollowerErr) { compxAuditFallback("HOST_ADDCHARANIMATOR_016", sepFollowerErr); }
            }
          }
        }

        for (var pt = 0; pt < propTargets.length; pt++) {
          var targetProp = propTargets[pt];
          var targetLabel = key;
          try { if (propTargets.length > 1) targetLabel += " " + targetProp.name; } catch (targetNameErr) { compxAuditFallback("HOST_ADDCHARANIMATOR_017", targetNameErr); }
          if (!targetProp) continue;

          try {
            if (!targetProp.canSetExpression) {
              expressionFailures.push(layer.name + " / " + targetLabel + " (cannot use expressions)");
              continue;
            }

            // Position bounce needs actual motion so velocityAtTime() has
            // something real to read. If Position has fewer than 2 keys,
            // auto-create a tiny settle move before each anchor. For separated
            // dimensions the Y follower receives the settle offset; all
            // followers still receive and retain their own expression.
            if (key === "position" && targetProp.numKeys < 2) {
              var basePos = targetProp.value;
              var posAmp = Math.max(18, ampFor("position") * 0.35);
              var leadDur = Math.max(frameDur * 4, 0.12);
              for (var pan = 0; pan < anchors.length; pan++) {
                var settleT = anchors[pan];
                var startT = settleT - leadDur;
                if (startT < layer.inPoint) {
                  startT = layer.inPoint;
                  settleT = Math.min(comp.duration, startT + leadDur);
                }
                if (settleT <= startT) {
                  settleT = Math.min(comp.duration, startT + Math.max(frameDur * 2, 0.08));
                }
                var fromPos;
                if (basePos instanceof Array) {
                  fromPos = basePos.length > 2
                    ? [basePos[0], basePos[1] + posAmp, basePos[2]]
                    : [basePos[0], basePos[1] + posAmp];
                } else {
                  // pt 1 is Y when dimensions are separated. With a normal
                  // scalar Position property (rare), apply the offset directly.
                  fromPos = basePos + ((propTargets.length === 1 || pt === 1) ? posAmp : 0);
                }
                try { targetProp.setValueAtTime(startT, fromPos); } catch (pk1) { compxAuditFallback("HOST_ADDCHARANIMATOR_018", pk1); }
                try { targetProp.setValueAtTime(settleT, basePos); } catch (pk2) { compxAuditFallback("HOST_ADDCHARANIMATOR_019", pk2); }
              }
            }

            // Non-position properties need an anchor key so the expression has
            // a nearest keyframe to trigger from.
            if (targetProp.numKeys === 0) {
              var baseVal = targetProp.value;
              for (var an = 0; an < anchors.length; an++) {
                targetProp.setValueAtTime(anchors[an], baseVal);
              }
              if (opts.autoEase) {
                try {
                  var dim = (baseVal instanceof Array) ? baseVal.length : 1;
                  var eArr = [];
                  for (var d = 0; d < dim; d++) eArr.push({ influence: 33.33, speed: 0 });
                  for (var an2 = 0; an2 < anchors.length; an2++) {
                    var kIdx = targetProp.nearestKeyIndex(anchors[an2]);
                    if (kIdx) targetProp.setTemporalEaseAtKey(kIdx, eArr, eArr);
                  }
                } catch (easeErr) { compxAuditFallback("HOST_ADDCHARANIMATOR_020", easeErr); }
              }
            }

            var expressionText = buildExpr(key);
            try { targetProp.expressionEnabled = false; } catch (disableOld) { compxAuditFallback("HOST_ADDCHARANIMATOR_021", disableOld); }
            try { targetProp.expression = ""; } catch (clearOld) { compxAuditFallback("HOST_ADDCHARANIMATOR_022", clearOld); }
            targetProp.expression = expressionText;
            try { targetProp.expressionEnabled = true; } catch (enableNew) { compxAuditFallback("HOST_ADDCHARANIMATOR_023", enableNew); }
            try { targetProp.selected = true; } catch (selectProp) { compxAuditFallback("HOST_ADDCHARANIMATOR_024", selectProp); }

            var stuck = false;
            try {
              stuck = targetProp.expressionEnabled &&
                String(targetProp.expression).indexOf("velocityAtTime") >= 0;
              if (key !== "position") stuck = targetProp.expressionEnabled &&
                String(targetProp.expression).length > 0;
            } catch (rv) { compxAuditFallback("HOST_ADDCHARANIMATOR_025", rv); }
            if (stuck) {
              appliedOnLayer = true;
            } else {
              expressionFailures.push(layer.name + " / " + targetLabel);
            }
          } catch (inner) {
            expressionFailures.push(layer.name + " / " + targetLabel + " (" + String(inner).slice(0, 60) + ")");
          }
        }
      }
      if (appliedOnLayer) appliedLayers++;
    }
    app.endUndoGroup();
    var resultMsg;
    if (appliedLayers > 0 && expressionFailures.length === 0) {
      resultMsg = "Bounce expression applied to " + appliedLayers + " layer(s).";
    } else if (appliedLayers > 0) {
      resultMsg = "Bounce applied to " + appliedLayers + " layer(s), but failed on: " + expressionFailures.join(", ");
    } else if (expressionFailures.length > 0) {
      resultMsg = "Bounce expression did NOT stick on: " + expressionFailures.join(", ");
    } else {
      resultMsg = "Select layer(s) and at least one property to bounce.";
    }
    return toolResult(appliedLayers > 0, resultMsg);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_ADDCHARANIMATOR_026", e2); }
    return toolResult(false, String(e));
  }
}

// Direct, deliberately minimal Position-only path. This avoids the generic
// multi-property handler for the most important Bounce use case and uses the
// canonical velocity expression verbatim. The marker line lets the panel
// prove that THIS exact expression was written to AE's Position property.
function ae_applyVerifiedPositionBounce(dataStr) {
  try {
    var opts = { amount: 20, bounces: 2, decay: 65 };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.amount !== undefined) opts.amount = Number(parsed.amount);
        if (parsed.bounces !== undefined) opts.bounces = Number(parsed.bounces);
        if (parsed.decay !== undefined) opts.decay = Number(parsed.decay);
      } catch (parseErr) { compxAuditFallback("HOST_AE_APPLYVERIFIEDPOSITIONBOUNCE_001", parseErr); }
    }
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "Select a layer first.");

    // Conservative values read as a landing rebound, not vibration.
    var amp = Math.max(0.015, Math.min(0.08, (opts.amount / 100) * 0.25));
    var freq = Math.max(1.2, Math.min(3.0, Number(opts.bounces) || 2));
    var decay = Math.max(3, Math.min(9, 2 + (Number(opts.decay) || 65) / 100 * 8));
    var expressionText = [
      "// SFX_POSITION_BOUNCE",
      "amp = " + amp + ";",
      "freq = " + freq + ";",
      "decay = " + decay + ";",
      "n = 0;",
      "if (numKeys > 0){",
      "  n = nearestKey(time).index;",
      "  if (key(n).time > time) n--;",
      "}",
      "if (n > 1){",
      "  t = time - key(n).time;",
      "  if (t < 1){",
      "    v = velocityAtTime(key(n).time - thisComp.frameDuration/10);",
      "    value + v*amp*Math.sin(freq*t*2*Math.PI)/Math.exp(decay*t);",
      "  } else { value; }",
      "} else { value; }"
    ].join("\n");

    app.beginUndoGroup("Verified Position Bounce");
    var passed = [];
    var failed = [];
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      try {
        // Exact Transform > Position path, independent of display language.
        var pos = layer.property("ADBE Transform Group").property("ADBE Position");
        if (!pos || !pos.canSetExpression) {
          failed.push(layer.name + " (Position cannot use expressions)");
          continue;
        }
        if (pos.numKeys < 2) {
          failed.push(layer.name + " (Position needs 2 keyframes)");
          continue;
        }
        try { pos.expressionEnabled = false; } catch (disableOld) { compxAuditFallback("HOST_AE_APPLYVERIFIEDPOSITIONBOUNCE_002", disableOld); }
        pos.expression = "";
        pos.expression = expressionText;
        pos.expressionEnabled = true;
        try { pos.selected = true; } catch (selectPos) { compxAuditFallback("HOST_AE_APPLYVERIFIEDPOSITIONBOUNCE_003", selectPos); }
        var stored = String(pos.expression);
        if (pos.expressionEnabled && stored.indexOf("SFX_POSITION_BOUNCE") >= 0 && stored.indexOf("velocityAtTime") >= 0) {
          passed.push(layer.name);
        } else {
          failed.push(layer.name + " (AE did not retain expression)");
        }
      } catch (err) {
        failed.push(layer.name + " (" + String(err) + ")");
      }
    }
    app.endUndoGroup();
    if (passed.length > 0 && failed.length === 0) return toolResult(true, "VERIFIED Position expression written: " + passed.join(", "));
    if (passed.length > 0) return toolResult(true, "VERIFIED on " + passed.join(", ") + "; failed: " + failed.join(", "));
    return toolResult(false, "Position expression failed: " + failed.join(", "));
  } catch (e) {
    try { app.endUndoGroup(); } catch (endErr) { compxAuditFallback("HOST_AE_APPLYVERIFIEDPOSITIONBOUNCE_004", endErr); }
    return toolResult(false, "Position expression error: " + String(e));
  }
}

// SHAPE — creates a simple rectangle shape layer centered in the comp.
function ae_createShapeLayer() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    app.beginUndoGroup("Create Shape Layer");
    var playhead = comp.time;
    var shapeLayer = comp.layers.addShape();
    shapeLayer.name = "Shape Layer";
    // Match Null/Camera insertion behavior: begin at the current playhead.
    try {
      shapeLayer.startTime = playhead;
      shapeLayer.inPoint = playhead;
      shapeLayer.outPoint = comp.duration;
    } catch (timingErr) { compxAuditFallback("HOST_AE_CREATESHAPELAYER_001", timingErr); }
    var contents = shapeLayer.property("ADBE Root Vectors Group");
    var group = contents.addProperty("ADBE Vector Group");
    var groupContents = group.property("ADBE Vectors Group");

    var rect = groupContents.addProperty("ADBE Vector Shape - Rect");
    rect.property("ADBE Vector Rect Size").setValue([200, 200]);

    var fill = groupContents.addProperty("ADBE Vector Graphic - Fill");
    fill.property("ADBE Vector Fill Color").setValue([1, 1, 1]);

    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_CREATESHAPELAYER_002", e2); }
    return toolResult(false, String(e));
  }
}

// CAPITAL — uppercases the Source Text of selected text layers (static
// text; skips text driven by an expression to avoid clobbering it).
function ae_capitalizeText() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Capitalize Text");
    var changed = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!(layer instanceof TextLayer)) continue;
      var textProp = layer.property("Source Text");
      if (textProp.expressionEnabled) continue;
      var doc = textProp.value;
      doc.text = String(doc.text).toUpperCase();
      textProp.setValue(doc);
      changed++;
    }
    app.endUndoGroup();
    return toolResult(true, changed ? "" : "No editable text layers selected.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_CAPITALIZETEXT_001", e2); }
    return toolResult(false, String(e));
  }
}

// TRIM DOWN — trims the OUT point of each selected layer to the current
// playhead time (like pressing "Trim Layer Out Point" at the current time).
function ae_trimOut() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Trim Out Point");
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (comp.time > layer.inPoint) layer.outPoint = comp.time;
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_TRIMOUT_001", e2); }
    return toolResult(false, String(e));
  }
}

// FX LOCK — After Effects has no scripting API to lock only a layer's
// effects (Layer.locked is the finest-grained lock AE exposes). The
// previous version tried to fake it with an expression anchored to the
// first "point-shaped" effect property it could find, which silently did
// nothing on effects with no such property (Glow, Blur, Curves, etc. — most
// of them). Locking the whole layer is the reliable, always-working AE-
// native equivalent: a locked layer's effects (and everything else) can't
// be touched in the UI until it's unlocked again.
function ae_fxLock() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    function makeLiteral(v) {
      if (typeof v === "number") return String(v);
      if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) {
          if (typeof v[i] !== "number") return null;
          a.push(String(v[i]));
        }
        return "[" + a.join(",") + "]";
      }
      return null;
    }
    // Detect 2-D spatial point controls (CC Light Sweep, Gradient Ramp, etc.)
    function isSpatialPoint(p) {
      try {
        if (typeof PropertyValueType !== "undefined") {
          var pvt = p.propertyValueType;
          if (pvt === PropertyValueType.TwoD_SPATIAL ||
              pvt === PropertyValueType.ThreeD_SPATIAL) return true;
        }
        var v = p.value;
        if (v instanceof Array && v.length === 2 &&
            typeof v[0] === "number" && typeof v[1] === "number") {
          var nm = String(p.name || "").toLowerCase();
          if (/center|point|position|start|end|origin|anchor|ramp|source|target|light/.test(nm)) return true;
        }
      } catch (e) { compxAuditFallback("HOST_ISSPATIALPOINT_001", e); }
      return false;
    }
    // Convert comp-space [cx,cy] to layer-space (handles position + anchor + scale).
    function compToLayer(layer, cx, cy) {
      try {
        var pos    = layer.transform.position.value;
        var anchor = layer.transform.anchorPoint.value;
        var scale  = layer.transform.scale.value;
        var sx = ((scale[0] || 100) / 100) || 1;
        var sy = ((scale[1] || 100) / 100) || 1;
        return [(cx - pos[0]) / sx + anchor[0], (cy - pos[1]) / sy + anchor[1]];
      } catch (e) { return null; }
    }
    function hasMarker(group) {
      if (!group) return false;
      var n = 0; try { n = group.numProperties; } catch (e) { compxAuditFallback("HOST_HASMARKER_001", e); }
      for (var i = 1; i <= n; i++) {
        var p = null; try { p = group.property(i); } catch (e2) { compxAuditFallback("HOST_HASMARKER_002", e2); }
        if (!p) continue;
        var childCount = 0; try { childCount = p.numProperties; } catch (e3) { compxAuditFallback("HOST_HASMARKER_003", e3); }
        if (childCount > 0 && hasMarker(p)) return true;
        try { if (p.canSetExpression && String(p.expression).indexOf("SFX_FX_LOCK") >= 0) return true; } catch (e4) { compxAuditFallback("HOST_HASMARKER_004", e4); }
      }
      return false;
    }
    var unlock = false;
    for (var s = 0; s < layers.length; s++) {
      try { if (hasMarker(layers[s].property("ADBE Effect Parade"))) { unlock = true; break; } } catch (scanErr) { compxAuditFallback("HOST_HASMARKER_005", scanErr); }
    }
    var changed = 0, skipped = 0;
    function freezeGroup(group, layer) {
      if (!group) return;
      var n = 0; try { n = group.numProperties; } catch (countErr) { compxAuditFallback("HOST_FREEZEGROUP_001", countErr); }
      for (var i = 1; i <= n; i++) {
        var p = null; try { p = group.property(i); } catch (propErr) { compxAuditFallback("HOST_FREEZEGROUP_002", propErr); }
        if (!p) continue;
        var childCount = 0; try { childCount = p.numProperties; } catch (childErr) { compxAuditFallback("HOST_FREEZEGROUP_003", childErr); }
        if (childCount > 0) { freezeGroup(p, layer); continue; }
        try {
          if (!p.canSetExpression) { skipped++; continue; }
          var oldExpr = String(p.expression || "");
          if (unlock) {
            if (oldExpr.indexOf("SFX_FX_LOCK") >= 0) {
              p.expression = "";
              p.expressionEnabled = false;
              changed++;
            }
          } else {
            if (oldExpr.length > 0) { skipped++; continue; }
            // 2-D spatial point → lock relative to layer so effect follows movement
            if (isSpatialPoint(p)) {
              var cv = p.value;
              var lp = compToLayer(layer, cv[0], cv[1]);
              if (lp !== null) {
                p.expression = "// SFX_FX_LOCK\nthisLayer.toComp([" + lp[0] + "," + lp[1] + "]);";
                p.expressionEnabled = true;
                if (p.expressionEnabled && String(p.expression).indexOf("SFX_FX_LOCK") >= 0) changed++;
                continue;
              }
            }
            var fixed = makeLiteral(p.value);
            if (fixed === null) { skipped++; continue; }
            p.expression = "// SFX_FX_LOCK\n" + fixed + ";";
            p.expressionEnabled = true;
            if (p.expressionEnabled && String(p.expression).indexOf("SFX_FX_LOCK") >= 0) changed++;
          }
        } catch (freezeErr) { skipped++; }
      }
    }
    app.beginUndoGroup(unlock ? "FX Unlock" : "FX Lock");
    for (var j = 0; j < layers.length; j++) {
      freezeGroup(layers[j].property("ADBE Effect Parade"), layers[j]);
    }
    app.endUndoGroup();
    if (unlock) return toolResult(changed > 0,
      changed > 0 ? "FX Unlock — removed lock from " + changed + " parameter(s). Effects are free again."
                  : "No CompX FX Lock parameters found on the selected layer(s).");
    return toolResult(changed > 0,
      changed > 0 ? "FX Lock ON — " + changed + " parameter(s) locked. Effects stay fixed as the layer moves."
                  : "No expression-capable effect parameters found. Make sure effects are applied to the selected layer.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_FREEZEGROUP_004", e2); }
    return toolResult(false, String(e));
  }
}

function ae_removeAllFx() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");
    app.beginUndoGroup("Remove All FX");
    var removed = 0, affected = 0;
    for (var i = 0; i < layers.length; i++) {
      var effects = layers[i].property("ADBE Effect Parade");
      var before = effects ? effects.numProperties : 0;
      while (effects && effects.numProperties > 0) { effects.property(1).remove(); removed++; }
      if (before > 0) affected++;
    }
    app.endUndoGroup();
    return toolResult(true, removed > 0 ? "Removed " + removed + " effect(s) from " + affected + " layer(s)." : "No effects found on the selected layer(s).");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_REMOVEALLFX_001", e2); }
    return toolResult(false, String(e));
  }
}

// FX LOCK TOOL — locks/unlocks effect properties using expressions.
// When a property has an expression set to "value", the user cannot
// edit it in the Effect Controls panel until the expression is removed.
//
// action: "lockSelected" | "lockAll" | "unlockSelected" | "unlockAll"
function ae_fxLockTool(action) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var act = String(action || "lockSelected").toLowerCase();
    var isLock = (act.indexOf("lock") === 0);
    var isSelected = (act.indexOf("selected") !== -1);

    app.beginUndoGroup(isLock ? "Lock FX" : "Unlock FX");
    var affected = 0;
    var totalProps = 0;

    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var fxGroup = layer.property("ADBE Effect Parade");
      if (!fxGroup || fxGroup.numProperties === 0) continue;

      // Determine which effects to process
      var effectIndices = [];
      if (isSelected) {
        // Get selected properties and find which effects they belong to
        var selProps = layer.selectedProperties;
        var matchedEffects = {};
        for (var sp = 0; sp < selProps.length; sp++) {
          var selProp = selProps[sp];
          // Walk up to find the parent effect
          var parent = selProp;
          while (parent && parent.propertyDepth > 1) {
            if (parent.propertyDepth === 2) {
              // This is an effect (depth 2 under Effects)
              for (var ei = 1; ei <= fxGroup.numProperties; ei++) {
                try {
                  if (fxGroup.property(ei) === parent) {
                    matchedEffects[ei] = true;
                    break;
                  }
                } catch (te) { compxAuditFallback("HOST_AE_FXLOCKTOOL_001", te); }
              }
              break;
            }
            try { parent = parent.parentProperty; } catch (pe) { break; }
          }
        }
        for (var me in matchedEffects) effectIndices.push(Number(me));
      } else {
        // All effects
        for (var ei2 = 1; ei2 <= fxGroup.numProperties; ei2++) {
          effectIndices.push(ei2);
        }
      }

      for (var e = 0; e < effectIndices.length; e++) {
        var ef = null;
        try { ef = fxGroup.property(effectIndices[e]); } catch (te2) { continue; }
        if (!ef) continue;
        affected++;

        // Iterate all animatable sub-properties
        for (var p = 1; p <= ef.numProperties; p++) {
          var prop = null;
          try { prop = ef.property(p); } catch (pe) { continue; }
          if (!prop) continue;
          // Skip non-animatable properties (group headers, etc.)
          if (prop.propertyValueType === PropertyValueType.NO_VALUE) continue;

          try {
            if (isLock) {
              // Lock: add expression returning current value
              // Skip if already has an expression
              if (prop.expressionEnabled) continue;
              // Read current value and set expression
              var val = prop.value;
              if (typeof val === "number") {
                prop.expression = "value";
              } else if (val instanceof Array) {
                prop.expression = "value";
              } else {
                prop.expression = "value";
              }
              prop.expressionEnabled = true;
              totalProps++;
            } else {
              // Unlock: remove expression
              if (prop.expressionEnabled) {
                prop.expressionEnabled = false;
                prop.expression = "";
                totalProps++;
              }
            }
          } catch (se) {
            // Some properties can't have expressions — skip silently
          }
        }
      }
    }

    app.endUndoGroup();
    var verb = isLock ? "Locked" : "Unlocked";
    var scope = isSelected ? "selected" : "all";
    return toolResult(affected > 0,
      affected > 0 ? verb + " " + totalProps + " propert(y/ies) across " + affected + " effect(s) (" + scope + ")." :
      isSelected ? "Select an effect in the Effect Controls panel first." : "No effects found on the selected layer(s).");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_FXLOCKTOOL_002", e2); }
    return toolResult(false, String(e));
  }
}

// ALIGN DOWN — snaps each selected layer's start time to butt up against
// the layer immediately below it in the stack (tightens gaps in a stack of
// clips ordered top-to-bottom), processed top-down.
function ae_alignDown() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length < 2) return toolResult(false, "Select at least 2 layers.");

    layers.sort(function (a, b) { return a.index - b.index; });

    app.beginUndoGroup("Align Down");
    for (var i = 0; i < layers.length - 1; i++) {
      var upper = layers[i];
      var lower = layers[i + 1];
      var dur = lower.outPoint - lower.inPoint;
      lower.startTime = upper.outPoint - lower.inPoint;
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_ALIGNDOWN_001", e2); }
    return toolResult(false, String(e));
  }
}

// REMOVE FX — strips all effects from the selected layers.
function ae_removeAllEffects() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Remove Effects");
    var removed = 0;
    for (var i = 0; i < layers.length; i++) {
      var fx = layers[i].property("Effects");
      if (!fx) continue;
      for (var j = fx.numProperties; j >= 1; j--) {
        try { fx.property(j).remove(); removed++; } catch (inner) { compxAuditFallback("HOST_AE_REMOVEALLEFFECTS_001", inner); }
      }
    }
    app.endUndoGroup();
    return toolResult(removed > 0, removed > 0 ? removed + " effect(s) removed." : "The selected layer(s) have no effects to remove.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_REMOVEALLEFFECTS_002", e2); }
    return toolResult(false, String(e));
  }
}

// REMOVE FX (advanced) — supports multiple modes:
// mode: all | selected | disabled | duplicates
// effectName is used when mode === "selected"
function ae_removeEffectsAdvanced(dataStr) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var opts;
    try { opts = JSON.parse(dataStr); } catch (e0) { opts = { mode: "all", effectName: "" }; }
    var mode = (opts && opts.mode) ? String(opts.mode).toLowerCase() : "all";
    var effectName = (opts && opts.effectName) ? String(opts.effectName).toLowerCase() : "";

    app.beginUndoGroup("Remove Effects Advanced");
    var removed = 0;
    for (var i = 0; i < layers.length; i++) {
      var fx = layers[i].property("Effects");
      if (!fx) continue;

      var seen = {};
      for (var j = fx.numProperties; j >= 1; j--) {
        var ef = fx.property(j);
        if (!ef) continue;
        var removeIt = false;

        if (mode === "all") {
          removeIt = true;
        } else if (mode === "selected") {
          var nm = String(ef.name || "").toLowerCase();
          var mn = String(ef.matchName || "").toLowerCase();
          removeIt = !!effectName && (nm === effectName || mn === effectName || nm.indexOf(effectName) !== -1);
        } else if (mode === "disabled") {
          try { removeIt = (ef.enabled === false); } catch (ee) { removeIt = false; }
        } else if (mode === "duplicates") {
          var key = String(ef.matchName || "") + "::" + String(ef.name || "");
          if (seen[key]) removeIt = true;
          else seen[key] = true;
        }

        if (removeIt) {
          try { ef.remove(); removed++; } catch (inner) { compxAuditFallback("HOST_AE_REMOVEEFFECTSADVANCED_001", inner); }
        }
      }
    }
    app.endUndoGroup();

    return toolResult(removed > 0, removed > 0 ? removed + " effect(s) removed." : "No matching effects found.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_REMOVEEFFECTSADVANCED_002", e2); }
    return toolResult(false, String(e));
  }
}

// SPLIT MASKS — for a layer with multiple masks, creates one duplicate
// per mask, each duplicate keeping only its own mask (the rest deleted).
function ae_splitMasks() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Split Masks");
    var didWork = false;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var masks = layer.property("ADBE Mask Parade");
      if (!masks || masks.numProperties < 2) continue;
      var maskCount = masks.numProperties;

      for (var m = 1; m <= maskCount; m++) {
        var dup = layer.duplicate();
        var dupMasks = dup.property("ADBE Mask Parade");
        // Remove every mask except the m-th (iterate backwards to keep indices valid).
        for (var k = dupMasks.numProperties; k >= 1; k--) {
          if (k !== m) { try { dupMasks.property(k).remove(); } catch (e1) { compxAuditFallback("HOST_AE_SPLITMASKS_001", e1); } }
        }
        dup.name = layer.name + " Mask " + m;
      }
      layer.enabled = false; // keep original as a hidden backup
      didWork = true;
    }
    app.endUndoGroup();
    return toolResult(true, didWork ? "" : "Selected layer(s) need 2+ masks.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_SPLITMASKS_002", e2); }
    return toolResult(false, String(e));
  }
}

// TRACK PATH — creates a null layer whose Position is linked via expression
// to the first vertex of the selected layer's first mask path, so the null
// follows that path point if the mask is animated (simple path-follow rig).
function ae_trackPath() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");
    var layer = layers[0];
    var masks = layer.property("ADBE Mask Parade");
    if (!masks || masks.numProperties < 1) {
      return toolResult(false, "Selected layer has no mask path to track.");
    }

    app.beginUndoGroup("Track Path");
    var nullLayer = comp.layers.addNull();
    nullLayer.name = "TRACK_" + layer.name;
    nullLayer.threeDLayer = false;

    var expr = [
      'var srcLayer = thisComp.layer("' + layer.name.replace(/"/g, '\\"') + '");',
      'var maskPath = srcLayer.mask(1).maskPath;',
      'var pathVal = maskPath.value;',
      'var pt = pathVal.vertices[0];',
      'srcLayer.toComp(pt);'
    ].join('\n');

    nullLayer.property("Position").expression = expr;

    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_TRACKPATH_001", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// PROPERTY CLIPBOARD
// ================================================================

// COPY — serializes the first selected animatable property (select it in
// the Timeline panel first) on the first selected layer, keyframes and all,
// as JSON so the panel-side JS can hold it in one of its 3 clipboard slots.
// COPY — copies whatever property row(s) are selected in the Timeline
// panel. If none are selected (the common case — most people just select
// the layer), falls back to the whole Transform group (Position/Scale/
// Rotation/Opacity/Anchor Point) so Copy/Paste works without requiring the
// finicky "click the property row, not just the layer" step.
// BOUNCE — applies the fixed velocity-based expression from the Property
// Clipboard button to every expression-capable property selected in the
// Timeline, across all selected layers.
function ae_applyClipboardBounce() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var bounceExpression = [
      "amp = .04;",
      "freq = 1.8;",
      "decay = 3;",
      "n = 0;",
      "time_max = 3;",
      "",
      "if (numKeys > 0) {",
      "  n = nearestKey(time).index;",
      "  if (key(n).time > time) {",
      "    n--;",
      "  }",
      "}",
      "",
      "if (n == 0) {",
      "  t = 0;",
      "} else {",
      "  t = time - key(n).time;",
      "}",
      "",
      "if (n > 0 && t < time_max) {",
      "  v = velocityAtTime(key(n).time - thisComp.frameDuration / 10);",
      "",
      "  // Ease Out Factor (starts at 1, gradually reduces to 0)",
      "  easeFactor = easeOut(t, 0, time_max, 1, 0);",
      "",
      "  value + v * amp * Math.sin(freq * t * 2 * Math.PI) / Math.exp(decay * t) * easeFactor;",
      "} else {",
      "  value;",
      "}"
    ].join("\n");

    app.beginUndoGroup("Apply Bounce Expression");
    var applied = 0;
    var failed = [];
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var selected = layer.selectedProperties;
      for (var j = 0; j < selected.length; j++) {
        var prop = selected[j];
        if (!(prop instanceof Property) || !prop.canSetExpression) continue;
        try {
          prop.expression = bounceExpression;
          prop.expressionEnabled = true;
          if (String(prop.expression).indexOf("easeFactor = easeOut") >= 0) applied++;
          else failed.push(layer.name + " / " + prop.name);
        } catch (inner) {
          failed.push(layer.name + " / " + prop.name);
        }
      }
    }
    app.endUndoGroup();

    if (applied === 0) {
      return toolResult(false, "Select one or more expression-capable properties in the Timeline.");
    }
    var message = "Bounce expression applied to " + applied + " propert" + (applied === 1 ? "y." : "ies.");
    if (failed.length > 0) message += " Failed: " + failed.join(", ");
    return toolResult(true, message);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_APPLYCLIPBOARDBOUNCE_001", e2); }
    return toolResult(false, String(e));
  }
}

function ae_copyProperty() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var srcLayer = layers[0];
    var propList = [];
    var selected = srcLayer.selectedProperties;
    for (var i = 0; i < selected.length; i++) {
      if (selected[i] instanceof Property) propList.push(selected[i]);
    }

    if (propList.length === 0) {
      var transformNames = ["Position", "Scale", "Rotation", "Opacity", "Anchor Point"];
      for (var n = 0; n < transformNames.length; n++) {
        try {
          var tp = srcLayer.property(transformNames[n]);
          if (tp) propList.push(tp);
        } catch (pe) { compxAuditFallback("HOST_AE_COPYPROPERTY_001", pe); }
      }
    }
    if (propList.length === 0) return toolResult(false, "Nothing to copy.");

    var dataList = [];
    for (var j = 0; j < propList.length; j++) {
      var prop = propList[j];
      var item = { matchName: prop.matchName, name: prop.name };
      if (prop.numKeys > 0) {
        item.keys = [];
        for (var k = 1; k <= prop.numKeys; k++) item.keys.push({ t: prop.keyTime(k), v: prop.keyValue(k) });
      } else {
        item.value = prop.value;
      }
      dataList.push(item);
    }

    var json;
    try { json = JSON.stringify(dataList); } catch (je) { return toolResult(false, "This property can't be copied."); }
    return '{"success":true,"message":"Copied ' + dataList.length + ' propert' + (dataList.length === 1 ? "y" : "ies") + '","data":' + json + '}';
  } catch (e) {
    return toolResult(false, String(e));
  }
}

// PASTE — applies a JSON payload produced by ae_copyProperty() (an array
// of {matchName, value|keys}) onto the matching property of every
// selected layer. Still accepts an older single-object payload for
// backward compatibility with clipboard data saved by a previous version.
function ae_pasteProperty(dataStr) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var dataList;
    try { dataList = JSON.parse(dataStr); } catch (je) { return toolResult(false, "Clipboard data unreadable."); }
    if (!dataList) return toolResult(false, "Nothing to paste.");
    if (!(dataList instanceof Array)) dataList = [dataList];

    app.beginUndoGroup("Paste Property");
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      for (var d = 0; d < dataList.length; d++) {
        var data = dataList[d];
        if (!data || !data.matchName) continue;
        var prop = null;
        try { prop = layers[i].property(data.matchName); } catch (e1) { compxAuditFallback("HOST_AE_PASTEPROPERTY_001", e1); }
        if (!prop) continue;
        try {
          if (data.keys && data.keys.length > 0) {
            var times = [], vals = [];
            for (var j = 0; j < data.keys.length; j++) {
              times.push(data.keys[j].t);
              vals.push(data.keys[j].v);
            }
            prop.setValuesAtTimes(times, vals);
          } else if (data.value !== undefined) {
            prop.setValue(data.value);
          }
          applied++;
        } catch (e2) { compxAuditFallback("HOST_AE_PASTEPROPERTY_002", e2); }
      }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? applied + " propert" + (applied === 1 ? "y" : "ies") + " pasted." : "No selected layer has a matching property.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_PASTEPROPERTY_003", e2); }
    return toolResult(false, String(e));
  }
}

// COPY EFFECTS — serializes every effect+property on the first selected
// layer into a JSON array. Each effect includes its matchName, enabled
// state, and an array of its animatable/scalar properties (value +
// keyframes). Returns {"success":true,"data":<array>}.
function ae_copyEffects() {
  try {
    var comp = getActiveComp();
    if (!comp) return dataResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return dataResult(false, "No layers selected.");
    var src = layers[0];
    var fxGroup = src.property("ADBE Effect Parade");
    if (!fxGroup || fxGroup.numProperties === 0) return dataResult(false, "No effects on the selected layer.");

    var out = [];
    for (var i = 1; i <= fxGroup.numProperties; i++) {
      var ef = fxGroup.property(i);
      if (!ef) continue;
      var entry = {
        matchName: ef.matchName,
        name: ef.name,
        enabled: true,
        props: []
      };
      try { entry.enabled = ef.enabled; } catch (ee) { compxAuditFallback("HOST_AE_COPYEFFECTS_001", ee); }
      if (ef.numProperties > 0) {
        for (var p = 1; p <= ef.numProperties; p++) {
          var prop = ef.property(p);
          if (!prop) continue;
          var pEntry = { matchName: prop.matchName, name: prop.name };
          if (prop.propertyValueType === PropertyValueType.NO_VALUE) continue;
          if (prop.numKeys > 0) {
            pEntry.keys = [];
            for (var k = 1; k <= prop.numKeys; k++) {
              pEntry.keys.push({ t: prop.keyTime(k), v: prop.keyValue(k) });
            }
          } else {
            try { pEntry.value = prop.value; } catch (ve) { compxAuditFallback("HOST_AE_COPYEFFECTS_002", ve); }
          }
          entry.props.push(pEntry);
        }
      }
      out.push(entry);
    }

    var json;
    try { json = JSON.stringify(out); } catch (je) { return dataResult(false, "Could not serialize effects."); }
    return dataResult(true, out.length + " effect(s) copied.", json);
  } catch (e) {
    return dataResult(false, String(e));
  }
}

// PASTE EFFECTS — takes a JSON array produced by ae_copyEffects() and
// applies it to every selected layer. For each saved effect it either
// finds an existing one by matchName or creates it via addProperty,
// then sets each sub-property's keyframes or static value.
function ae_pasteEffects(dataStr) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var data;
    try { data = JSON.parse(dataStr); } catch (je) { return toolResult(false, "Effects data unreadable."); }
    if (!data || !data.length) return toolResult(false, "No effects to paste.");

    app.beginUndoGroup("Paste Effects");
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var fxGroup = layer.property("ADBE Effect Parade");
      if (!fxGroup) continue;
      for (var e = 0; e < data.length; e++) {
        var saved = data[e];
        if (!saved || !saved.matchName) continue;
        var ef = null;
        for (var j = 1; j <= fxGroup.numProperties; j++) {
          try { if (fxGroup.property(j).matchName === saved.matchName) { ef = fxGroup.property(j); break; } } catch (te) { compxAuditFallback("HOST_AE_PASTEEFFECTS_001", te); }
        }
        if (!ef) {
          try { ef = fxGroup.addProperty(saved.matchName); } catch (ae) { continue; }
        }
        if (!ef) continue;
        try { ef.enabled = (saved.enabled !== false); } catch (en) { compxAuditFallback("HOST_AE_PASTEEFFECTS_002", en); }
        if (!saved.props || !saved.props.length) { applied++; continue; }
        for (var p = 0; p < saved.props.length; p++) {
          var pData = saved.props[p];
          if (!pData || !pData.matchName) continue;
          var prop = null;
          try {
            for (var sp = 1; sp <= ef.numProperties; sp++) {
              try { if (ef.property(sp).matchName === pData.matchName) { prop = ef.property(sp); break; } } catch (te2) { compxAuditFallback("HOST_AE_PASTEEFFECTS_003", te2); }
            }
          } catch (pe) { compxAuditFallback("HOST_AE_PASTEEFFECTS_004", pe); }
          if (!prop) continue;
          try {
            if (pData.keys && pData.keys.length > 0) {
              var times = [], vals = [];
              for (var k = 0; k < pData.keys.length; k++) {
                times.push(pData.keys[k].t);
                vals.push(pData.keys[k].v);
              }
              prop.setValuesAtTimes(times, vals);
            } else if (pData.value !== undefined) {
              prop.setValue(pData.value);
            }
          } catch (se) { compxAuditFallback("HOST_AE_PASTEEFFECTS_005", se); }
        }
        applied++;
      }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? applied + " effect(s) pasted." : "Could not paste effects.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_PASTEEFFECTS_006", e2); }
    return toolResult(false, String(e));
  }
}

// COPY EVERYTHING — serializes the first selected layer's transform
// properties, effects, masks, blending mode, solo/shy, in/out points,
// stretch, enabled state, label color, layer styles, and time remapping
// into one large JSON object so it can be pasted onto other layers.
// Converts an AE Shape object (mask/path value) into a plain serializable
// object, since Shape instances don't always round-trip cleanly through
// JSON.stringify on their own.
function ae_shapeToPlain(shape) {
  if (!shape) return null;
  var plain = { closed: !!shape.closed };
  try { plain.vertices = shape.vertices; } catch (ve) { compxAuditFallback("HOST_AE_SHAPETOPLAIN_001", ve); }
  try { plain.inTangents = shape.inTangents; } catch (ie) { compxAuditFallback("HOST_AE_SHAPETOPLAIN_002", ie); }
  try { plain.outTangents = shape.outTangents; } catch (oe) { compxAuditFallback("HOST_AE_SHAPETOPLAIN_003", oe); }
  try { if (shape.featureType !== undefined) plain.featureType = shape.featureType; } catch (fe) { compxAuditFallback("HOST_AE_SHAPETOPLAIN_004", fe); }
  return plain;
}

// Rebuilds an AE Shape object from the plain serializable form saved by
// ae_shapeToPlain(), so it can be written back with Property.setValue().
function ae_plainToShape(plain) {
  var shape = new Shape();
  if (!plain) return shape;
  try { shape.vertices = plain.vertices || []; } catch (ve) { compxAuditFallback("HOST_AE_PLAINTOSHAPE_001", ve); }
  try { shape.inTangents = plain.inTangents || []; } catch (ie) { compxAuditFallback("HOST_AE_PLAINTOSHAPE_002", ie); }
  try { shape.outTangents = plain.outTangents || []; } catch (oe) { compxAuditFallback("HOST_AE_PLAINTOSHAPE_003", oe); }
  try { shape.closed = !!plain.closed; } catch (ce) { compxAuditFallback("HOST_AE_PLAINTOSHAPE_004", ce); }
  return shape;
}

// Recursively serializes a shape-layer "Contents" tree (groups, fills,
// strokes, trim paths, gradients, repeaters, path shapes, etc.) into a
// plain nested array so it can be restored later with ae_applyGroup().
function ae_serializeGroup(group, depth) {
  var out = [];
  if (!group || depth > 12) return out;
  var n = 0;
  try { n = group.numProperties; } catch (ne) { return out; }
  for (var i = 1; i <= n; i++) {
    try {
      var item = group.property(i);
      if (!item) continue;
      var node = { matchName: item.matchName, name: item.name };
      if (item instanceof PropertyGroup) {
        node.isGroup = true;
        try { node.enabled = item.enabled; } catch (ee) { compxAuditFallback("HOST_AE_SERIALIZEGROUP_001", ee); }
        node.children = ae_serializeGroup(item, depth + 1);
      } else if (item instanceof Property) {
        if (item.propertyValueType === PropertyValueType.NO_VALUE) continue;
        node.isGroup = false;
        if (item.numKeys > 0) {
          node.keys = [];
          for (var k = 1; k <= item.numKeys; k++) node.keys.push({ t: item.keyTime(k), v: item.keyValue(k) });
        } else {
          node.value = item.value;
        }
      } else {
        continue;
      }
      out.push(node);
    } catch (pe) { compxAuditFallback("HOST_AE_SERIALIZEGROUP_002", pe); }
  }
  return out;
}

// Restores a tree captured by ae_serializeGroup() onto a destination
// PropertyGroup, matching existing children by matchName and creating
// missing ones (fills, strokes, trim paths, groups, ...) as needed.
function ae_applyGroup(group, nodes) {
  if (!group || !nodes) return;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (!node || !node.matchName) continue;
    try {
      var target = null;
      var n = 0;
      try { n = group.numProperties; } catch (ce) { compxAuditFallback("HOST_AE_APPLYGROUP_001", ce); }
      for (var j = 1; j <= n; j++) {
        try { if (group.property(j).matchName === node.matchName) { target = group.property(j); break; } } catch (te) { compxAuditFallback("HOST_AE_APPLYGROUP_002", te); }
      }
      if (!target) {
        try { target = group.addProperty(node.matchName); } catch (ade) { target = null; }
      }
      if (!target) continue;
      if (node.isGroup) {
        try { if (node.enabled !== undefined) target.enabled = node.enabled; } catch (ee) { compxAuditFallback("HOST_AE_APPLYGROUP_003", ee); }
        if (node.children) ae_applyGroup(target, node.children);
      } else {
        if (node.keys && node.keys.length > 0) {
          var times = [], vals = [];
          for (var k = 0; k < node.keys.length; k++) { times.push(node.keys[k].t); vals.push(node.keys[k].v); }
          try { target.setValuesAtTimes(times, vals); } catch (se) { compxAuditFallback("HOST_AE_APPLYGROUP_004", se); }
        } else if (node.value !== undefined) {
          try { target.setValue(node.value); } catch (se2) { compxAuditFallback("HOST_AE_APPLYGROUP_005", se2); }
        }
      }
    } catch (ne2) { compxAuditFallback("HOST_AE_APPLYGROUP_006", ne2); }
  }
}

// Resets every in-memory FX clipboard slot.
function ae_clearAllClipboardSlots() {
  compxClipboardSlots = { 1: null, 2: null, 3: null };
  return toolResult(true, "Clipboard cleared.");
}

function ae_copyEverything(slotArg) {
  try {
    var slot = parseInt(slotArg, 10);
    if (!slot || slot < 1) slot = 1;
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");
    var src = layers[0];

    var out = { transform: {}, effects: [], masks: [], layerStyle: {} };

    out.enabled = src.enabled;
    out.shy = src.shy;
    out.solo = src.solo;
    out.blendingMode = src.blendingMode;
    out.label = src.label;
    out.inPoint = src.inPoint;
    out.outPoint = src.outPoint;
    out.stretch = src.stretch;
    out.threeDLayer = src.threeDLayer;
    out.adjustmentLayer = src.adjustmentLayer;
    try { out.guideLayer = src.guideLayer; } catch (ge) { compxAuditFallback("HOST_AE_COPYEVERYTHING_001", ge); }
    try { out.nullLayer = src.nullLayer; } catch (ne) { compxAuditFallback("HOST_AE_COPYEVERYTHING_002", ne); }

    // Transform
    var tgNames = [
      { n: "ADBE Transform Group", alias: "transform" },
      { n: "ADBE Position", alias: "position" },
      { n: "ADBE Scale", alias: "scale" },
      { n: "ADBE Rotate Z", alias: "rotation" },
      { n: "ADBE Opacity", alias: "opacity" },
      { n: "ADBE Anchor Point", alias: "anchorPoint" }
    ];
    for (var t = 0; t < tgNames.length; t++) {
      try {
        var pp = src.property(tgNames[t].n);
        if (pp) {
          var item = {};
          if (pp.numKeys > 0) {
            item.keys = [];
            for (var k = 1; k <= pp.numKeys; k++) item.keys.push({ t: pp.keyTime(k), v: pp.keyValue(k) });
          } else {
            item.value = pp.value;
          }
          out.transform[tgNames[t].alias] = item;
        }
      } catch (pe) { compxAuditFallback("HOST_AE_COPYEVERYTHING_003", pe); }
    }

    // Effects
    var fxGroup = src.property("ADBE Effect Parade");
    if (fxGroup && fxGroup.numProperties > 0) {
      for (var i = 1; i <= fxGroup.numProperties; i++) {
        try {
          var ef = fxGroup.property(i);
          if (!ef) continue;
          var entry = { matchName: ef.matchName, name: ef.name, enabled: true, props: [] };
          try { entry.enabled = ef.enabled; } catch (ee) { compxAuditFallback("HOST_AE_COPYEVERYTHING_004", ee); }
          for (var p = 1; p <= ef.numProperties; p++) {
            try {
              var prop = ef.property(p);
              // Skip nested property groups (some effects have grouped sub-
              // params) — only leaf Property objects have propertyValueType.
              if (!prop || !(prop instanceof Property)) continue;
              if (prop.propertyValueType === PropertyValueType.NO_VALUE) continue;
              var pEntry = { matchName: prop.matchName, name: prop.name };
              if (prop.numKeys > 0) {
                pEntry.keys = [];
                for (var k = 1; k <= prop.numKeys; k++) pEntry.keys.push({ t: prop.keyTime(k), v: prop.keyValue(k) });
              } else {
                pEntry.value = prop.value;
              }
              entry.props.push(pEntry);
            } catch (pve) { compxAuditFallback("HOST_AE_COPYEVERYTHING_005", pve); }
          }
          out.effects.push(entry);
        } catch (efe) { compxAuditFallback("HOST_AE_COPYEVERYTHING_006", efe); }
      }
    }

    // Masks
    var maskParade = src.property("ADBE Mask Parade");
    if (maskParade && maskParade.numProperties > 0) {
      for (var m = 1; m <= maskParade.numProperties; m++) {
        try {
          var mask = maskParade.property(m);
          if (!mask) continue;
          var maskEntry = { name: mask.name, inverted: mask.inverted, maskMode: mask.maskMode };
          var maskShape = mask.property("ADBE Mask Shape");
          if (maskShape) {
            try { maskEntry.shape = ae_shapeToPlain(maskShape.value); } catch (se) { compxAuditFallback("HOST_AE_COPYEVERYTHING_007", se); }
            if (maskShape.numKeys > 0) {
              maskEntry.shapeKeys = [];
              for (var sk = 1; sk <= maskShape.numKeys; sk++) maskEntry.shapeKeys.push({ t: maskShape.keyTime(sk), v: ae_shapeToPlain(maskShape.keyValue(sk)) });
            }
          }
          var maskFeather = mask.property("ADBE Mask Feather");
          if (maskFeather) maskEntry.feather = maskFeather.value;
          var maskOpacity = mask.property("ADBE Mask Opacity");
          if (maskOpacity) maskEntry.opacity = maskOpacity.value;
          var maskExp = mask.property("ADBE Mask Expansion");
          if (maskExp) maskEntry.expansion = maskExp.value;
          out.masks.push(maskEntry);
        } catch (me) { compxAuditFallback("HOST_AE_COPYEVERYTHING_008", me); }
      }
    }

    // Layer Style
    try {
      var ls = src.property("ADBE Layer Styles");
      if (ls && ls.numProperties > 0) {
        for (var lsIdx = 1; lsIdx <= ls.numProperties; lsIdx++) {
          try {
            var lsItem = ls.property(lsIdx);
            if (!lsItem) continue;
            var lsEntry = { matchName: lsItem.matchName, name: lsItem.name, props: [] };
            for (var lsp = 1; lsp <= lsItem.numProperties; lsp++) {
              var lspProp = lsItem.property(lsp);
              if (!lspProp) continue;
              try {
                if (lspProp.numKeys > 0) {
                  var lKeys = [];
                  for (var lk = 1; lk <= lspProp.numKeys; lk++) lKeys.push({ t: lspProp.keyTime(lk), v: lspProp.keyValue(lk) });
                  lsEntry.props.push({ matchName: lspProp.matchName, name: lspProp.name, keys: lKeys });
                } else {
                  lsEntry.props.push({ matchName: lspProp.matchName, name: lspProp.name, value: lspProp.value });
                }
              } catch (lve) { compxAuditFallback("HOST_AE_COPYEVERYTHING_009", lve); }
            }
            out.layerStyle[lsItem.matchName] = lsEntry;
          } catch (lse) { compxAuditFallback("HOST_AE_COPYEVERYTHING_010", lse); }
        }
      }
    } catch (lse2) { compxAuditFallback("HOST_AE_COPYEVERYTHING_011", lse2); }

    // Shape layer contents (Fill / Stroke / Trim Paths / Gradient /
    // Repeater / Groups / Path shapes, etc.) — captured recursively so
    // trim path animation and every other vector operator comes along.
    try {
      var vectorsGroup = src.property("ADBE Root Vectors Group");
      if (vectorsGroup) out.contents = ae_serializeGroup(vectorsGroup, 0);
    } catch (vge) { compxAuditFallback("HOST_AE_COPYEVERYTHING_012", vge); }

    // Stored directly in ExtendScript memory — never serialized through
    // evalScript() — so arbitrarily large captures (many effects, dense
    // keyframes, deep shape contents) can never be truncated in transit.
    compxClipboardSlots[slot] = out;
    return toolResult(true, "Everything copied to slot " + slot + ".");
  } catch (e) {
    return toolResult(false, String(e));
  }
}

// PASTE EVERYTHING — applies the data captured by ae_copyEverything() (held
// in compxClipboardSlots, never serialized) to every selected layer.
// Restores transform, effects, masks, blending mode, solo/shy, in/out,
// stretch, enabled state, label, layer styles, and shape contents.
function ae_pasteEverything(slotArg) {
  try {
    var slot = parseInt(slotArg, 10);
    if (!slot || slot < 1) slot = 1;
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var data = compxClipboardSlots[slot];
    if (!data) return toolResult(false, "Slot " + slot + " is empty \u2014 copy FX first.");

    app.beginUndoGroup("Paste Everything");
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      try {
        // General properties
        if (data.enabled !== undefined) layer.enabled = data.enabled;
        if (data.shy !== undefined) layer.shy = data.shy;
        if (data.solo !== undefined) layer.solo = data.solo;
        if (data.blendingMode !== undefined) layer.blendingMode = data.blendingMode;
        if (data.label !== undefined) layer.label = data.label;
        if (data.stretch !== undefined) layer.stretch = data.stretch;
        if (data.threeDLayer !== undefined) layer.threeDLayer = data.threeDLayer;
        if (data.adjustmentLayer !== undefined) layer.adjustmentLayer = data.adjustmentLayer;
        if (data.inPoint !== undefined) layer.inPoint = data.inPoint;
        if (data.outPoint !== undefined) layer.outPoint = data.outPoint;
        try { if (data.guideLayer !== undefined) layer.guideLayer = data.guideLayer; } catch (ge) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_001", ge); }
        try { if (data.nullLayer !== undefined) layer.nullLayer = data.nullLayer; } catch (ne) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_002", ne); }

        // Transform
        var transProps = ["position", "scale", "rotation", "opacity", "anchorPoint"];
        var transMatches = ["ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity", "ADBE Anchor Point"];
        if (data.transform) {
          for (var t = 0; t < transProps.length; t++) {
            var pData = data.transform[transProps[t]];
            if (!pData) continue;
            try {
              var pp = layer.property(transMatches[t]);
              if (!pp) continue;
              if (pData.keys && pData.keys.length > 0) {
                var times = [], vals = [];
                for (var k = 0; k < pData.keys.length; k++) {
                  times.push(pData.keys[k].t);
                  vals.push(pData.keys[k].v);
                }
                pp.setValuesAtTimes(times, vals);
              } else if (pData.value !== undefined) {
                pp.setValue(pData.value);
              }
            } catch (pe) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_003", pe); }
          }
        }

        // Effects
        if (data.effects && data.effects.length > 0) {
          var fxGroup = layer.property("ADBE Effect Parade");
          if (fxGroup) {
            for (var e = 0; e < data.effects.length; e++) {
              var saved = data.effects[e];
              if (!saved || !saved.matchName) continue;
              var ef = null;
              for (var j = 1; j <= fxGroup.numProperties; j++) {
                try { if (fxGroup.property(j).matchName === saved.matchName) { ef = fxGroup.property(j); break; } } catch (te) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_004", te); }
              }
              if (!ef) { try { ef = fxGroup.addProperty(saved.matchName); } catch (ae) { continue; } }
              if (!ef) continue;
              try { ef.enabled = (saved.enabled !== false); } catch (en) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_005", en); }
              if (!saved.props) continue;
              for (var p = 0; p < saved.props.length; p++) {
                var pData2 = saved.props[p];
                if (!pData2 || !pData2.matchName) continue;
                try {
                  for (var sp = 1; sp <= ef.numProperties; sp++) {
                    try {
                      var spProp = ef.property(sp);
                      if (spProp && spProp.matchName === pData2.matchName) {
                        if (pData2.keys && pData2.keys.length > 0) {
                          var t2 = [], v2 = [];
                          for (var k2 = 0; k2 < pData2.keys.length; k2++) { t2.push(pData2.keys[k2].t); v2.push(pData2.keys[k2].v); }
                          spProp.setValuesAtTimes(t2, v2);
                        } else if (pData2.value !== undefined) {
                          spProp.setValue(pData2.value);
                        }
                        break;
                      }
                    } catch (te2) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_006", te2); }
                  }
                } catch (pe2) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_007", pe2); }
              }
            }
          }
        }

        // Masks
        if (data.masks && data.masks.length > 0) {
          var maskParade = layer.property("ADBE Mask Parade");
          if (maskParade) {
            for (var m = 0; m < data.masks.length; m++) {
              var mData = data.masks[m];
              if (!mData) continue;
              try {
                var newMask = maskParade.addProperty("ADBE Mask Atom");
                if (!newMask) continue;
                if (mData.name) newMask.name = mData.name;
                if (mData.inverted !== undefined) newMask.inverted = mData.inverted;
                if (mData.maskMode !== undefined) newMask.maskMode = mData.maskMode;
                var shapeProp = newMask.property("ADBE Mask Shape");
                if (shapeProp && mData.shape) { try { shapeProp.setValue(ae_plainToShape(mData.shape)); } catch (se) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_008", se); } }
                if (shapeProp && mData.shapeKeys) {
                  var st = [], sv = [];
                  for (var sk = 0; sk < mData.shapeKeys.length; sk++) { st.push(mData.shapeKeys[sk].t); sv.push(ae_plainToShape(mData.shapeKeys[sk].v)); }
                  try { shapeProp.setValuesAtTimes(st, sv); } catch (se2) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_009", se2); }
                }
                if (mData.feather !== undefined) { var fp = newMask.property("ADBE Mask Feather"); if (fp) fp.setValue(mData.feather); }
                if (mData.opacity !== undefined) { var op = newMask.property("ADBE Mask Opacity"); if (op) op.setValue(mData.opacity); }
                if (mData.expansion !== undefined) { var ep = newMask.property("ADBE Mask Expansion"); if (ep) ep.setValue(mData.expansion); }
              } catch (me) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_010", me); }
            }
          }
        }

        // Layer Styles
        if (data.layerStyle) {
          try {
            var lsGroup = layer.property("ADBE Layer Styles");
            if (lsGroup) {
              for (var lsKey in data.layerStyle) {
                var lsData = data.layerStyle[lsKey];
                if (!lsData || !lsData.matchName) continue;
                try {
                  var lsItem = null;
                  for (var lsi = 1; lsi <= lsGroup.numProperties; lsi++) {
                    try { if (lsGroup.property(lsi).matchName === lsData.matchName) { lsItem = lsGroup.property(lsi); break; } } catch (te3) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_011", te3); }
                  }
                  if (!lsItem) { try { lsItem = lsGroup.addProperty(lsData.matchName); } catch (ae2) { continue; } }
                  if (!lsItem || !lsData.props) continue;
                  for (var lspp = 0; lspp < lsData.props.length; lspp++) {
                    var lsPd = lsData.props[lspp];
                    if (!lsPd || !lsPd.matchName) continue;
                    try {
                      var lsProp = lsItem.property(lsPd.matchName);
                      if (!lsProp) continue;
                      if (lsPd.keys && lsPd.keys.length > 0) {
                        var lt = [], lv = [];
                        for (var lk2 = 0; lk2 < lsPd.keys.length; lk2++) { lt.push(lsPd.keys[lk2].t); lv.push(lsPd.keys[lk2].v); }
                        lsProp.setValuesAtTimes(lt, lv);
                      } else if (lsPd.value !== undefined) {
                        lsProp.setValue(lsPd.value);
                      }
                    } catch (lpe) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_012", lpe); }
                  }
                } catch (lse) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_013", lse); }
              }
            }
          } catch (lse2) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_014", lse2); }
        }

        // Shape layer contents (Fill / Stroke / Trim Paths / Gradient /
        // Repeater / Groups / Path shapes, etc.)
        if (data.contents && data.contents.length > 0) {
          try {
            var destVectors = layer.property("ADBE Root Vectors Group");
            if (destVectors) ae_applyGroup(destVectors, data.contents);
          } catch (vge2) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_015", vge2); }
        }

        applied++;
      } catch (le) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_016", le); }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "Pasted onto " + applied + " layer(s)." : "Could not paste layer data.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_PASTEEVERYTHING_017", e2); }
    return toolResult(false, String(e));
  }
}

// COPY CURVE — reads the temporal easing data from every keyframe on
// the selected property of the first selected layer. Captures
// interpolation type, temporal ease, roving, and spatial tangent info.
function ae_copyCurve() {
  try {
    var comp = getActiveComp();
    if (!comp) return dataResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return dataResult(false, "No layers selected.");

    var src = layers[0];
    var sel = src.selectedProperties;
    var prop = null;
    for (var i = 0; i < sel.length; i++) {
      if (sel[i] instanceof Property) { prop = sel[i]; break; }
    }
    if (!prop) {
      var fallbackNames = ["Position", "Scale", "Rotation", "Opacity", "Anchor Point"];
      for (var n = 0; n < fallbackNames.length; n++) {
        try { var tp = src.property(fallbackNames[n]); if (tp) { prop = tp; break; } } catch (pe) { compxAuditFallback("HOST_AE_COPYCURVE_001", pe); }
      }
    }
    if (!prop) return dataResult(false, "Select an animated property first.");
    if (prop.numKeys === 0) return dataResult(false, "The selected property has no keyframes.");

    var data = { matchName: prop.matchName, name: prop.name, keys: [] };
    for (var k = 1; k <= prop.numKeys; k++) {
      var key = {
        t: prop.keyTime(k),
        v: prop.keyValue(k),
        inType: prop.keyInInterpolationType(k),
        outType: prop.keyOutInterpolationType(k),
        roving: prop.keyRoving(k),
        selected: prop.keySelected(k)
      };
      try { key.inEase = prop.keyInTemporalEase(k); } catch (ee) { compxAuditFallback("HOST_AE_COPYCURVE_002", ee); }
      try { key.outEase = prop.keyOutTemporalEase(k); } catch (ee) { compxAuditFallback("HOST_AE_COPYCURVE_003", ee); }
      try {
        var st = prop.keySpatialTangent(k);
        if (st) key.spatialTangent = st;
      } catch (se) { compxAuditFallback("HOST_AE_COPYCURVE_004", se); }
      try { key.temporalContinuous = prop.keyTemporalContinuous(k); } catch (tce) { compxAuditFallback("HOST_AE_COPYCURVE_005", tce); }
      try { key.temporalAuto = prop.keyTemporalAuto(k); } catch (tae) { compxAuditFallback("HOST_AE_COPYCURVE_006", tae); }
      data.keys.push(key);
    }

    var json;
    try { json = JSON.stringify(data); } catch (je) { return dataResult(false, "Could not serialize curve data."); }
    return dataResult(true, data.keys.length + " keyframe(s) copied.", json);
  } catch (e) {
    return dataResult(false, String(e));
  }
}

// PASTE CURVE — applies temporal/easing data saved by ae_copyCurve()
// to the matching property of every selected layer. If the property has
// the same number of keyframes, it overlays the saved easing; otherwise
// it attempts a best-effort match by index.
function ae_pasteCurve(dataStr) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var data;
    try { data = JSON.parse(dataStr); } catch (je) { return toolResult(false, "Curve data unreadable."); }
    if (!data || !data.keys || !data.keys.length) return toolResult(false, "No curve data to paste.");

    app.beginUndoGroup("Paste Curve");
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var prop = null;
      try {
        if (data.matchName) prop = layer.property(data.matchName);
        if (!prop) {
          for (var pn = 1; pn <= 5; pn++) {
            try { var ap = layer.property(pn); if (ap && ap.numKeys > 0) { prop = ap; break; } } catch (pe) { compxAuditFallback("HOST_AE_PASTECURVE_001", pe); }
          }
        }
      } catch (pe2) { compxAuditFallback("HOST_AE_PASTECURVE_002", pe2); }
      if (!prop || prop.numKeys === 0) continue;

      var count = Math.min(prop.numKeys, data.keys.length);
      var offset = 0;
      if (prop.numKeys !== data.keys.length) {
        // If counts differ, try to align from the last keyframe
        offset = prop.numKeys - data.keys.length;
      }
      for (var k = 0; k < count; k++) {
        var idx = k + 1;
        var srcK = data.keys[k];
        if (!srcK) continue;
        try {
          if (srcK.inType !== undefined) prop.setInterpolationTypeAtKey(idx, srcK.inType, srcK.outType !== undefined ? srcK.outType : prop.keyOutInterpolationType(idx));
          if (srcK.roving !== undefined) prop.setRovingAtKey(idx, srcK.roving);
          if (srcK.inEase) prop.setTemporalEaseAtKey(idx, srcK.inEase, srcK.outEase || srcK.inEase);
          if (srcK.temporalContinuous !== undefined) prop.setTemporalContinuousAtKey(idx, srcK.temporalContinuous);
          if (srcK.temporalAuto !== undefined) prop.setTemporalAutoAtKey(idx, srcK.temporalAuto);
          if (srcK.spatialTangent) try { prop.setSpatialTangentAtKey(idx, srcK.spatialTangent); } catch (st) { compxAuditFallback("HOST_AE_PASTECURVE_003", st); }
        } catch (ke) { compxAuditFallback("HOST_AE_PASTECURVE_004", ke); }
      }
      applied++;
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "Curve pasted onto " + applied + " layer(s)." : "No compatible animated property found.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_PASTECURVE_005", e2); }
    return toolResult(false, String(e));
  }
}

// APPLY CURVE PRESET — applies a named easing preset to every selected
// keyframe on the selected property. Supported presets:
//   easeIn       — ease in  (incoming = eased)
//   easeOut      — ease out (outgoing = eased)
//   easeInOut    — both eased
//   linear       — linear interpolation both ways
//   hold         — hold (step) interpolation
//   smoothDrift  — both eased with continuous/auto on
function ae_applyCurvePreset(arg) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var preset = String(arg || "easeInOut").toLowerCase();
    app.beginUndoGroup("Apply Curve Preset: " + preset);
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var sel = layer.selectedProperties;
      for (var p = 0; p < sel.length; p++) {
        var prop = sel[p];
        if (!(prop instanceof Property) || prop.numKeys === 0) continue;
        for (var k = 1; k <= prop.numKeys; k++) {
          try {
            switch (preset) {
              case "easein":
                prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, prop.keyOutInterpolationType(k));
                prop.setTemporalEaseAtKey(k, [{ influence: 33.33, speed: 0 }], prop.keyOutTemporalEase(k));
                prop.setTemporalContinuousAtKey(k, false);
                prop.setTemporalAutoAtKey(k, false);
                break;
              case "easeout":
                prop.setInterpolationTypeAtKey(k, prop.keyInInterpolationType(k), KeyframeInterpolationType.BEZIER);
                var inEase = prop.keyInTemporalEase(k);
                prop.setTemporalEaseAtKey(k, inEase, [{ influence: 33.33, speed: 0 }]);
                prop.setTemporalContinuousAtKey(k, false);
                prop.setTemporalAutoAtKey(k, false);
                break;
              case "easeinout":
                prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                prop.setTemporalEaseAtKey(k, [{ influence: 33.33, speed: 0 }], [{ influence: 33.33, speed: 0 }]);
                prop.setTemporalContinuousAtKey(k, false);
                prop.setTemporalAutoAtKey(k, false);
                break;
              case "linear":
                prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                break;
              case "hold":
                prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
                break;
              case "smoothdrift":
                prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                prop.setTemporalEaseAtKey(k, [{ influence: 50, speed: 0 }], [{ influence: 50, speed: 0 }]);
                prop.setTemporalContinuousAtKey(k, true);
                prop.setTemporalAutoAtKey(k, true);
                break;
              default:
                prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                prop.setTemporalEaseAtKey(k, [{ influence: 33.33, speed: 0 }], [{ influence: 33.33, speed: 0 }]);
                break;
            }
          } catch (ke) { compxAuditFallback("HOST_AE_APPLYCURVEPRESET_001", ke); }
        }
        applied++;
      }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "Preset \"" + preset + "\" applied to " + applied + " propert(y/ies)." : "No keyframed properties selected.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_APPLYCURVEPRESET_002", e2); }
    return toolResult(false, String(e));
  }
}

// PURGE — calls app.purge() with the requested target.
// arg: "all" | "imageCache" | "undo" | "snapshot"
function ae_purge(arg) {
  try {
    var target = String(arg || "all").toLowerCase();
    var purgeTarget;
    switch (target) {
      case "imagecache":
      case "image":
        purgeTarget = PurgeTarget.IMAGE_CACHES;
        break;
      case "undo":
        purgeTarget = PurgeTarget.UNDO_CACHES;
        break;
      case "snapshot":
        purgeTarget = PurgeTarget.SNAPSHOT_CACHES;
        break;
      default:
        purgeTarget = PurgeTarget.ALL_CACHES;
        target = "all";
        break;
    }
    app.purge(purgeTarget);
    return toolResult(true, "Purged " + target + " cache(s).");
  } catch (e) {
    return toolResult(false, String(e));
  }
}

// GET COMP STATS — returns composition statistics as JSON: dimensions,
// duration, frame rate, layer counts by type, precomps, effects, masks,
// and estimated memory footprint.
function ae_getCompStats() {
  try {
    var comp = getActiveComp();
    if (!comp) return dataResult(false, "No active composition.");

    var stats = {
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameRate: comp.frameRate,
      numLayers: comp.numLayers,
      layerCounts: { footage: 0, solid: 0, text: 0, shape: 0, "null": 0, adjustment: 0, camera: 0, light: 0, precomp: 0, other: 0 },
      totalEffects: 0,
      totalMasks: 0,
      totalKeyframes: 0,
      hasMissingFootage: false
    };

    for (var i = 1; i <= comp.numLayers; i++) {
      var layer = comp.layer(i);
      try {
        if (layer instanceof FootageLayer) stats.layerCounts.footage++;
        else if (layer instanceof SolidLayer) stats.layerCounts.solid++;
        else if (layer instanceof TextLayer) stats.layerCounts.text++;
        else if (layer instanceof ShapeLayer) stats.layerCounts.shape++;
        else if (layer instanceof NullLayer) stats.layerCounts["null"]++;
        else if (layer instanceof AdjustmentLayer) stats.layerCounts.adjustment++;
        else if (layer instanceof CameraLayer) stats.layerCounts.camera++;
        else if (layer instanceof LightLayer) stats.layerCounts.light++;
        else if (layer instanceof AVLayer && layer.source instanceof CompItem) stats.layerCounts.precomp++;
        else stats.layerCounts.other++;
      } catch (tce) { stats.layerCounts.other++; }

      // Effects count
      try {
        var fx = layer.property("ADBE Effect Parade");
        if (fx) stats.totalEffects += fx.numProperties;
      } catch (efe) { compxAuditFallback("HOST_AE_GETCOMPSTATS_001", efe); }

      // Masks count
      try {
        var masks = layer.property("ADBE Mask Parade");
        if (masks) stats.totalMasks += masks.numProperties;
      } catch (mfe) { compxAuditFallback("HOST_AE_GETCOMPSTATS_002", mfe); }

      // Missing footage
      try {
        if (layer instanceof AVLayer && layer.source instanceof FootageItem) {
          try {
            if (layer.source.mainSource && !layer.source.mainSource.file) stats.hasMissingFootage = true;
          } catch (mse) { compxAuditFallback("HOST_AE_GETCOMPSTATS_003", mse); }
        }
      } catch (mfe2) { compxAuditFallback("HOST_AE_GETCOMPSTATS_004", mfe2); }
    }

    var json;
    try { json = JSON.stringify(stats); } catch (je) { return dataResult(false, "Could not serialize stats."); }
    return dataResult(true, "Comp stats collected.", json);
  } catch (e) {
    return dataResult(false, String(e));
  }
}

// PROJECT DOCTOR — scans the After Effects project for common issues:
//   - Missing footage (file not found on disk)
//   - Empty folders in the project panel
//   - Unused footage items (not referenced by any comp)
// Returns a JSON object with an "issues" array. When mode="fix", it
// also attempts to auto-fix removable issues (delete empty folders,
// prompt about unused footage).
function ae_projectDoctor(mode) {
  try {
    var proj = app.project;
    if (!proj) return dataResult(false, "No open project.");
    var doFix = (String(mode || "").toLowerCase() === "fix");

    var issues = [];
    var allFootage = [];
    var allFolders = [];
    var usedFootage = {};
    var fixReport = { foldersRemoved: 0, itemsRemoved: 0 };

    // Collect all footage items and folders
    function scan(folder, path) {
      for (var i = 1; i <= folder.numItems; i++) {
        var item = folder.item(i);
        if (item instanceof FolderItem) {
          allFolders.push({ item: item, path: path + "/" + item.name, folder: folder });
          scan(item, path + "/" + item.name);
        } else if (item instanceof FootageItem) {
          allFootage.push({ item: item, path: path + "/" + item.name });
        }
      }
    }
    scan(proj.rootFolder, "");

    // Determine which footage is used in comps
    function trackUsedFootage() {
      for (var c = 1; c <= proj.numItems; c++) {
        var it = proj.item(c);
        if (it instanceof CompItem) {
          for (var l = 1; l <= it.numLayers; l++) {
            try {
              var layer = it.layer(l);
              if (layer instanceof AVLayer && layer.source && layer.source instanceof FootageItem) {
                usedFootage[layer.source.name + "_" + layer.source.id] = true;
              }
            } catch (le) { compxAuditFallback("HOST_TRACKUSEDFOOTAGE_001", le); }
          }
        }
      }
    }
    trackUsedFootage();

    // Check each footage item
    for (var f = 0; f < allFootage.length; f++) {
      var fi = allFootage[f].item;
      var key = fi.name + "_" + fi.id;
      var missing = false;
      try {
        if (fi.mainSource && fi.mainSource.file) {
          var file = fi.mainSource.file;
          if (!file.exists) missing = true;
        } else {
          missing = true;
        }
      } catch (mse) {
        missing = true;
      }
      if (missing) {
        issues.push({ type: "missingFootage", severity: "high", itemName: fi.name, path: allFootage[f].path, fixable: false });
      } else if (!usedFootage[key]) {
        issues.push({ type: "unusedFootage", severity: "low", itemName: fi.name, path: allFootage[f].path, fixable: true });
      }
    }

    // Check for empty folders (but not root)
    for (var d = 0; d < allFolders.length; d++) {
      if (allFolders[d].item.numItems === 0) {
        issues.push({ type: "emptyFolder", severity: "medium", itemName: allFolders[d].item.name, path: allFolders[d].path, fixable: true });
      }
    }

    // Auto-fix if requested
    if (doFix) {
      app.beginUndoGroup("Project Doctor Fix");
      // Remove empty folders (bottom-up)
      for (var d2 = allFolders.length - 1; d2 >= 0; d2--) {
        if (allFolders[d2].item.numItems === 0) {
          try {
            allFolders[d2].folder.remove(allFolders[d2].item);
            fixReport.foldersRemoved++;
          } catch (re) { compxAuditFallback("HOST_TRACKUSEDFOOTAGE_002", re); }
        }
      }
      app.endUndoGroup();
    }

    var result = {
      totalIssues: issues.length,
      fixable: issues.filter(function(iss) { return iss.fixable; }).length,
      notFixable: issues.filter(function(iss) { return !iss.fixable; }).length,
      issues: issues,
      fixReport: doFix ? fixReport : null
    };

    var json;
    try { json = JSON.stringify(result); } catch (je) { return dataResult(false, "Could not serialize report."); }
    return dataResult(true, "Project scanned: " + issues.length + " issue(s) found.", json);
  } catch (e) {
    return dataResult(false, String(e));
  }
}

// ORGANIZE PROJECT — scans all items in the project panel and
// categorizes them by type. Returns a preview JSON. When mode="apply",
// creates the folder structure and moves items.
function ae_organizeProject(cfgStr) {
  try {
    var proj = app.project;
    if (!proj) return dataResult(false, "No open project.");

    var cfg = {};
    try {
      if (cfgStr && String(cfgStr).charAt(0) === "{") cfg = JSON.parse(String(cfgStr));
      else if (String(cfgStr || "").toLowerCase() === "apply") cfg = { apply: true };
    } catch (ce) { cfg = {}; }

    var doApply       = !!cfg.apply;
    var rootOnly      = (cfg.rootOnly !== false);
    var createMissing = (cfg.createMissing !== false);
    var smart         = !!cfg.smart;

    var allCats = ["comps","precomps","video","images","audio","solids","threeD","unused","other"];
    var enabled = {};
    if (cfg.categories && cfg.categories.length) {
      for (var a = 0; a < allCats.length; a++) enabled[allCats[a]] = false;
      for (var b = 0; b < cfg.categories.length; b++) enabled[cfg.categories[b]] = true;
    } else {
      for (var a2 = 0; a2 < allCats.length; a2++) enabled[allCats[a2]] = true;
    }

    var VIDEO  = [".mp4",".mov",".avi",".mpeg",".mpg",".webm",".flv",".m4v",".mxf",".r3d"];
    var IMAGE  = [".png",".jpg",".jpeg",".psd",".ai",".tif",".tiff",".bmp",".gif",".exr",".dpx",".cin",".hdr",".tga",".svg"];
    var AUDIO  = [".mp3",".wav",".aif",".aiff",".aac",".ogg",".wma",".m4a"];
    var THREED = [".obj",".c4d",".3ds",".fbx",".dae",".glb",".gltf",".abc"];

    var SMART = [
      { folder: "Brand",       kw: ["logo","brand","icon","mark","watermark"] },
      { folder: "Characters",  kw: ["character","char","hero","avatar","person","actor"] },
      { folder: "Backgrounds", kw: ["background","backdrop","_bg","bg_","scene"] },
      { folder: "SFX",         kw: ["sfx","whoosh","swoosh","impact","swipe"] },
      { folder: "Music",       kw: ["music","bgm","song","track","soundtrack","theme"] }
    ];

    function extOf(item) {
      try {
        if (item.mainSource && item.mainSource.file) {
          var fn = item.mainSource.file.name || "";
          var d = fn.lastIndexOf(".");
          if (d >= 0) return fn.substring(d).toLowerCase();
        }
      } catch (e) { compxAuditFallback("HOST_EXTOF_001", e); }
      return "";
    }
    function isUsed(item) {
      try { return item.usedIn && item.usedIn.length > 0; } catch (e) { return false; }
    }
    function smartFolder(name) {
      var ln = String(name || "").toLowerCase();
      for (var s = 0; s < SMART.length; s++) {
        for (var k = 0; k < SMART[s].kw.length; k++) {
          if (ln.indexOf(SMART[s].kw[k]) >= 0) return SMART[s].folder;
        }
      }
      return null;
    }

    var orgNames = { "comps":1,"precomps":1,"footage":1,"solids":1,"unused":1,"assets":1 };

    var items = [];
    if (rootOnly) {
      for (var r = proj.rootFolder.numItems; r >= 1; r--) {
        var it0 = proj.rootFolder.item(r);
        if (!(it0 instanceof FolderItem)) items.push(it0);
      }
    } else {
      (function collect(folder, isRoot) {
        for (var i = folder.numItems; i >= 1; i--) {
          var item = folder.item(i);
          if (item instanceof FolderItem) {
            if (isRoot && orgNames[item.name.toLowerCase()]) continue;
            collect(item, false);
          } else {
            items.push(item);
          }
        }
      })(proj.rootFolder, true);
    }

    var plan = [];
    function add(parts, key, item) {
      plan.push({ parts: parts, key: key, name: item.name, id: item.id, item: item });
    }

    for (var q = 0; q < items.length; q++) {
      var item = items[q];
      if (item instanceof CompItem) {
        if (isUsed(item)) { if (enabled.precomps) add(["Precomps"], "precomps", item); }
        else { if (enabled.comps) add(["Comps"], "comps", item); }
        continue;
      }
      if (item instanceof FootageItem) {
        var isSolid = false;
        try { isSolid = (item.mainSource instanceof SolidSource); } catch (e) { compxAuditFallback("HOST_ADD_001", e); }
        if (isSolid) { if (enabled.solids) add(["Solids"], "solids", item); continue; }

        if (enabled.unused && !isUsed(item)) { add(["Unused"], "unused", item); continue; }

        if (smart) {
          var sf = smartFolder(item.name);
          if (sf) { add(["Assets", sf], "assets", item); continue; }
        }

        var ext = extOf(item);
        if (VIDEO.indexOf(ext) >= 0) { if (enabled.video) add(["Footage","Video"], "video", item); }
        else if (IMAGE.indexOf(ext) >= 0) { if (enabled.images) add(["Footage","Images"], "images", item); }
        else if (AUDIO.indexOf(ext) >= 0) { if (enabled.audio) add(["Footage","Audio"], "audio", item); }
        else if (THREED.indexOf(ext) >= 0) { if (enabled.threeD) add(["Footage","3D"], "threeD", item); }
        else { if (enabled.other) add(["Footage","Other"], "other", item); }
        continue;
      }
      if (enabled.other) add(["Footage","Other"], "other", item);
    }

    var order = [];
    var byPath = {};
    for (var p = 0; p < plan.length; p++) {
      var path = plan[p].parts.join("/");
      if (!byPath[path]) { byPath[path] = { folder: path, count: 0 }; order.push(path); }
      byPath[path].count++;
    }
    var result = { categories: [], total: plan.length };
    for (var o = 0; o < order.length; o++) result.categories.push(byPath[order[o]]);

    if (doApply && plan.length) {
      app.beginUndoGroup("Organize Project");
      function findFolder(parent, name) {
        for (var f = 1; f <= parent.numItems; f++) {
          try { var ex = parent.item(f); if (ex instanceof FolderItem && ex.name === name) return ex; } catch (e) { compxAuditFallback("HOST_FINDFOLDER_001", e); }
        }
        return null;
      }
      function ensureFolder(parent, name) {
        var ex = findFolder(parent, name);
        if (ex) return ex;
        if (!createMissing) return null;
        return parent.items.addFolder(name);
      }
      var folderCache = {};
      function resolvePath(parts) {
        var key = parts.join("/");
        if (folderCache[key]) return folderCache[key];
        var cur = proj.rootFolder;
        for (var i = 0; i < parts.length; i++) {
          cur = ensureFolder(cur, parts[i]);
          if (!cur) return null;
        }
        folderCache[key] = cur;
        return cur;
      }
      for (var m = 0; m < plan.length; m++) {
        try {
          var target = resolvePath(plan[m].parts);
          if (!target) continue;
          var it2 = plan[m].item;
          if (it2 && it2.parentFolder !== target) {
            try { it2.parentFolder = target; } catch (e1) { try { it2.moveToFolder(target); } catch (e2) { compxAuditFallback("HOST_RESOLVEPATH_001", e2); } }
          }
        } catch (me) { compxAuditFallback("HOST_RESOLVEPATH_002", me); }
      }
      app.endUndoGroup();
    }

    var json;
    try { json = JSON.stringify(result); } catch (je) { return dataResult(false, "Could not serialize."); }
    return dataResult(true, doApply ? "Project organized." : "Project scan complete.", json);
  } catch (e) {
    return dataResult(false, String(e));
  }
}

// SUPER MORPH — morphs between the first mask path of the first selected
// layer and the first mask path of the last selected layer. Creates a new
// shape/solid layer with intermediate mask-path keyframes so the shape
// smoothly transitions. Steps = number of intermediate keyframes.
function ae_superMorph(steps) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length < 2) return toolResult(false, "Select at least 2 layers with mask paths.");

    steps = Math.max(1, Number(steps) || 10);

    // Read start mask (first layer, first mask)
    var startLayer = layers[0];
    var endLayer = layers[layers.length - 1];
    var startMaskGroup = startLayer.property("ADBE Mask Parade");
    var endMaskGroup = endLayer.property("ADBE Mask Parade");
    if (!startMaskGroup || startMaskGroup.numProperties < 1) return toolResult(false, "First selected layer has no mask.");
    if (!endMaskGroup || endMaskGroup.numProperties < 1) return toolResult(false, "Last selected layer has no mask.");

    var startMask = startMaskGroup.property(1);
    var endMask = endMaskGroup.property(1);
    var startShapeProp = startMask.property("ADBE Mask Shape");
    var endShapeProp = endMask.property("ADBE Mask Shape");
    if (!startShapeProp || !endShapeProp) return toolResult(false, "Could not read mask shapes.");

    var startShape = startShapeProp.value;
    var endShape = endShapeProp.value;
    if (!startShape || !endShape) return toolResult(false, "Mask shapes are empty.");

    var sv = startShape.vertices;
    var ev = endShape.vertices;
    if (!sv || !ev || sv.length < 3 || ev.length < 3) return toolResult(false, "Masks need at least 3 vertices.");

    // Match vertex counts by padding the shorter one with its last vertex
    var maxLen = Math.max(sv.length, ev.length);
    while (sv.length < maxLen) sv.push(sv[sv.length - 1]);
    while (ev.length < maxLen) ev.push(ev[ev.length - 1]);

    var si = startShape.inTangents;
    var so = startShape.outTangents;
    var ei = endShape.inTangents;
    var eo = endShape.outTangents;
    while (si.length < maxLen) si.push(si[si.length - 1] || [0, 0]);
    while (so.length < maxLen) so.push(so[so.length - 1] || [0, 0]);
    while (ei.length < maxLen) ei.push(ei[ei.length - 1] || [0, 0]);
    while (eo.length < maxLen) eo.push(eo[eo.length - 1] || [0, 0]);

    var isClosed = (startShape.closed && endShape.closed);

    app.beginUndoGroup("Super Morph");

    // Create a new solid layer for the morph
    var solid = comp.layers.addSolid([1, 1, 1], "MORPH_" + startLayer.name + "_to_" + endLayer.name, comp.width, comp.height, comp.pixelAspect, comp.duration);
    var solidMaskGroup = solid.property("ADBE Mask Parade");
    var newMask = solidMaskGroup.addProperty("ADBE Mask Atom");
    if (!newMask) { app.endUndoGroup(); return toolResult(false, "Could not create mask."); }

    var newShapeProp = newMask.property("ADBE Mask Shape");
    if (!newShapeProp) { app.endUndoGroup(); return toolResult(false, "Could not access mask shape."); }

    var duration = comp.duration;
    var interval = duration / (steps + 1);

    // Set first keyframe at time 0
    var startShapeObj = {
      vertices: sv,
      inTangents: si,
      outTangents: so,
      closed: isClosed
    };
    // FIX: use setValueAtTime (NOT setValueAtKey) to CREATE keyframes.
    // setValueAtKey(index, value) only updates an already-existing key by
    // its 1-based index — it cannot add new ones, so the old code silently
    // fell through to setValue() which just set a static value with no keys.
    newShapeProp.setValueAtTime(0, ae_plainToShape(startShapeObj));

    // Set last keyframe at comp end
    var endShapeObj = {
      vertices: ev,
      inTangents: ei,
      outTangents: eo,
      closed: isClosed
    };
    newShapeProp.setValueAtTime(comp.duration, ae_plainToShape(endShapeObj));

    // Create intermediate keyframes
    for (var s = 1; s <= steps; s++) {
      var t = s / (steps + 1);
      var interpVerts = [];
      var interpIn = [];
      var interpOut = [];
      for (var v = 0; v < maxLen; v++) {
        interpVerts.push([
          sv[v][0] + (ev[v][0] - sv[v][0]) * t,
          sv[v][1] + (ev[v][1] - sv[v][1]) * t
        ]);
        interpIn.push([
          si[v][0] + (ei[v][0] - si[v][0]) * t,
          si[v][1] + (ei[v][1] - si[v][1]) * t
        ]);
        interpOut.push([
          so[v][0] + (eo[v][0] - so[v][0]) * t,
          so[v][1] + (eo[v][1] - so[v][1]) * t
        ]);
      }
      var interpShape = {
        vertices: interpVerts,
        inTangents: interpIn,
        outTangents: interpOut,
        closed: isClosed
      };
      try {
        newShapeProp.setValueAtTime(interval * s, ae_plainToShape(interpShape));
      } catch (se) { compxAuditFallback("HOST_AE_SUPERMORPH_001", se); }
    }

    // Set mask mode to Add so it's visible
    try { newMask.maskMode = MaskMode.ADD; } catch (me) { compxAuditFallback("HOST_AE_SUPERMORPH_002", me); }

    // Move solid to top
    try { solid.moveToBeginning(); } catch (me2) { compxAuditFallback("HOST_AE_SUPERMORPH_003", me2); }

    app.endUndoGroup();
    return toolResult(true, "Morph created with " + maxLen + " vertices and " + steps + " intermediate steps.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_SUPERMORPH_004", e2); }
    return toolResult(false, String(e));
  }
}

// SUPER MORPH 2 — Shape Layer vector-path morphing. Unlike the legacy mask
// version above, this reads first vector paths from two selected Shape Layers,
// resamples unequal vertex counts, and creates a visible animated Shape Layer.
// ──────────────────────────────────────────────────────────────────���────────
// Super Morph Helper — adds Turbulent Displace to one layer and keyframes Amount
// ───────────────────────────────────────────────────────────────────────────
function applyMorphWarp(layer, maxAmt, startAmt, t, dur) {
  var fx = layer.property("ADBE Effect Parade");
  var td = fx.addProperty("ADBE Turbulent Displace");
  // "ADBE Turbulent Displace-0001" is the match name for the Amount property
  var amount = td.property("ADBE Turbulent Displace-0001");
  var endAmt = (startAmt === 0) ? maxAmt : 0;
  amount.setValueAtTime(t, startAmt);
  amount.setValueAtTime(t + dur, endAmt);
  smoothMorphKeys(amount);
}

// Apply BEZIER (easy-ease) interpolation to every keyframe on a property
function smoothMorphKeys(prop) {
  for (var i = 1; i <= prop.numKeys; i++) {
    try {
      prop.setInterpolationTypeAtKey(
        i,
        KeyframeInterpolationType.BEZIER,
        KeyframeInterpolationType.BEZIER
      );
    } catch (easeErr) { compxAuditFallback("HOST_SMOOTHMORPHKEYS_001", easeErr); }
  }
}

// ─────────────────────────────────────────────────────────────────────────���─
// SUPER MORPH ADVANCED  v2  —  Cross-dissolve + Turbulent Displace warp
// Based on the approach by the user: opacity cross-fade between two layers
// with a Turbulent Displace warp effect that peaks at mid-transition,
// creating a fluid morph that works on ANY layer type (text, video, shape, solid).
//
// UI parameters (from ae_superMorphAdvanced dataStr):
//   duration   — seconds (0.2 – 8)
//   elasticity — warp amount in pixels (0 = cross-dissolve only, 100 = heavy warp)
//   autoEase   — apply easy-ease to all keyframes
// ───────────────────────────────────────────────────────────────────────────
function ae_superMorphAdvanced(dataStr) {
  try {
    var opts = { duration: 1.2, elasticity: 80, autoEase: true };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.duration !== undefined) opts.duration = Number(parsed.duration);
        if (parsed.elasticity !== undefined) opts.elasticity = Number(parsed.elasticity);
        if (parsed.autoEase !== undefined) opts.autoEase = !!parsed.autoEase;
      } catch (parseErr) { compxAuditFallback("HOST_AE_SUPERMORPHADVANCED_001", parseErr); }
    }
    opts.duration  = Math.max(0.2, Math.min(8,   opts.duration  || 1.2));
    opts.elasticity = Math.max(0,   Math.min(100, opts.elasticity || 80));

    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    var layers = getSelectedLayers(comp);
    if (layers.length !== 2) {
      return toolResult(false, "Super Morph needs exactly 2 selected layers. Got " + layers.length + ". Select source first, then target.");
    }

    var layerA = layers[0];               // যেটা থেকে morph শুরু (fades out)
    var layerB = layers[layers.length - 1]; // যেটাতে morph শেষ (fades in)
    var t      = comp.time;               // current time থেকে শুরু
    var dur    = opts.duration;
    var mid    = t + dur * 0.5;           // transition midpoint

    // elasticity (0-100) → warp pixels (0-300) and pinch percent (0-25%)
    var warpAmount  = (opts.elasticity / 100) * 300;
    var pinchFactor = 1 - (opts.elasticity / 100) * 0.25; // e.g. 80 → 0.80 scale

    app.beginUndoGroup("Super Morph");

    // ---- 1. Cross-dissolve (opacity) ----
    var trA = layerA.property("ADBE Transform Group");
    var trB = layerB.property("ADBE Transform Group");

    var opA = trA.property("ADBE Opacity");
    opA.setValueAtTime(t,       100);
    opA.setValueAtTime(t + dur, 0);

    var opB = trB.property("ADBE Opacity");
    opB.setValueAtTime(t,       0);
    opB.setValueAtTime(t + dur, 100);

    // ---- 2. Scale Pinch (Elastic-like squeeze at midpoint) ----
    // Layer A shrinks toward midpoint then vanishes (fade out).
    // Layer B starts pinched, grows to full size as it fades in.
    // This creates the illusion that A "collapses into" B.
    if (opts.elasticity > 0) {
      var scaleA = trA.property("ADBE Scale");
      var scaleB = trB.property("ADBE Scale");

      // Read each layer's current scale so we don't override it.
      var baseScaleA = scaleA.value; // e.g. [100, 100]
      var baseScaleB = scaleB.value;
      var pinchA     = [baseScaleA[0] * pinchFactor, baseScaleA[1] * pinchFactor];
      var pinchB     = [baseScaleB[0] * pinchFactor, baseScaleB[1] * pinchFactor];

      // Layer A: full size at t → pinched at midpoint (then opacity=0, so irrelevant after)
      scaleA.setValueAtTime(t,   baseScaleA);
      scaleA.setValueAtTime(mid, pinchA);

      // Layer B: pinched at midpoint → full size at t+dur
      scaleB.setValueAtTime(mid,       pinchB);
      scaleB.setValueAtTime(t + dur,   baseScaleB);

      if (opts.autoEase) {
        smoothMorphKeys(scaleA);
        smoothMorphKeys(scaleB);
      }
    }

    // ---- 3. Turbulent Displace warp (organic distortion) ----
    // Layer A: warp 0 → max (distorts as it exits)
    // Layer B: warp max → 0 (un-distorts as it enters)
    if (warpAmount > 0) {
      applyMorphWarp(layerA, warpAmount, 0,          t, dur);
      applyMorphWarp(layerB, warpAmount, warpAmount, t, dur);
    }

    // ---- 4. Easy-ease on opacity keyframes ----
    if (opts.autoEase) {
      smoothMorphKeys(opA);
      smoothMorphKeys(opB);
    }

    app.endUndoGroup();
    return toolResult(
      true,
      "Super Morph created ✔  " + layerA.name + " → " + layerB.name +
      "  (" + dur + "s | warp: " + Math.round(warpAmount) + "px" +
      " | pinch: " + Math.round((1 - pinchFactor) * 100) + "%)"
    );

  } catch (e) {
    try { app.endUndoGroup(); } catch (endErr) { compxAuditFallback("HOST_AE_SUPERMORPHADVANCED_002", endErr); }
    return toolResult(false, "Super Morph failed: " + String(e));
  }
}

// COLOR TOOL — applies a color effect to every selected layer.
// action: "fill" (Fill with primary color), "tint" (Tint from primary to secondary),
//         "colorReplace" (Colorama replacing primary→secondary)
// color / color2: hex strings like "#ff0000"
function ae_colorTool(action, color, color2) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    // Parse hex to [r, g, b] in 0..1 range
    function hexToRGB(h) {
      if (!h || typeof h !== "string") return [1, 0, 0];
      h = h.replace("#", "");
      if (h.length < 6) h = h + h + h;
      return [
        parseInt(h.substr(0, 2), 16) / 255,
        parseInt(h.substr(2, 2), 16) / 255,
        parseInt(h.substr(4, 2), 16) / 255
      ];
    }

    var c1 = hexToRGB(color);
    var c2 = hexToRGB(color2);
    var actionName = String(action || "fill").toLowerCase();

    app.beginUndoGroup("Color Tool: " + actionName);
    var applied = 0;

    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      try {
        var fxGroup = layer.property("ADBE Effect Parade");
        if (!fxGroup) continue;

        if (actionName === "fill") {
          var ef = fxGroup.addProperty("ADBE Fill");
          if (ef) {
            var colorProp = ef.property("ADBE Fill-0002");
            if (colorProp) { try { colorProp.setValue(c1); } catch (se) { compxAuditFallback("HOST_HEXTORGB_001", se); } }
            applied++;
          }
        } else if (actionName === "tint") {
          var ef2 = fxGroup.addProperty("ADBE Tint");
          if (ef2) {
            var blackProp = ef2.property("ADBE Tint-0002");
            var whiteProp = ef2.property("ADBE Tint-0003");
            if (blackProp) { try { blackProp.setValue(c1); } catch (se2) { compxAuditFallback("HOST_HEXTORGB_002", se2); } }
            if (whiteProp) { try { whiteProp.setValue(c2); } catch (se3) { compxAuditFallback("HOST_HEXTORGB_003", se3); } }
            applied++;
          }
        } else if (actionName === "colorreplace") {
          // Use Colorama for color replacement
          var ef3 = fxGroup.addProperty("ADBE Colorama");
          if (ef3) {
            // Set the output cycle to use user colors
            try {
              // Colorama has a complex property structure; we set the
              // "Output Cycle" color control (index 1 of the property)
              var outputCycle = ef3.property("ADBE Colorama-0003");
              if (outputCycle) {
                // Output cycle is usually a color array; we override it
                // to create a gradient from primary to secondary
                var cycleColors = [
                  c1,                       // Start
                  [c1[0]*0.5,c1[1]*0.5,c1[2]*0.5],
                  c2,
                  [c2[0]*0.5,c2[1]*0.5,c2[2]*0.5],
                  c1                        // Wrap around
                ];
                var coloramaProps = ef3.property("ADBE Colorama-0004");
                try { if (coloramaProps) coloramaProps.setValue(1); } catch (se4) { compxAuditFallback("HOST_HEXTORGB_004", se4); }
              }
            } catch (ce) { compxAuditFallback("HOST_HEXTORGB_005", ce); }
            applied++;
          }
        }
      } catch (le) { compxAuditFallback("HOST_HEXTORGB_006", le); }
    }

    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "Color effect applied to " + applied + " layer(s)." : "Could not apply color effect.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_HEXTORGB_007", e2); }
    return toolResult(false, String(e));
  }
}

// APPLY GLOW PRESET — applies the built-in AE Glow effect (ADBE Glo2)
// with a preset configuration. dataStr is JSON:
//   { preset, colorA, colorB, colorMode }
// Presets: soft, medium, intense, neon, dream, edge
function ae_applyGlowPreset(dataStr) {
  try {
    var opts = { preset: "medium", colorA: "#ff4444", colorB: "#ffff00", colorMode: "ab" };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.preset) opts.preset = String(parsed.preset).toLowerCase();
        if (parsed.colorA) opts.colorA = String(parsed.colorA);
        if (parsed.colorB) opts.colorB = String(parsed.colorB);
        if (parsed.colorMode) opts.colorMode = String(parsed.colorMode).toLowerCase();
      } catch (pe) { compxAuditFallback("HOST_AE_APPLYGLOWPRESET_001", pe); }
    }

    function hexToRGB(h) {
      if (!h || typeof h !== "string") return [1, 0, 0];
      h = h.replace("#", "");
      if (h.length < 6) h = h + h + h;
      return [
        parseInt(h.substr(0, 2), 16) / 255,
        parseInt(h.substr(2, 2), 16) / 255,
        parseInt(h.substr(4, 2), 16) / 255
      ];
    }

    var cA = hexToRGB(opts.colorA);
    var cB = hexToRGB(opts.colorB);

    var presets = {
      soft:     { threshold: 0.5, radius: 200, intensity: 0.8, dimension: 2 },
      medium:   { threshold: 0.3, radius: 100, intensity: 1.5, dimension: 2 },
      intense:  { threshold: 0.1, radius: 150, intensity: 3.0, dimension: 2 },
      neon:     { threshold: 0.15, radius: 80,  intensity: 4.0, dimension: 2 },
      dream:    { threshold: 0.6, radius: 300, intensity: 0.6, dimension: 2 },
      edge:     { threshold: 0.85, radius: 50,  intensity: 2.0, dimension: 2 }
    };

    var p = presets[opts.preset] || presets.medium;

    // Color mode mapping
    var colorModeVal = 0; // 0 = Original, 1 = A&B, 2 = Arbitrary
    if (opts.colorMode === "ab") colorModeVal = 1;
    else if (opts.colorMode === "arb") colorModeVal = 2;

    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Glow Preset: " + opts.preset);
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      try {
        var fxGroup = layer.property("ADBE Effect Parade");
        if (!fxGroup) continue;

        // Check if glow already exists
        var glow = null;
        for (var j = 1; j <= fxGroup.numProperties; j++) {
          try {
            var existing = fxGroup.property(j);
            if (existing && existing.matchName === "ADBE Glo2") { glow = existing; break; }
          } catch (te) { compxAuditFallback("HOST_HEXTORGB_008", te); }
        }
        if (!glow) {
          try { glow = fxGroup.addProperty("ADBE Glo2"); } catch (ae) { continue; }
        }
        if (!glow) continue;

        // Set properties
        var thresholdProp = glow.property("ADBE Glo2-0001");
        if (thresholdProp) try { thresholdProp.setValue(p.threshold); } catch (se) { compxAuditFallback("HOST_HEXTORGB_009", se); }

        var radiusProp = glow.property("ADBE Glo2-0002");
        if (radiusProp) try { radiusProp.setValue(p.radius); } catch (se) { compxAuditFallback("HOST_HEXTORGB_010", se); }

        var intensityProp = glow.property("ADBE Glo2-0003");
        if (intensityProp) try { intensityProp.setValue(p.intensity); } catch (se) { compxAuditFallback("HOST_HEXTORGB_011", se); }

        var colorModeProp = glow.property("ADBE Glo2-0004");
        if (colorModeProp) try { colorModeProp.setValue(colorModeVal); } catch (se) { compxAuditFallback("HOST_HEXTORGB_012", se); }

        var colorAProp = glow.property("ADBE Glo2-0005");
        if (colorAProp) try { colorAProp.setValue(cA); } catch (se) { compxAuditFallback("HOST_HEXTORGB_013", se); }

        var colorBProp = glow.property("ADBE Glo2-0006");
        if (colorBProp) try { colorBProp.setValue(cB); } catch (se) { compxAuditFallback("HOST_HEXTORGB_014", se); }

        var dimensionProp = glow.property("ADBE Glo2-0007");
        if (dimensionProp) try { dimensionProp.setValue(p.dimension); } catch (se) { compxAuditFallback("HOST_HEXTORGB_015", se); }

        applied++;
      } catch (le) { compxAuditFallback("HOST_HEXTORGB_016", le); }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "Glow preset \"" + opts.preset + "\" applied to " + applied + " layer(s)." : "Could not apply glow.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_HEXTORGB_017", e2); }
    return toolResult(false, String(e));
  }
}

// SOLID TOOL — creates solid layers at playhead positions.
// action: solidToPlayhead (0→playhead), solidFromPlayhead (playhead→end),
//         solidBetweenLayers (layer1.out→layer2.in), solidFullComp (0→end)
// colorHex: "#ffffff"
function ae_solidTool(action, colorHex) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    var act = String(action || "solidToPlayhead").toLowerCase();

    var c = [0, 0, 0];
    if (colorHex && typeof colorHex === "string") {
      var h = colorHex.replace("#", "");
      if (h.length >= 6) {
        c = [
          parseInt(h.substr(0, 2), 16) / 255,
          parseInt(h.substr(2, 2), 16) / 255,
          parseInt(h.substr(4, 2), 16) / 255
        ];
      }
    }

    var startTime = 0;
    var endTime = comp.duration;
    var layerName = "Solid";

    if (act === "solidtoplayhead") {
      endTime = comp.time;
      layerName = "Solid to Playhead";
    } else if (act === "solidfromplayhead") {
      startTime = comp.time;
      layerName = "Solid from Playhead";
    } else if (act === "solidbetweenlayers") {
      var layers = getSelectedLayers(comp);
      if (layers.length < 2) return toolResult(false, "Select at least 2 layers.");
      startTime = layers[0].outPoint;
      endTime = layers[layers.length - 1].inPoint;
      if (startTime >= endTime) return toolResult(false, "Layer 1 out point must be before layer 2 in point.");
      layerName = "Solid Between Layers";
    } else if (act === "solidfullcomp") {
      layerName = "Solid Full Comp";
    }

    app.beginUndoGroup("Create Solid: " + layerName);
    var solid = comp.layers.addSolid(c, layerName, comp.width, comp.height, comp.pixelAspect, endTime - startTime);
    if (solid) {
      solid.startTime = startTime;
      solid.outPoint = endTime;
    }
    app.endUndoGroup();

    return toolResult(true, "Solid created: " + layerName + " (" + startTime.toFixed(2) + "s → " + endTime.toFixed(2) + "s)");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_SOLIDTOOL_001", e2); }
    return toolResult(false, String(e));
  }
}

// PICK LAYER COLOR — extracts the dominant color from the first selected
// layer. Checks: solid color → text fill color → shape fill color →
// first effect color property. Returns hex string like "#ff6600".
function ae_pickLayerColor() {
  try {
    var comp = getActiveComp();
    if (!comp) return dataResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return dataResult(false, "No layers selected.");
    var layer = layers[0];

    function rgbToHex(r, g, b) {
      function toHex(v) {
        var h = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16);
        return h.length < 2 ? "0" + h : h;
      }
      return "#" + toHex(r) + toHex(g) + toHex(b);
    }

    // 1. Solid layer
    try {
      if (layer instanceof SolidLayer) {
        var col = layer.property("ADBE Color");
        if (col) {
          var v = col.value;
          if (v && v.length >= 3) return dataResult(true, "", '"' + rgbToHex(v[0], v[1], v[2]) + '"');
        }
      }
    } catch (se) { compxAuditFallback("HOST_TOHEX_001", se); }

    // 2. Text layer fill color
    try {
      if (layer instanceof TextLayer) {
        var tp = layer.property("Source Text");
        if (tp) {
          var doc = tp.value;
          if (doc && doc.fillColor) {
            var fc = doc.fillColor;
            return dataResult(true, "", '"' + rgbToHex(fc[0], fc[1], fc[2]) + '"');
          }
        }
      }
    } catch (te) { compxAuditFallback("HOST_TOHEX_002", te); }

    // 3. Shape layer fill
    try {
      if (layer instanceof ShapeLayer) {
        var contents = layer.property("ADBE Root Vectors Group");
        if (contents) {
          for (var ci = 1; ci <= contents.numProperties; ci++) {
            var cg = contents.property(ci);
            if (!cg) continue;
            var fillProp = cg.property("ADBE Vector Fill");
            if (fillProp) {
              var colorProp = fillProp.property("ADBE Vector Fill Color");
              if (colorProp) {
                var cv = colorProp.value;
                if (cv && cv.length >= 3) return dataResult(true, "", '"' + rgbToHex(cv[0], cv[1], cv[2]) + '"');
              }
            }
          }
        }
      }
    } catch (she) { compxAuditFallback("HOST_TOHEX_003", she); }

    // 4. First effect color property
    try {
      var fxGroup = layer.property("ADBE Effect Parade");
      if (fxGroup && fxGroup.numProperties > 0) {
        for (var fxi = 1; fxi <= fxGroup.numProperties; fxi++) {
          var ef = fxGroup.property(fxi);
          if (!ef) continue;
          for (var fp = 1; fp <= ef.numProperties; fp++) {
            try {
              var prop = ef.property(fp);
              if (prop && prop.propertyValueType === PropertyValueType.THREE_D) {
                var ev = prop.value;
                if (ev && ev.length >= 3) return dataResult(true, "", '"' + rgbToHex(ev[0], ev[1], ev[2]) + '"');
              }
            } catch (pe) { compxAuditFallback("HOST_TOHEX_004", pe); }
          }
        }
      }
    } catch (fxe) { compxAuditFallback("HOST_TOHEX_005", fxe); }

    return dataResult(false, "Could not detect a color on the selected layer.");
  } catch (e) {
    return dataResult(false, String(e));
  }
}

// APPLY COLOR — applies a color to selected layers.
// action: "fill" (add Fill effect), "solid" (change solid color)
// colorHex: "#ff6600"
function ae_applyColor(action, colorHex) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var c = [1, 0, 0];
    if (colorHex && typeof colorHex === "string") {
      var h = colorHex.replace("#", "");
      if (h.length >= 6) {
        c = [
          parseInt(h.substr(0, 2), 16) / 255,
          parseInt(h.substr(2, 2), 16) / 255,
          parseInt(h.substr(4, 2), 16) / 255
        ];
      }
    }

    var act = String(action || "fill").toLowerCase();
    app.beginUndoGroup("Apply Color: " + act);
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      try {
        if (act === "solid") {
          if (layer.source && typeof layer.source.color !== "undefined") {
            try {
              layer.source.color = c;
              applied++;
            } catch (se) { compxAuditFallback("HOST_AE_APPLYCOLOR_001", se); }
          } else {
            // Non-solid or layer without direct source color: add a Fill effect instead
            var fxGroup = layer.property("ADBE Effect Parade");
            if (fxGroup) {
              var ef = fxGroup.addProperty("ADBE Fill");
              if (ef) {
                var cp = ef.property("ADBE Fill-0002") || ef.property("Color");
                if (cp) { try { cp.setValue(c); } catch (se2) { compxAuditFallback("HOST_AE_APPLYCOLOR_002", se2); } }
                applied++;
              }
            }
          }
        } else {
          // Default: add Fill effect
          var fxGroup2 = layer.property("ADBE Effect Parade");
          if (fxGroup2) {
            var ef2 = fxGroup2.addProperty("ADBE Fill");
            if (ef2) {
              var cp2 = ef2.property("ADBE Fill-0002");
              if (cp2) { try { cp2.setValue(c); } catch (se3) { compxAuditFallback("HOST_AE_APPLYCOLOR_003", se3); } }
              applied++;
            }
          }
        }
      } catch (le) { compxAuditFallback("HOST_AE_APPLYCOLOR_004", le); }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "Color applied to " + applied + " layer(s)." : "Could not apply color.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_APPLYCOLOR_005", e2); }
    return toolResult(false, String(e));
  }
}

// ae_applyGradientPlate — REMOVED DUPLICATE (see enhanced version below)

// DELETE BEFORE / DELETE AFTER — removes keyframes on the selected
// property(ies) that fall before (or after) the current playhead time.
function ae_deleteKeyframes(mode) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup(mode === "before" ? "Delete Keyframes Before" : "Delete Keyframes After");
    var removed = 0;
    for (var i = 0; i < layers.length; i++) {
      var props = layers[i].selectedProperties;
      for (var p = 0; p < props.length; p++) {
        var prop = props[p];
        if (!(prop instanceof Property) || prop.numKeys === 0) continue;
        for (var k = prop.numKeys; k >= 1; k--) {
          var kt = prop.keyTime(k);
          if ((mode === "before" && kt < comp.time) || (mode === "after" && kt > comp.time)) {
            prop.removeKey(k);
            removed++;
          }
        }
      }
    }
    app.endUndoGroup();
    return toolResult(true, removed ? "" : "No keyframes " + mode + " the playhead on the selected propert(y/ies).");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_DELETEKEYFRAMES_001", e2); }
    return toolResult(false, String(e));
  }
}

// RESIZE COMP — changes the active comp's pixel dimensions, optionally
// scaling every un-animated layer's Position/Scale to compensate.
function ae_resizeComp(newW, newH, scaleContent) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    newW = Math.round(Number(newW));
    newH = Math.round(Number(newH));
    if (!newW || !newH || newW < 4 || newH < 4 || newW > 30000 || newH > 30000) {
      return toolResult(false, "Enter a valid width and height (4-30000 px).");
    }

    var oldW = comp.width, oldH = comp.height;
    app.beginUndoGroup("Resize Comp");
    comp.width = newW;
    comp.height = newH;

    if (scaleContent) {
      var scaleX = (newW / oldW) * 100;
      var scaleY = (newH / oldH) * 100;
      for (var i = 1; i <= comp.numLayers; i++) {
        var layer = comp.layer(i);
        try {
          var scaleProp = layer.property("Scale");
          if (scaleProp && scaleProp.numKeys === 0) {
            var sv = scaleProp.value;
            scaleProp.setValue(sv.length === 3 ? [sv[0] * scaleX / 100, sv[1] * scaleY / 100, sv[2]] : [sv[0] * scaleX / 100, sv[1] * scaleY / 100]);
          }
          var posProp = layer.property("Position");
          if (posProp && posProp.numKeys === 0) {
            var pv = posProp.value;
            posProp.setValue(pv.length === 3 ? [pv[0] * scaleX / 100, pv[1] * scaleY / 100, pv[2]] : [pv[0] * scaleX / 100, pv[1] * scaleY / 100]);
          }
        } catch (inner) { compxAuditFallback("HOST_AE_RESIZECOMP_001", inner); }
      }
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_RESIZECOMP_002", e2); }
    return toolResult(false, String(e));
  }
}

// IMPORT SRT — creates one text layer per subtitle cue, timed to the cue's
// start/end (in seconds, already parsed panel-side from the .srt file).
function ae_importSRT(dataStr) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    var cues;
    try { cues = JSON.parse(dataStr); } catch (je) { return toolResult(false, "Could not read SRT data."); }
    if (!cues || !cues.length) return toolResult(false, "No subtitle cues found.");

    app.beginUndoGroup("Import SRT");
    var created = 0;
    for (var i = 0; i < cues.length; i++) {
      var cue = cues[i];
      var layer = comp.layers.addText(cue.text || "");
      layer.name = "SRT " + (i + 1);
      var start = Number(cue.start) || 0;
      var end = Number(cue.end);
      if (!(end > start)) end = start + 1;
      layer.inPoint = start;
      layer.outPoint = end;
      created++;
    }
    app.endUndoGroup();
    return toolResult(true, created + " subtitle layer(s) created.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_IMPORTSRT_001", e2); }
    return toolResult(false, String(e));
  }
}

// EXPLODE TEXT PRO — splits the selected (non-expression-driven) text
// layer into one duplicate per character, positioned using the layer's own
// sourceRectAtTime measurements (so it works for proportional fonts, left-
// justified point text), each with a small staggered scale+opacity pop-in.
// The original layer is disabled (not deleted) as a backup.
// Returns { dist, rot } intensity multipliers for a given Text Explode preset.
function ae_explodePresetMultipliers(preset) {
  switch (preset) {
    case "scatter": return { dist: 0.6, rot: 0.5 };
    case "shatter": return { dist: 1.3, rot: 1.6 };
    case "burst": return { dist: 1.5, rot: 0.8 };
    case "popApart": return { dist: 0.8, rot: 1.0 };
    case "random": return { dist: 0.5 + Math.random(), rot: 0.5 + Math.random() };
    case "explodeIn": return { dist: 1.0, rot: 1.0 };
    default: return { dist: 1.0, rot: 1.0 }; // explodeOut
  }
}

// Computes the explosion vector (dx/dy in px, rotation delta in degrees, and
// a scale multiplier) for one exploded piece, based on its position among
// the total pieces and the chosen direction/preset/random toggles.
function ae_explodeVector(idx, total, centerFrac, opts) {
  var mult = ae_explodePresetMultipliers(opts.preset);
  var angle;
  if (opts.direction === "circular") {
    angle = (total > 1 ? (idx / total) : 0) * 360;
  } else if (opts.direction === "spiral") {
    angle = idx * 47;
  } else if (opts.direction === "inward") {
    angle = (centerFrac - 0.5) * 180 + 180;
  } else if (opts.direction === "random") {
    angle = Math.random() * 360;
  } else {
    // outward (default): bias angle away from the text's horizontal center
    angle = (centerFrac - 0.5) * 180;
  }
  if (opts.randomPosition) angle += (Math.random() - 0.5) * 50;

  var rad = angle * Math.PI / 180;
  var mag = opts.distance * mult.dist;
  if (opts.randomPosition) mag *= (0.5 + Math.random() * 0.7);

  var dx = Math.cos(rad) * mag;
  var dy = Math.sin(rad) * mag * 0.6;

  var rotDelta;
  if (opts.randomRotation) {
    rotDelta = (Math.random() * 2 - 1) * opts.rotationDeg * mult.rot;
  } else {
    rotDelta = (idx % 2 === 0 ? 1 : -1) * opts.rotationDeg * mult.rot;
  }

  var scaleMult;
  if (opts.randomScale) {
    scaleMult = 0.4 + Math.random() * 0.9;
  } else {
    scaleMult = 0.6;
  }

  return { dx: dx, dy: dy, rot: rotDelta, scaleMult: scaleMult };
}

// Applies the exploded-piece keyframes (position, rotation, scale, opacity)
// to one duplicated layer. isInType=true animates from the exploded state
// INTO the resting layout position ("Explode In"); otherwise animates OUT
// from the resting position to the exploded state.
function ae_applyExplodeAnim(layer, idx, total, centerFrac, baseTime, delaySec, durationSec, opacityFade, isInType, vec) {
  var startT = baseTime + idx * delaySec;
  var endT = startT + durationSec;

  var posProp = layer.property("Position");
  var basePos = posProp.value;
  var fromPos, toPos;
  if (basePos.length === 3) {
    fromPos = [basePos[0], basePos[1], basePos[2]];
    toPos = [basePos[0] + vec.dx, basePos[1] + vec.dy, basePos[2]];
  } else {
    fromPos = [basePos[0], basePos[1]];
    toPos = [basePos[0] + vec.dx, basePos[1] + vec.dy];
  }

  var rotProp = null;
  try { rotProp = layer.property("Rotation"); } catch (re) { compxAuditFallback("HOST_AE_APPLYEXPLODEANIM_001", re); }
  var baseRot = 0;
  try { baseRot = rotProp ? rotProp.value : 0; } catch (rve) { compxAuditFallback("HOST_AE_APPLYEXPLODEANIM_002", rve); }

  var scaleProp = layer.property("Scale");
  var baseScale = scaleProp.value;
  var scaledTarget = baseScale.length === 3
    ? [baseScale[0] * vec.scaleMult, baseScale[1] * vec.scaleMult, baseScale[2]]
    : [baseScale[0] * vec.scaleMult, baseScale[1] * vec.scaleMult];

  var opProp = layer.property("Opacity");

  if (isInType) {
    posProp.setValueAtTime(startT, toPos);
    posProp.setValueAtTime(endT, fromPos);
    if (rotProp) { rotProp.setValueAtTime(startT, baseRot + vec.rot); rotProp.setValueAtTime(endT, baseRot); }
    scaleProp.setValueAtTime(startT, scaledTarget);
    scaleProp.setValueAtTime(endT, baseScale);
    if (opacityFade) { opProp.setValueAtTime(startT, 0); opProp.setValueAtTime(endT, 100); }
  } else {
    posProp.setValueAtTime(startT, fromPos);
    posProp.setValueAtTime(endT, toPos);
    if (rotProp) { rotProp.setValueAtTime(startT, baseRot); rotProp.setValueAtTime(endT, baseRot + vec.rot); }
    scaleProp.setValueAtTime(startT, baseScale);
    scaleProp.setValueAtTime(endT, scaledTarget);
    if (opacityFade) { opProp.setValueAtTime(startT, 100); opProp.setValueAtTime(endT, 0); }
  }
}

function ae_explodeTextPro(optionsStr) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var srcLayer = null;
    for (var i = 0; i < layers.length; i++) {
      if (layers[i] instanceof TextLayer) { srcLayer = layers[i]; break; }
    }
    if (!srcLayer) return toolResult(false, "Select a text layer.");

    var textProp = srcLayer.property("Source Text");
    if (textProp.expressionEnabled) return toolResult(false, "Can't explode text driven by an expression.");
    var full = String(textProp.value.text);
    if (!full.length) return toolResult(false, "Text layer is empty.");

    var opts;
    try { opts = JSON.parse(optionsStr); } catch (oe) { opts = {}; }
    var mode = (opts && opts.mode) ? String(opts.mode).toLowerCase() : "character";
    var keepOriginal = (opts && opts.keepOriginal === true) ? true : false;
    var autoRename = (opts && opts.autoRename === false) ? false : true;
    var preserveStyle = (opts && opts.preserveStyle !== false) ? true : false;
    var preset = (opts && opts.preset) ? String(opts.preset) : "explodeOut";
    var direction = (opts && opts.direction) ? String(opts.direction) : "random";
    var distancePx = (opts && opts.distance > 0) ? Number(opts.distance) : 300;
    var rotationDeg = (opts && opts.rotationDeg !== undefined) ? Number(opts.rotationDeg) : 180;
    var delaySec = (opts && opts.delay >= 0) ? Number(opts.delay) : 0.05;
    var durationSec = (opts && opts.duration > 0) ? Number(opts.duration) : 1.0;
    var randomPosition = (opts && opts.randomPosition === false) ? false : true;
    var randomRotation = (opts && opts.randomRotation === false) ? false : true;
    var randomScale = (opts && opts.randomScale === false) ? false : true;
    var opacityFade = (opts && opts.opacityFade === false) ? false : true;
    var isInType = (preset === "explodeIn");
    var explodeOpts = {
      preset: preset,
      direction: direction,
      distance: distancePx,
      rotationDeg: rotationDeg,
      randomPosition: randomPosition,
      randomRotation: randomRotation,
      randomScale: randomScale
    };

    app.beginUndoGroup("Explode Text Pro");

    // Measure character widths by truncating text temporarily
    var t = comp.time;
    var offsets = [0];
    for (var c = 1; c <= full.length; c++) {
      var partialDoc = textProp.value;
      partialDoc.text = full.substring(0, c);
      textProp.setValue(partialDoc);
      var rect = srcLayer.sourceRectAtTime(t, false);
      offsets.push(rect.width);
    }
    var restoreDoc = textProp.value;
    restoreDoc.text = full;
    textProp.setValue(restoreDoc);

    // Read text styles for preservation
    var srcDoc = textProp.value;
    var srcFont = srcDoc.font;
    var srcSize = srcDoc.fontSize;
    var srcFill = (srcDoc.fillColor) ? [srcDoc.fillColor[0], srcDoc.fillColor[1], srcDoc.fillColor[2]] : null;
    var srcTracking = srcDoc.tracking;
    var srcLeading = srcDoc.leading;

    var created = 0;

    if (mode === "word") {
      var wordRe = /\S+/g;
      var m;
      var idxW = 0;
      var totalWordsCount = (full.match(/\S+/g) || []).length;
      while ((m = wordRe.exec(full)) !== null) {
        var word = m[0];
        var startIndex = m.index;

        var dupW = srcLayer.duplicate();
        var dupWText = dupW.property("Source Text").value;
        dupWText.text = word;
        if (preserveStyle) {
          dupWText.font = srcFont;
          dupWText.fontSize = srcSize;
          if (srcFill) dupWText.fillColor = srcFill;
          dupWText.tracking = srcTracking;
        }
        dupW.property("Source Text").setValue(dupWText);

        var dxW = offsets[startIndex] || 0;
        var posW = dupW.property("Position");
        if (posW.numKeys === 0) {
          var pvW = posW.value;
          posW.setValue(pvW.length === 3 ? [pvW[0] + dxW, pvW[1], pvW[2]] : [pvW[0] + dxW, pvW[1]]);
        }

        var totalW = totalWordsCount > 0 ? totalWordsCount : 1;
        var centerFracW = totalW > 1 ? idxW / (totalW - 1) : 0.5;
        var vecW = ae_explodeVector(idxW, totalW, centerFracW, explodeOpts);
        ae_applyExplodeAnim(dupW, idxW, totalW, centerFracW, t, delaySec, durationSec, opacityFade, isInType, vecW);

        if (autoRename) dupW.name = "TEXT_" + word + "_" + (idxW < 9 ? "0" + (idxW + 1) : (idxW + 1));
        else dupW.name = srcLayer.name + " Word " + (idxW + 1);

        created++;
        idxW++;
      }
    } else if (mode === "line") {
      var lines = full.split(/\r?\n/);
      var lineY = 0;
      var lineGap = srcLeading > 0 ? srcLeading : srcSize * 1.2;

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (!line) { lineY += lineGap; continue; }

        var dupL = srcLayer.duplicate();
        var dupLText = dupL.property("Source Text").value;
        dupLText.text = line;
        if (preserveStyle) {
          dupLText.font = srcFont;
          dupLText.fontSize = srcSize;
          if (srcFill) dupLText.fillColor = srcFill;
          dupLText.tracking = srcTracking;
        }
        dupL.property("Source Text").setValue(dupLText);

        var posL = dupL.property("Position");
        if (posL.numKeys === 0) {
          var pvL = posL.value;
          posL.setValue(pvL.length === 3 ? [pvL[0], pvL[1] + lineY, pvL[2]] : [pvL[0], pvL[1] + lineY]);
        }

        var totalL = lines.length > 0 ? lines.length : 1;
        var centerFracL = totalL > 1 ? li / (totalL - 1) : 0.5;
        var vecL = ae_explodeVector(li, totalL, centerFracL, explodeOpts);
        ae_applyExplodeAnim(dupL, li, totalL, centerFracL, t, delaySec, durationSec, opacityFade, isInType, vecL);

        if (autoRename) dupL.name = "TEXT_LINE_" + (li < 9 ? "0" + (li + 1) : (li + 1));
        else dupL.name = srcLayer.name + " Line " + (li + 1);

        created++;
        lineY += lineGap;
      }
    } else {
      var totalChars = 0;
      for (var tci = 0; tci < full.length; tci++) { if (full.charAt(tci) !== " ") totalChars++; }
      if (totalChars === 0) totalChars = 1;
      for (var idx = 0; idx < full.length; idx++) {
        var ch = full.charAt(idx);
        if (ch === " ") continue;

        var dup = srcLayer.duplicate();

        var dupText = dup.property("Source Text").value;
        dupText.text = ch;
        if (preserveStyle) {
          dupText.font = srcFont;
          dupText.fontSize = srcSize;
          if (srcFill) dupText.fillColor = srcFill;
          dupText.tracking = srcTracking;
        }
        dup.property("Source Text").setValue(dupText);

        var dx = offsets[idx];
        var posProp = dup.property("Position");
        if (posProp.numKeys === 0) {
          var pv = posProp.value;
          posProp.setValue(pv.length === 3 ? [pv[0] + dx, pv[1], pv[2]] : [pv[0] + dx, pv[1]]);
        }

        var centerFracC = totalChars > 1 ? created / (totalChars - 1) : 0.5;
        var vecC = ae_explodeVector(created, totalChars, centerFracC, explodeOpts);
        ae_applyExplodeAnim(dup, created, totalChars, centerFracC, t, delaySec, durationSec, opacityFade, isInType, vecC);

        if (autoRename) dup.name = "TEXT_" + ch + "_" + (created < 9 ? "0" + (created + 1) : (created + 1));
        else dup.name = srcLayer.name + " \"" + ch + "\" " + (idx + 1);

        created++;
      }
    }

    if (keepOriginal) srcLayer.enabled = false;
    else srcLayer.remove();

    app.endUndoGroup();
    var animMsg = " with " + preset + " animation";
    return toolResult(created > 0, created + " layer(s) created" + animMsg + ".");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_EXPLODETEXTPRO_001", e2); }
    return toolResult(false, String(e));
  }
}

// TRIM BEFORE / AFTER
function ae_trimBefore() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Trim Before");
    var t = comp.time;
    var done = 0;
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (t > L.inPoint && t < L.outPoint) {
        // FIX: save outPoint before setting inPoint.
        // AE can silently shift outPoint when inPoint is changed
        // (source-duration constraint), which makes the right side grow.
        var savedOut = L.outPoint;
        L.inPoint = t;
        if (Math.abs(L.outPoint - savedOut) > 0.0001) L.outPoint = savedOut;
        done++;
      }
    }
    app.endUndoGroup();
    return toolResult(done > 0, done > 0 ? "" : "Playhead is not inside selected layer(s).");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_TRIMBEFORE_001", e2); }
    return toolResult(false, String(e));
  }
}

function ae_trimAfter() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Trim After");
    var t = comp.time;
    var done = 0;
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      if (t > L.inPoint && t < L.outPoint) { L.outPoint = t; done++; }
    }
    app.endUndoGroup();
    return toolResult(done > 0, done > 0 ? "" : "Playhead is not inside selected layer(s).");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_TRIMAFTER_001", e2); }
    return toolResult(false, String(e));
  }
}

// DELETE BEFORE / AFTER (layer-level)
function ae_deleteBeforeLayers(dataStr) {
  try {
    var opts = { scope: "selected", ripple: false };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.scope) opts.scope = String(parsed.scope).toLowerCase();
        if (parsed.ripple !== undefined) opts.ripple = !!parsed.ripple;
      } catch (pe) { compxAuditFallback("HOST_AE_DELETEBEFORELAYERS_001", pe); }
    }

    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    var layers;
    if (opts.scope === "all") {
      layers = [];
      for (var a = 1; a <= comp.numLayers; a++) layers.push(comp.layer(a));
    } else {
      layers = getSelectedLayers(comp);
    }
    if (layers.length === 0) return toolResult(false, opts.scope === "all" ? "Comp is empty." : "No layers selected.");

    var t = comp.time;
    app.beginUndoGroup("Delete Before");
    for (var i = layers.length - 1; i >= 0; i--) {
      var L = layers[i];
      if (L.outPoint <= t) L.remove();
      else if (L.inPoint < t) L.inPoint = t;
    }

    if (opts.ripple) {
      for (var j = 1; j <= comp.numLayers; j++) {
        try {
          var O = comp.layer(j);
          O.startTime -= t;
        } catch (re) { compxAuditFallback("HOST_AE_DELETEBEFORELAYERS_002", re); }
      }
      comp.time = 0;
    }

    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_DELETEBEFORELAYERS_003", e2); }
    return toolResult(false, String(e));
  }
}

function ae_deleteAfterLayers(dataStr) {
  try {
    var opts = { scope: "selected", ripple: false };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.scope) opts.scope = String(parsed.scope).toLowerCase();
        if (parsed.ripple !== undefined) opts.ripple = !!parsed.ripple;
      } catch (pe) { compxAuditFallback("HOST_AE_DELETEAFTERLAYERS_001", pe); }
    }

    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    var layers;
    if (opts.scope === "all") {
      layers = [];
      for (var a = 1; a <= comp.numLayers; a++) layers.push(comp.layer(a));
    } else {
      layers = getSelectedLayers(comp);
    }
    if (layers.length === 0) return toolResult(false, opts.scope === "all" ? "Comp is empty." : "No layers selected.");

    var t = comp.time;
    var compDur = comp.duration;
    app.beginUndoGroup("Delete After");
    for (var i = layers.length - 1; i >= 0; i--) {
      var L = layers[i];
      if (L.inPoint >= t) L.remove();
      else if (L.outPoint > t) L.outPoint = t;
    }

    if (opts.ripple) {
      var gap = compDur - t;
      var newDur = t;
      for (var j = 1; j <= comp.numLayers; j++) {
        try {
          var O = comp.layer(j);
          // Shift layers that started at or after t back by the gap
          if (O.startTime >= t) {
            O.startTime = t;
          }
        } catch (re) { compxAuditFallback("HOST_AE_DELETEAFTERLAYERS_002", re); }
      }
      comp.time = t;
    }

    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_DELETEAFTERLAYERS_003", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// AUTO TRACKER — activity signature for idle/working detection
// ================================================================

// Returns a lightweight JSON snapshot describing "what's different right
// now" in the active comp. The JS side polls this and compares the
// signature string to the previous poll: any change = user activity.
// This is a best-effort heuristic (playhead moves, layer selection
// changes, property edits on the first selected layer's Position,
// project item count, work area) — not perfect, but catches the vast
// majority of real editing activity without needing OS-level hooks.
function ae_getActivitySignature() {
  try {
    var proj = app.project;
    if (!proj) return '{"hasComp":false,"signature":""}';
    var comp = getActiveComp();
    if (!comp) return '{"hasComp":false,"signature":""}';

    var sel = comp.selectedLayers;
    var selIdx = [];
    for (var i = 0; i < sel.length; i++) selIdx.push(sel[i].index);

    var sig = comp.id + "|" +
      comp.time.toFixed(4) + "|" +
      selIdx.join(",") + "|" +
      proj.numItems + "|" +
      comp.numLayers + "|" +
      comp.workAreaStart.toFixed(2) + "|" +
      comp.workAreaDuration.toFixed(2);

    if (sel.length > 0) {
      try {
        var pos = sel[0].property("Position");
        if (pos) sig += "|" + pos.value.join(",");
      } catch (e2) { compxAuditFallback("HOST_AE_GETACTIVITYSIGNATURE_001", e2); }
    }

    return '{"hasComp":true,"signature":"' + escapeJson(sig) + '","compName":"' + escapeJson(comp.name) + '"}';
  } catch (e) {
    return '{"hasComp":false,"signature":"","error":"' + escapeJson(String(e)) + '"}';
  }
}

// ===================== TIMELINE TOOLS (v1.2) =====================

// STAGGER LAYERS — like Sequence Layers but each layer only shifts by a
// fixed offset (frames) from the one above it instead of butting up
// end-to-start, so the layers keep overlapping durations (classic
// "cascade" / staggered-reveal timing).
function ae_staggerLayers(offsetFrames) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length < 2) return toolResult(false, "Select at least 2 layers.");

    var offsetSec = (Number(offsetFrames) || 0) * (1 / comp.frameRate);
    layers.sort(function (a, b) { return a.index - b.index; });

    app.beginUndoGroup("Stagger Layers");
    var base = layers[0].startTime;
    for (var i = 0; i < layers.length; i++) {
      layers[i].startTime = base + offsetSec * i;
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_STAGGERLAYERS_001", e2); }
    return toolResult(false, String(e));
  }
}

// SPLIT AT PLAYHEAD — duplicates each selected layer at the current time,
// trims the original's out point to the playhead and the duplicate's in
// point to the playhead (standard "split layer" behavior, done for
// possibly-multiple selected layers at once).
function ae_splitAtPlayhead() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var t = comp.time;
    app.beginUndoGroup("Split at Playhead");
    var splitCount = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (t <= layer.inPoint || t >= layer.outPoint) continue;
      var dup = layer.duplicate();
      dup.inPoint = t;
      layer.outPoint = t;
      splitCount++;
    }
    app.endUndoGroup();
    if (splitCount === 0) return toolResult(false, "Playhead isn't inside any selected layer.");
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_SPLITATPLAYHEAD_001", e2); }
    return toolResult(false, String(e));
  }
}

// RIPPLE DELETE — removes the selected layers, then shifts every layer
// that started at/after the deleted span's start (and wasn't itself
// selected) earlier by that span's duration, per deleted layer, closing
// the gap it left behind. Layers are processed widest-gap-first so
// overlapping deletions don't double-shift.
function ae_rippleDelete() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var spans = [];
    for (var i = 0; i < layers.length; i++) {
      spans.push({ start: layers[i].inPoint, end: layers[i].outPoint, index: layers[i].index });
    }
    var selectedIndices = {};
    for (var s = 0; s < spans.length; s++) selectedIndices[spans[s].index] = true;

    app.beginUndoGroup("Ripple Delete");
    // Delete selected layers first.
    for (var d = layers.length - 1; d >= 0; d--) {
      layers[d].remove();
    }
    // Shift remaining layers left to close each gap, processed in
    // chronological order of the deleted spans.
    spans.sort(function (a, b) { return a.start - b.start; });
    for (var g = 0; g < spans.length; g++) {
      var span = spans[g];
      var gapDur = span.end - span.start;
      if (gapDur <= 0) continue;
      for (var l = 1; l <= comp.numLayers; l++) {
        var other = comp.layer(l);
        if (selectedIndices[other.index]) continue;
        if (other.startTime + other.inPoint >= span.end - 0.0001) {
          other.startTime -= gapDur;
        }
      }
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_RIPPLEDELETE_001", e2); }
    return toolResult(false, String(e));
  }
}

// ALIGN IN/OUT POINTS — snaps every selected layer's in-point, out-point,
// or both to a target time (comp playhead, or the earliest/latest point
// among the selection).
function ae_alignInOut(mode) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var target;
    if (mode === "in" || mode === "out") {
      target = comp.time;
    }

    app.beginUndoGroup("Align In/Out Points");
    if (mode === "in") {
      for (var i = 0; i < layers.length; i++) layers[i].startTime = target;
    } else if (mode === "out") {
      for (var j = 0; j < layers.length; j++) {
        var layer = layers[j];
        var dur = layer.outPoint - layer.inPoint;
        layer.startTime = target - dur;
      }
    } else if (mode === "matchIn") {
      var earliest = layers[0].inPoint;
      for (var k = 1; k < layers.length; k++) if (layers[k].inPoint < earliest) earliest = layers[k].inPoint;
      for (var m = 0; m < layers.length; m++) layers[m].startTime += (earliest - layers[m].inPoint);
    } else if (mode === "matchOut") {
      var latest = layers[0].outPoint;
      for (var n = 1; n < layers.length; n++) if (layers[n].outPoint > latest) latest = layers[n].outPoint;
      for (var p = 0; p < layers.length; p++) layers[p].startTime += (latest - layers[p].outPoint);
    } else {
      return toolResult(false, "Unknown align mode.");
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_ALIGNINOUT_001", e2); }
    return toolResult(false, String(e));
  }
}

// ===================== LAYER MANAGEMENT (v1.2) =====================

// SOLO TOGGLE — flips .solo on each selected layer.
function ae_toggleSolo() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Toggle Solo");
    for (var i = 0; i < layers.length; i++) layers[i].solo = !layers[i].solo;
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_TOGGLESOLO_001", e2); }
    return toolResult(false, String(e));
  }
}

// SHY TOGGLE — flips .shy on each selected layer.
function ae_toggleShy() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    app.beginUndoGroup("Toggle Shy");
    for (var i = 0; i < layers.length; i++) layers[i].shy = !layers[i].shy;
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_TOGGLESHY_001", e2); }
    return toolResult(false, String(e));
  }
}

// RENAME LAYERS — four modes:
//   "sequential": "<base> 01", "<base> 02", ... in current stack order
//   "prefix": prepends text to each selected layer's existing name
//   "suffix": appends text to each selected layer's existing name
//   "replace": find/replace substring within each selected layer's name
function ae_renameLayers(mode, arg1, arg2) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    layers.sort(function (a, b) { return a.index - b.index; });

    app.beginUndoGroup("Rename Layers");
    if (mode === "sequential") {
      var base = arg1 || "Layer";
      for (var i = 0; i < layers.length; i++) {
        var num = i + 1;
        var numStr = num < 10 ? "0" + num : String(num);
        layers[i].name = base + "_" + numStr;
      }
    } else if (mode === "prefix") {
      for (var p = 0; p < layers.length; p++) layers[p].name = (arg1 || "") + layers[p].name;
    } else if (mode === "suffix") {
      for (var s = 0; s < layers.length; s++) layers[s].name = layers[s].name + (arg1 || "");
    } else if (mode === "replace") {
      var find = arg1 || "";
      var replaceWith = arg2 || "";
      if (find === "") {
        app.endUndoGroup();
        return toolResult(false, "Find text is empty.");
      }
      for (var r = 0; r < layers.length; r++) {
        layers[r].name = layers[r].name.split(find).join(replaceWith);
      }
    } else {
      app.endUndoGroup();
      return toolResult(false, "Unknown rename mode.");
    }
    app.endUndoGroup();
    return toolResult(true);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_RENAMELAYERS_001", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// STUDIO — result helper for calls that return data, not just success/msg
// ================================================================
function dataResult(success, msg, dataJson) {
  var r = "{";
  r += '"success":' + (success ? "true" : "false");
  if (msg) r += ',"message":"' + escapeJson(msg) + '"';
  if (dataJson !== undefined && dataJson !== null) r += ',"data":' + dataJson;
  r += "}";
  return r;
}

// ================================================================
// FFX PRESET LIBRARY (After Effects only — .ffx files aren't a
// Premiere concept). Applies an animation preset file to every
// selected layer via the documented Layer.applyPreset() call.
// ================================================================
function ae_applyPreset(filePath) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var f = new File(filePath);
    if (!f.exists) return toolResult(false, "Preset file not found on disk: " + filePath);

    app.beginUndoGroup("Apply FFX Preset");
    var applied = 0, failed = 0;
    for (var i = 0; i < layers.length; i++) {
      try {
        layers[i].applyPreset(f);
        applied++;
      } catch (le) {
        failed++;
      }
    }
    app.endUndoGroup();

    if (applied === 0) return toolResult(false, "Preset could not be applied to any selected layer (it may not match the layer type).");
    var msg = "Preset applied to " + applied + " layer" + (applied === 1 ? "" : "s") + ".";
    if (failed > 0) msg += " (" + failed + " skipped.)";
    return toolResult(true, msg);
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_APPLYPRESET_001", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// TEXT ANIMATION LIBRARY (After Effects only). Applies a bundled
// .ffx text-animation preset (shipped inside <extension>/presets/
// text-animations/) to every selected layer. Resolves the extension
// root at runtime so the presets travel with the panel install.
// ================================================================
function ae_applyTextAnimPreset(fileName) {
  try {
    var name = String(fileName || "");
    if (!name) return toolResult(false, "No preset specified.");
    var root = compxCopyPasta_getExtensionRoot();
    var path = compxCopyPasta_joinPath(root, "presets", "text-animations", name);
    return ae_applyPreset(path);
  } catch (e) {
    return toolResult(false, String(e));
  }
}

// ================================================================
// WORD-BY-WORD CAPTIONS (After Effects only). Creates one text layer
// per word, all sharing the same on-screen position, each trimmed to
// its own in/out window so only one word is visible at a time — with
// a small pop/fade-in and fade-out so cuts don't feel like hard pops.
// ================================================================
function hexToUnitRgb(hex) {
  hex = String(hex || "#FFFFFF").replace("#", "");
  if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
  var r = parseInt(hex.substring(0, 2), 16) / 255;
  var g = parseInt(hex.substring(2, 4), 16) / 255;
  var b = parseInt(hex.substring(4, 6), 16) / 255;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return [1, 1, 1];
  return [r, g, b];
}

function ae_createWordCaptions(dataStr) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    var data;
    try { data = JSON.parse(dataStr); } catch (je) { return toolResult(false, "Could not read caption data."); }
    if (!data || !data.words || !data.words.length) return toolResult(false, "No words to caption.");

    app.beginUndoGroup("Word-by-Word Captions");

    var fontSize = Number(data.fontSize) || 90;
    var posMode  = data.position || "bottom";
    var style    = data.style || "pop";
    var rgb      = hexToUnitRgb(data.color);

    var px = comp.width / 2;
    var py;
    if (posMode === "top") py = comp.height * 0.18;
    else if (posMode === "center") py = comp.height * 0.5;
    else py = comp.height * 0.82;

    var created = 0;
    for (var i = 0; i < data.words.length; i++) {
      var w = data.words[i];
      var text = String(w.text || "").replace(/^\s+|\s+$/g, "");
      if (!text) continue;

      var start = Number(w.start) || 0;
      var end = Number(w.end);
      if (!(end > start)) end = start + 0.3;

      var layer = comp.layers.addText(text);
      layer.name = "Word " + (i + 1) + ": " + text;

      var textProp = layer.property("Source Text");
      var textDoc = textProp.value;
      textDoc.fontSize = fontSize;
      textDoc.fillColor = rgb;
      try { textDoc.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (pj) { compxAuditFallback("HOST_AE_CREATEWORDCAPTIONS_001", pj); }
      try { textDoc.applyFill = true; } catch (af) { compxAuditFallback("HOST_AE_CREATEWORDCAPTIONS_002", af); }
      textProp.setValue(textDoc);

      try { layer.property("Position").setValue([px, py]); } catch (pe) { compxAuditFallback("HOST_AE_CREATEWORDCAPTIONS_003", pe); }

      layer.inPoint = start;
      layer.outPoint = end;
      layer.startTime = start;

      var dur = end - start;
      var popFrames = Math.min(comp.frameDuration * 4, dur / 3);
      var outFrames  = Math.min(comp.frameDuration * 3, dur / 4);

      var scaleProp   = layer.property("Scale");
      var opacityProp = layer.property("Opacity");

      if (style === "pop") {
        scaleProp.setValueAtTime(start, [70, 70]);
        scaleProp.setValueAtTime(start + popFrames, [100, 100]);
        opacityProp.setValueAtTime(start, 0);
        opacityProp.setValueAtTime(start + popFrames, 100);
      } else if (style === "fade") {
        opacityProp.setValueAtTime(start, 0);
        opacityProp.setValueAtTime(start + popFrames, 100);
      } else {
        opacityProp.setValueAtTime(start, 100);
      }

      if (outFrames > 0 && start + popFrames < end - outFrames) {
        opacityProp.setValueAtTime(end - outFrames, 100);
        opacityProp.setValueAtTime(end, 0);
      }

      created++;
    }

    app.endUndoGroup();
    return toolResult(created > 0, created + " word caption layer(s) created.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_CREATEWORDCAPTIONS_004", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// PREMIERE <-> AFTER EFFECTS BRIDGE
// A CEP panel instance is scoped to a single host app, so PPro and AE
// can't talk to each other directly in memory — the panel JS side
// writes/reads a small shared JSON file on disk instead (see
// STUDIO_BRIDGE in main.js). These functions only gather the current
// selection's underlying file paths on each side, and import a given
// path back in on the receiving side; the disk hand-off itself is
// handled in JS with Node's fs, not here.
// ================================================================
function ae_getBridgeSelection() {
  try {
    var items = [];
    var comp = getActiveComp();
    if (comp) {
      var layers = getSelectedLayers(comp);
      for (var i = 0; i < layers.length; i++) {
        try {
          var lyr = layers[i];
          if (lyr.source && lyr.source.mainSource && lyr.source.mainSource.file) {
            items.push('{"name":"' + escapeJson(lyr.name) + '","path":"' + escapeJson(lyr.source.mainSource.file.fsName) + '"}');
          }
        } catch (le) { compxAuditFallback("HOST_AE_GETBRIDGESELECTION_001", le); }
      }
    }
    if (items.length === 0) {
      try {
        var sel = app.project.selection;
        for (var j = 0; j < sel.length; j++) {
          var it = sel[j];
          if (it.mainSource && it.mainSource.file) {
            items.push('{"name":"' + escapeJson(it.name) + '","path":"' + escapeJson(it.mainSource.file.fsName) + '"}');
          }
        }
      } catch (se) { compxAuditFallback("HOST_AE_GETBRIDGESELECTION_002", se); }
    }
    if (items.length === 0) return dataResult(false, "Select layer(s) with source footage (or footage items in the Project panel) first.");
    return dataResult(true, items.length + " item(s) gathered.", "[" + items.join(",") + "]");
  } catch (e) {
    return dataResult(false, String(e));
  }
}

function ppro_getBridgeSelection() {
  try {
    var items = [];
    var seq = app.project.activeSequence;
    if (seq) {
      var sel = null;
      try { sel = seq.getSelection(); } catch (se) { sel = null; }
      if (sel && sel.length) {
        for (var i = 0; i < sel.length; i++) {
          try {
            var pi = sel[i].projectItem;
            if (pi && pi.getMediaPath && pi.getMediaPath()) {
              items.push('{"name":"' + escapeJson(pi.name) + '","path":"' + escapeJson(pi.getMediaPath()) + '"}');
            }
          } catch (te) { compxAuditFallback("HOST_PPRO_GETBRIDGESELECTION_001", te); }
        }
      }
    }
    if (items.length === 0) {
      return dataResult(false, "Select clip(s) on the Timeline first (Sequence.getSelection() is what this reads — Project panel selection isn't exposed the same way in the scripting API).");
    }
    return dataResult(true, items.length + " item(s) gathered.", "[" + items.join(",") + "]");
  } catch (e) {
    return dataResult(false, String(e));
  }
}

function getBridgeSelection() {
  if (isAfterEffects()) return ae_getBridgeSelection();
  if (isPremiere())     return ppro_getBridgeSelection();
  return dataResult(false, "Could not detect host application.");
}

function importBridgeAsset(filePath) {
  try {
    var f = new File(filePath);
    if (!f.exists) return toolResult(false, "File no longer exists on disk: " + filePath);

    if (isAfterEffects()) {
      app.beginUndoGroup("Import from Bridge");
      var io = new ImportOptions(f);
      app.project.importFile(io);
      app.endUndoGroup();
      return toolResult(true, "Imported into the After Effects project panel.");
    }
    if (isPremiere()) {
      try {
        app.project.importFiles([filePath], true, app.project.rootItem, false);
      } catch (ie) { /* importFiles throws if already imported — fine */ }
      return toolResult(true, "Imported into the Premiere Pro project panel.");
    }
    return toolResult(false, "Could not detect host application.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_IMPORTBRIDGEASSET_001", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// PROJECT ASSET MANAGER / SEARCH
// Recursively lists every item in the host's project panel (AE's
// project tree of folders/footage/comps, or Premiere's bin tree of
// bins/clips/sequences) as flat JSON. The panel JS side does the
// searching/filtering and checks each path with Node's fs for
// missing/offline media, rather than duplicating that here.
// ================================================================
function ae_listProjectAssets() {
  try {
    var proj = app.project;
    if (!proj) return dataResult(false, "No open project.");
    var out = [];

    function walk(folder, folderPath) {
      var n = folder.numItems;
      for (var i = 1; i <= n; i++) {
        var it = folder.item(i);
        if (it instanceof FolderItem) {
          walk(it, folderPath ? folderPath + "/" + it.name : it.name);
        } else {
          var type = (it instanceof CompItem) ? "comp" : (it instanceof FootageItem ? "footage" : "item");
          var p = "";
          try { if (it.mainSource && it.mainSource.file) p = it.mainSource.file.fsName; } catch (fe) { compxAuditFallback("HOST_WALK_001", fe); }
          out.push('{"name":"' + escapeJson(it.name) + '","type":"' + type + '","path":"' + escapeJson(p) +
            '","folder":"' + escapeJson(folderPath || "") + '"}');
        }
      }
    }
    walk(proj.rootFolder, "");
    return dataResult(true, out.length + " item(s).", "[" + out.join(",") + "]");
  } catch (e) {
    return dataResult(false, String(e));
  }
}

function ppro_listProjectAssets() {
  try {
    if (!app.project) return dataResult(false, "No open project.");
    var out = [];

    function walk(bin, folderPath) {
      var n = bin.children.numItems;
      for (var i = 0; i < n; i++) {
        var it = bin.children[i];
        try {
          if (it.type === ProjectItemType.BIN) {
            walk(it, folderPath ? folderPath + "/" + it.name : it.name);
          } else {
            var p = "";
            try { p = it.getMediaPath ? it.getMediaPath() : ""; } catch (ge) { compxAuditFallback("HOST_WALK_002", ge); }
            var type = (it.type === ProjectItemType.SEQUENCE) ? "sequence" : "clip";
            out.push('{"name":"' + escapeJson(it.name) + '","type":"' + type + '","path":"' + escapeJson(p || "") +
              '","folder":"' + escapeJson(folderPath || "") + '"}');
          }
        } catch (ie) { compxAuditFallback("HOST_WALK_003", ie); }
      }
    }
    walk(app.project.rootItem, "");
    return dataResult(true, out.length + " item(s).", "[" + out.join(",") + "]");
  } catch (e) {
    return dataResult(false, String(e));
  }
}

function listProjectAssets() {
  if (isAfterEffects()) return ae_listProjectAssets();
  if (isPremiere())     return ppro_listProjectAssets();
  return dataResult(false, "Could not detect host application.");
}

// ================================================================
// SORT LAYERS — reorders selected (or all) layers in the comp
// mode: "nameAZ" | "nameZA" | "type" | "inPoint" | "outPoint"
// ================================================================
function ae_sortLayers(mode) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length < 2) {
      // Sort all layers if none selected
      layers = [];
      for (var a = 1; a <= comp.numLayers; a++) layers.push(comp.layer(a));
    }
    if (layers.length < 2) return toolResult(false, "Need at least 2 layers to sort.");

    function layerTypeOrder(L) {
      try { if (L instanceof CameraLayer)   return 0; } catch (e) { compxAuditFallback("HOST_LAYERTYPEORDER_001", e); }
      try { if (L instanceof LightLayer)    return 1; } catch (e) { compxAuditFallback("HOST_LAYERTYPEORDER_002", e); }
      try { if (L.nullLayer)               return 2; } catch (e) { compxAuditFallback("HOST_LAYERTYPEORDER_003", e); }
      try { if (L instanceof AVLayer && L.adjustmentLayer) return 3; } catch (e) { compxAuditFallback("HOST_LAYERTYPEORDER_004", e); }
      try { if (L instanceof TextLayer)    return 4; } catch (e) { compxAuditFallback("HOST_LAYERTYPEORDER_005", e); }
      try { if (L instanceof ShapeLayer)   return 5; } catch (e) { compxAuditFallback("HOST_LAYERTYPEORDER_006", e); }
      try { if (L instanceof AVLayer && L.source instanceof CompItem) return 6; } catch (e) { compxAuditFallback("HOST_LAYERTYPEORDER_007", e); }
      return 7; // footage
    }

    layers.sort(function(a, b) {
      var m = String(mode || "nameAZ").toLowerCase();
      if (m === "nameaz")   return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
      if (m === "nameza")   return String(a.name).toLowerCase() > String(b.name).toLowerCase() ? -1 : 1;
      if (m === "type")     return layerTypeOrder(a) - layerTypeOrder(b);
      if (m === "inpoint")  return a.inPoint - b.inPoint;
      if (m === "outpoint") return a.outPoint - b.outPoint;
      return 0;
    });

    app.beginUndoGroup("Sort Layers");
    // Move sorted layers to top one-by-one — they'll stack in sorted order
    for (var i = layers.length - 1; i >= 0; i--) {
      layers[i].moveToBeginning();
    }
    app.endUndoGroup();
    return toolResult(true, layers.length + " layers sorted by " + mode + ".");
  } catch(e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_LAYERTYPEORDER_008", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// AUTO ORGANIZE — groups layers by type using parent nulls
// Creates CONTROLS / TEXT / GRAPHICS / EFFECTS / AUDIO groups
// ================================================================
function ae_autoOrganize() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");

    app.beginUndoGroup("Auto Organize");

    var groups = {
      CONTROLS: [],  // Camera + Null
      TEXT:     [],  // TextLayer
      GRAPHICS: [],  // ShapeLayer + precomp
      EFFECTS:  [],  // Adjustment layer
      AUDIO:    [],  // audio-only footage
      FOOTAGE:  []   // everything else
    };

    // Collect all layers
    var allLayers = [];
    for (var i = 1; i <= comp.numLayers; i++) allLayers.push(comp.layer(i));

    for (var j = 0; j < allLayers.length; j++) {
      var L = allLayers[j];
      if (L.parent) continue; // already parented — skip
      var isCamera = false, isNull = false, isAdj = false, isText = false, isShape = false, isPrecomp = false, isAudio = false;
      try { isCamera = (L instanceof CameraLayer); } catch (e) { compxAuditFallback("HOST_AE_AUTOORGANIZE_001", e); }
      try { isNull = L.nullLayer; } catch (e) { compxAuditFallback("HOST_AE_AUTOORGANIZE_002", e); }
      try { if (L instanceof AVLayer) { isAdj = L.adjustmentLayer; } } catch (e) { compxAuditFallback("HOST_AE_AUTOORGANIZE_003", e); }
      try { isText = (L instanceof TextLayer); } catch (e) { compxAuditFallback("HOST_AE_AUTOORGANIZE_004", e); }
      try { isShape = (L instanceof ShapeLayer); } catch (e) { compxAuditFallback("HOST_AE_AUTOORGANIZE_005", e); }
      try { isPrecomp = (L instanceof AVLayer) && (L.source instanceof CompItem); } catch (e) { compxAuditFallback("HOST_AE_AUTOORGANIZE_006", e); }
      try {
        if (L instanceof AVLayer && L.source && L.source.mainSource) {
          isAudio = (L.source.mainSource.isStill === false) && L.audioEnabled && !L.videoActive;
        }
      } catch (e) { compxAuditFallback("HOST_AE_AUTOORGANIZE_007", e); }

      if (isCamera || isNull) groups.CONTROLS.push(L);
      else if (isText)        groups.TEXT.push(L);
      else if (isShape || isPrecomp) groups.GRAPHICS.push(L);
      else if (isAdj)         groups.EFFECTS.push(L);
      else if (isAudio)       groups.AUDIO.push(L);
      else                    groups.FOOTAGE.push(L);
    }

    var groupNames = ["CONTROLS", "TEXT", "GRAPHICS", "EFFECTS", "AUDIO", "FOOTAGE"];
    var created = 0;
    for (var g = 0; g < groupNames.length; g++) {
      var gName = groupNames[g];
      var gLayers = groups[gName];
      if (!gLayers || gLayers.length === 0) continue;
      // Create a null as parent "folder" label
      var nullL = comp.layers.addNull();
      nullL.name = "[" + gName + "]";
      nullL.enabled = false;
      nullL.shy = true;
      // Move to just above the first layer in group
      try { nullL.moveBefore(gLayers[0]); } catch (e) { compxAuditFallback("HOST_AE_AUTOORGANIZE_008", e); }
      for (var k = 0; k < gLayers.length; k++) {
        try { gLayers[k].parent = nullL; } catch (pe) { compxAuditFallback("HOST_AE_AUTOORGANIZE_009", pe); }
      }
      created++;
    }

    app.endUndoGroup();
    return toolResult(true, created + " group(s) created. Layers grouped by type.");
  } catch(e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_AUTOORGANIZE_010", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// COLOR LABEL LAYERS — assigns AE color labels by layer type
// 0=None 1=Red 2=Yellow 3=Aqua 4=Pink 5=Lavender 6=Peach
// 7=Sea Foam 8=Blue 9=Green 10=Purple 11=Orange 12=Brown
// ================================================================
function ae_colorCodeByType() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) {
      layers = [];
      for (var a = 1; a <= comp.numLayers; a++) layers.push(comp.layer(a));
    }

    app.beginUndoGroup("Color Code Layers");
    var done = 0;
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var lbl = 0;
      try { if (L instanceof CameraLayer) lbl = 8; } catch (e) { compxAuditFallback("HOST_AE_COLORCODEBYTYPE_001", e); } // Blue = Camera
      try { if (L.nullLayer)             lbl = 3; } catch (e) { compxAuditFallback("HOST_AE_COLORCODEBYTYPE_002", e); } // Aqua = Null
      try { if (L instanceof TextLayer)  lbl = 2; } catch (e) { compxAuditFallback("HOST_AE_COLORCODEBYTYPE_003", e); } // Yellow = Text
      try { if (L instanceof ShapeLayer) lbl = 9; } catch (e) { compxAuditFallback("HOST_AE_COLORCODEBYTYPE_004", e); } // Green = Shape
      try { if (L instanceof AVLayer && L.adjustmentLayer) lbl = 10; } catch (e) { compxAuditFallback("HOST_AE_COLORCODEBYTYPE_005", e); } // Purple = Adj
      try { if (L instanceof AVLayer && L.source instanceof CompItem) lbl = 11; } catch (e) { compxAuditFallback("HOST_AE_COLORCODEBYTYPE_006", e); } // Orange = Precomp
      L.label = lbl;
      done++;
    }
    app.endUndoGroup();
    return toolResult(true, done + " layer(s) color coded.");
  } catch(e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_COLORCODEBYTYPE_007", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// APPLY GRADIENT PLATE (enhanced) — applies ADBE Ramp to selected
// layers with named preset colors. presetName → color pair.
// ================================================================
function ae_applyGradientPlate(dataStr) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return toolResult(false, "No layers selected.");

    var data;
    try { data = JSON.parse(dataStr); } catch(e0) { data = { preset: dataStr }; }

    // Named presets
    var presets = {
      sunset:    { c1: [1.0, 0.25, 0.11], c2: [1.0, 0.65, 0.0]  },
      ocean:     { c1: [0.0, 0.18, 0.55], c2: [0.0, 0.75, 0.85] },
      neon:      { c1: [0.55, 0.0, 1.0],  c2: [1.0, 0.0, 0.65]  },
      cinematic: { c1: [1.0, 0.4, 0.0],   c2: [0.0, 0.45, 0.6]  },
      cyberpunk: { c1: [1.0, 0.0, 0.55],  c2: [0.0, 1.0, 1.0]   },
      gold:      { c1: [1.0, 0.75, 0.0],  c2: [0.9, 0.45, 0.0]  },
      // New direct types
      "2color-linear": null,  // uses custom c1/c2
      "2color-radial": null,
      "4color":         null
    };

    var preset = String(data.preset || data || "").toLowerCase();
    var pData  = presets[preset];
    var rampType = (preset.indexOf("radial") !== -1) ? 2 : 1; // 1=linear, 2=radial
    if (data.rampType) rampType = Number(data.rampType);

    // Parse custom colors if provided
    var c1 = pData ? pData.c1 : hexToUnitRgb(String(data.c1 || "#ff416c"));
    var c2 = pData ? pData.c2 : hexToUnitRgb(String(data.c2 || "#ff4b2b"));
    var c3 = data.c3 ? hexToUnitRgb(String(data.c3)) : null;
    var c4 = data.c4 ? hexToUnitRgb(String(data.c4)) : null;
    var angle = Number(data.angle || 0);

    app.beginUndoGroup("Apply Gradient");
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var fx = layer.property("ADBE Effect Parade");
      if (!fx) continue;

      // Remove any existing Gradient Ramp effect first to prevent duplicates
      try {
        for (var ri = fx.numProperties; ri >= 1; ri--) {
          var ep = fx.property(ri);
          if (ep && ep.matchName === "ADBE Ramp") { ep.remove(); }
        }
      } catch (re) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_001", re); }

      // ADBE Ramp correct property order (AE internal):
      // ADBE Ramp-0001 = Start of Ramp (position)
      // ADBE Ramp-0002 = Start Color
      // ADBE Ramp-0003 = End of Ramp (position)
      // ADBE Ramp-0004 = End Color
      // ADBE Ramp-0005 = Ramp Shape (1=Linear, 2=Radial)
      var ramp = null;
      try { ramp = fx.addProperty("ADBE Ramp"); } catch (ae) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_002", ae); }
      if (!ramp) continue;

      var w = comp.width, h = comp.height;
      var rad = angle * Math.PI / 180;
      var cx = w / 2, cy = h / 2;
      var dx = Math.cos(rad) * h / 2;
      var dy = Math.sin(rad) * h / 2;

      try { ramp.property("ADBE Ramp-0001").setValue([cx - dx, cy - dy]); } catch (e) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_003", e); } // Start of Ramp (position)
      try { ramp.property("ADBE Ramp-0002").setValue(c1); } catch (e) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_004", e); }                  // Start Color
      try { ramp.property("ADBE Ramp-0003").setValue([cx + dx, cy + dy]); } catch (e) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_005", e); } // End of Ramp (position)
      try { ramp.property("ADBE Ramp-0004").setValue(c2); } catch (e) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_006", e); }                  // End Color
      try { ramp.property("ADBE Ramp-0005").setValue(rampType); } catch (e) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_007", e); }            // Ramp Shape

      // 4-color: add second ramp for c3→c4 perpendicular blend
      if (c3 && c4) {
        try {
          var ramp2 = fx.addProperty("ADBE Ramp");
          var perpRad = rad + Math.PI / 2;
          var dx2 = Math.cos(perpRad) * w / 2;
          var dy2 = Math.sin(perpRad) * w / 2;
          ramp2.property("ADBE Ramp-0001").setValue([cx - dx2, cy - dy2]); // Start of Ramp
          ramp2.property("ADBE Ramp-0002").setValue(c3);                   // Start Color
          ramp2.property("ADBE Ramp-0003").setValue([cx + dx2, cy + dy2]); // End of Ramp
          ramp2.property("ADBE Ramp-0004").setValue(c4);                   // End Color
          ramp2.property("ADBE Ramp-0005").setValue(rampType);             // Ramp Shape
        } catch (e) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_008", e); }
      }

      applied++;
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied + " layer(s) got gradient applied.");
  } catch(e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_APPLYGRADIENTPLATE_009", e2); }
    return toolResult(false, String(e));
  }
}

// ================================================================
// MEMORY PURGE (enhanced) — mode: ram | disk | all | image
// ================================================================
function ae_memoryPurge(mode) {
  try {
    var m = String(mode || "all").toLowerCase();
    app.beginUndoGroup("Memory Purge");
    if (m === "ram" || m === "all") {
      try { app.purge(PurgeTarget.ALL_CACHES); } catch (e) { compxAuditFallback("HOST_AE_MEMORYPURGE_001", e); }
    }
    if (m === "disk" || m === "all") {
      try { app.purge(PurgeTarget.DISK_CACHE); } catch (e) { compxAuditFallback("HOST_AE_MEMORYPURGE_002", e); }
    }
    if (m === "image" || m === "all") {
      try { app.purge(PurgeTarget.IMAGE_CACHES); } catch (e) { compxAuditFallback("HOST_AE_MEMORYPURGE_003", e); }
    }
    if (m === "undo") {
      try { app.purge(PurgeTarget.UNDO); } catch (e) { compxAuditFallback("HOST_AE_MEMORYPURGE_004", e); }
    }
    app.endUndoGroup();
    return toolResult(true, "Memory purged (" + mode + ").");
  } catch(e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_MEMORYPURGE_005", e2); }
    return toolResult(false, String(e));
  }
}

// TEXT ANIMATOR SUITE — native AE text animator/range selector entrance presets.
function ae_applyTextAnimator(style) {
  return ae_applyTextAnimStyle(style);
}

// LOOP EXPRESSION TOOLBOX — applies safe expressions to selected timeline properties.
function ae_applyLoopExpression(mode) {
  try { var comp=getActiveComp(); if(!comp)return toolResult(false,"No active composition."); var ls=getSelectedLayers(comp); if(!ls.length)return toolResult(false,"Select a layer and a Timeline property."); var m=String(mode||"loop"), expr=m==="pingpong"?"loopOut(\"pingpong\")":m==="wiggle"?"wiggle(3,20)":"loopOut(\"cycle\")",n=0; app.beginUndoGroup("Expression Toolbox"); for(var i=0;i<ls.length;i++){var ps=ls[i].selectedProperties;for(var j=0;j<ps.length;j++){try{if(ps[j].canSetExpression){ps[j].expression=expr;ps[j].expressionEnabled=true;n++;}}catch (e) { compxAuditFallback("HOST_AE_APPLYLOOPEXPRESSION_001", e); }}} app.endUndoGroup(); return toolResult(n>0,n>0?"Applied "+m+" expression to "+n+" propert(y/ies).":"Select an animatable Timeline property first."); }catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_APPLYLOOPEXPRESSION_002", e2); }return toolResult(false,String(e));}
}

// SMART TRANSITION BUILDER — editable transition between the top two selected layers.
function ae_buildSmartTransition(style){
  try{
    var c=getActiveComp(); if(!c)return toolResult(false,"No active composition.");
    var a=getSelectedLayers(c); if(a.length<2)return toolResult(false,"Select two layers.");
    var out=a[0],inn=a[1],t=Math.max(out.inPoint,inn.inPoint,c.time),d=12*c.frameDuration,e=t+d;
    var so=out.property("ADBE Transform Group"),si=inn.property("ADBE Transform Group");
    if(!so||!si)return toolResult(false,"Select two transformable layers.");
    var oo=so.property("ADBE Opacity"),oi=si.property("ADBE Opacity");
    app.beginUndoGroup("Smart Transition");
    oo.setValueAtTime(t,100); oo.setValueAtTime(e,0); oi.setValueAtTime(t,0); oi.setValueAtTime(e,100);
    if(style==="push"){
      var po=so.property("ADBE Position"),pi=si.property("ADBE Position"),vo=po.value,vi=pi.value;
      var voEnd=vo.length===3?[vo[0]-c.width*.18,vo[1],vo[2]]:[vo[0]-c.width*.18,vo[1]];
      var viStart=vi.length===3?[vi[0]+c.width*.18,vi[1],vi[2]]:[vi[0]+c.width*.18,vi[1]];
      po.setValueAtTime(t,vo); po.setValueAtTime(e,voEnd); pi.setValueAtTime(t,viStart); pi.setValueAtTime(e,vi);
    }
    if(style==="zoom"){
      var xo=so.property("ADBE Scale"),xi=si.property("ADBE Scale"),vo2=xo.value,vi2=xi.value;
      var voEnd2=vo2.length===3?[vo2[0]*1.12,vo2[1]*1.12,vo2[2]]:[vo2[0]*1.12,vo2[1]*1.12];
      var viStart2=vi2.length===3?[vi2[0]*.88,vi2[1]*.88,vi2[2]]:[vi2[0]*.88,vi2[1]*.88];
      xo.setValueAtTime(t,vo2); xo.setValueAtTime(e,voEnd2); xi.setValueAtTime(t,viStart2); xi.setValueAtTime(e,vi2);
    }
    app.endUndoGroup(); return toolResult(true,"Applied "+style+" transition.");
  }catch(e){try{app.endUndoGroup();}catch (x) { compxAuditFallback("HOST_AE_BUILDSMARTTRANSITION_001", x); }return toolResult(false,String(e));}
}
function ae_quickLayout(m){
  try{
    var c=getActiveComp(); if(!c)return toolResult(false,"No active composition.");
    var a=getSelectedLayers(c); if(!a.length)return toolResult(false,"Select visual layer(s).");
    app.beginUndoGroup("Quick Layout"); var done=0,skipped=0;
    for(var i=0;i<a.length;i++){
      var tr=a[i].property("ADBE Transform Group"); if(!tr){skipped++;continue;}
      var pos=tr.property("ADBE Position"),scale=tr.property("ADBE Scale");
      if(m!=="fit"&&pos){var pv=pos.value;pos.setValue(pv.length===3?[c.width/2,c.height/2,pv[2]]:[c.width/2,c.height/2]);}
      if(m!=="center"){
        if(!scale||typeof a[i].sourceRectAtTime!=="function"){skipped++;continue;}
        var rect=a[i].sourceRectAtTime(c.time,false); if(!rect||rect.width<=0||rect.height<=0){skipped++;continue;}
        var q=Math.min(c.width/rect.width,c.height/rect.height)*100,sv=scale.value;
        scale.setValue(sv.length===3?[q,q,sv[2]]:[q,q]);
      }
      done++;
    }
    app.endUndoGroup();
    return toolResult(done>0,done>0?"Layout applied to "+done+" layer(s).":"No compatible visual layers selected.");
  }catch(e){try{app.endUndoGroup();}catch (x) { compxAuditFallback("HOST_AE_QUICKLAYOUT_001", x); }return toolResult(false,String(e));}
}

// ================================================================
// SHAPE TOOLKIT (After Effects only) — adds shape-layer operators,
// line-style presets, and one-click motion presets to the selected
// Shape Layer(s). All operations run inside a single undo group.
// ================================================================
function ae_getShapeLayers(comp) {
  var out = [];
  var sel = comp.selectedLayers;
  for (var i = 0; i < sel.length; i++) {
    try { if (sel[i].property("ADBE Root Vectors Group")) out.push(sel[i]); } catch (e) { compxAuditFallback("HOST_AE_GETSHAPELAYERS_001", e); }
  }
  return out;
}

function ae_shapeFindStroke(contents) {
  for (var i = 1; i <= contents.numProperties; i++) {
    var p = contents.property(i);
    try {
      if (p.matchName === "ADBE Vector Graphic - Stroke") return p;
      if (p.matchName === "ADBE Vector Group") {
        var g = p.property("ADBE Vectors Group");
        if (g) {
          for (var j = 1; j <= g.numProperties; j++) {
            if (g.property(j).matchName === "ADBE Vector Graphic - Stroke") return g.property(j);
          }
        }
      }
    } catch (e) { compxAuditFallback("HOST_AE_SHAPEFINDSTROKE_001", e); }
  }
  return null;
}

function ae_shapeGetStroke(layer) {
  var contents = layer.property("ADBE Root Vectors Group");
  var s = ae_shapeFindStroke(contents);
  if (s) return s;
  return contents.addProperty("ADBE Vector Graphic - Stroke");
}

function ae_shapeRoundCap(stroke) {
  try { stroke.property("ADBE Vector Stroke Line Cap").setValue(2); } catch (e) { compxAuditFallback("HOST_AE_SHAPEROUNDCAP_001", e); }
}

function ae_shapeAddDash(stroke, dashLen, gapLen) {
  var dg = stroke.property("ADBE Vector Stroke Dashes");
  var dash = dg.addProperty("ADBE Vector Stroke Dash 1");
  try { if (dashLen !== undefined) dash.setValue(dashLen); } catch (e) { compxAuditFallback("HOST_AE_SHAPEADDDASH_001", e); }
  return dg;
}

function ae_shapeEasyEase(prop) {
  try {
    for (var k = 1; k <= prop.numKeys; k++) {
      prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    }
    prop.setTemporalEaseAtKey(1, [new KeyframeEase(0, 50)], [new KeyframeEase(0, 50)]);
    prop.setTemporalEaseAtKey(prop.numKeys, [new KeyframeEase(0, 50)], [new KeyframeEase(0, 50)]);
  } catch (e) { compxAuditFallback("HOST_AE_SHAPEEASYEASE_001", e); }
}

function ae_shapeTrimAnim(contents, mode, comp) {
  // mode: "draw" (end 0->100), "erase" (start 0->100)
  var trim = contents.addProperty("ADBE Vector Filter - Trim");
  var t0 = comp.time;
  var dur = Math.min(1.0, comp.duration);
  var prop = (mode === "erase")
    ? trim.property("ADBE Vector Trim Start")
    : trim.property("ADBE Vector Trim End");
  if (mode !== "erase") { try { trim.property("ADBE Vector Trim End").setValue(0); } catch (e) { compxAuditFallback("HOST_AE_SHAPETRIMANIM_001", e); } }
  prop.setValueAtTime(t0, 0);
  prop.setValueAtTime(t0 + dur, 100);
  ae_shapeEasyEase(prop);
  return trim;
}

function ae_shapeOp(op) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = ae_getShapeLayers(comp);
    if (!layers.length) return toolResult(false, "Select one or more Shape Layers.");

    var contentMap = {
      trim: "ADBE Vector Filter - Trim",
      offset: "ADBE Vector Filter - Offset",
      repeater: "ADBE Vector Filter - Repeater",
      zigzag: "ADBE Vector Filter - Zigzag",
      twist: "ADBE Vector Filter - Twist",
      round: "ADBE Vector Filter - RC",
      wigglePaths: "ADBE Vector Filter - Roughen",
      wiggleTransform: "ADBE Vector Filter - Wiggler",
      pucker: "ADBE Vector Filter - PB",
      merge: "ADBE Vector Filter - Merge",
      fill: "ADBE Vector Graphic - Fill",
      stroke: "ADBE Vector Graphic - Stroke"
    };

    app.beginUndoGroup("Shape: Add " + op);
    var count = 0;
    var warn = "";
    for (var i = 0; i < layers.length; i++) {
      var contents = layers[i].property("ADBE Root Vectors Group");
      try {
        if (op === "dashes") {
          ae_shapeAddDash(ae_shapeGetStroke(layers[i]), 12); count++;
        } else if (op === "taper") {
          var stk = ae_shapeGetStroke(layers[i]);
          var taper = null;
          try { taper = stk.property("ADBE Vector Stroke Taper"); } catch (te) { compxAuditFallback("HOST_AE_SHAPEOP_001", te); }
          if (taper) {
            try { taper.property("ADBE Vector Taper End Length").setValue(100); } catch (e1) { compxAuditFallback("HOST_AE_SHAPEOP_002", e1); }
            try { taper.property("ADBE Vector Taper Start Length").setValue(0); } catch (e2) { compxAuditFallback("HOST_AE_SHAPEOP_003", e2); }
            count++;
          } else { warn = "Taper needs After Effects 2020 or newer."; }
        } else if (contentMap[op]) {
          contents.addProperty(contentMap[op]); count++;
        }
      } catch (le) { compxAuditFallback("HOST_AE_SHAPEOP_004", le); }
    }
    app.endUndoGroup();
    if (!count) return toolResult(false, warn || "Could not add to the selected layer(s).");
    return toolResult(true, "Added to " + count + " layer(s).");
  } catch (e) {
    return toolResult(false, String(e));
  }
}

function ae_applyShapePreset(preset, layer, contents, comp) {
  var stroke;
  if (preset === "lightning") {
    stroke = ae_shapeGetStroke(layer);
    try { stroke.property("ADBE Vector Stroke Width").setValue(6); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_001", e); }
    ae_shapeTrimAnim(contents, "draw", comp);
    try { var tp = stroke.property("ADBE Vector Stroke Taper"); if (tp) tp.property("ADBE Vector Taper End Length").setValue(100); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_002", e); }
    ae_shapeAddDash(stroke, 8, 8);
  } else if (preset === "social") {
    stroke = ae_shapeGetStroke(layer);
    ae_shapeRoundCap(stroke);
    try { stroke.property("ADBE Vector Stroke Width").setValue(10); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_003", e); }
    ae_shapeTrimAnim(contents, "draw", comp);
    try { var tp2 = stroke.property("ADBE Vector Stroke Taper"); if (tp2) tp2.property("ADBE Vector Taper Start Length").setValue(20); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_004", e); }
  } else if (preset === "arrow") {
    stroke = ae_shapeGetStroke(layer);
    ae_shapeRoundCap(stroke);
    ae_shapeTrimAnim(contents, "draw", comp);
    try { var tp3 = stroke.property("ADBE Vector Stroke Taper"); if (tp3) { tp3.property("ADBE Vector Taper End Length").setValue(100); tp3.property("ADBE Vector Taper End Width").setValue(0); } } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_005", e); }
  } else if (preset === "signature") {
    stroke = ae_shapeGetStroke(layer);
    ae_shapeRoundCap(stroke);
    try { stroke.property("ADBE Vector Stroke Width").setValue(5); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_006", e); }
    ae_shapeTrimAnim(contents, "draw", comp);
  } else if (preset === "road") {
    stroke = ae_shapeGetStroke(layer);
    try { stroke.property("ADBE Vector Stroke Width").setValue(14); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_007", e); }
    var dg = ae_shapeAddDash(stroke, 30, 20);
    try { dg.property("ADBE Vector Stroke Offset").expression = "time * 200;"; } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_008", e); }
  } else if (preset === "drawLine" || preset === "write") {
    ae_shapeGetStroke(layer);
    ae_shapeTrimAnim(contents, "draw", comp);
  } else if (preset === "eraseLine") {
    ae_shapeGetStroke(layer);
    ae_shapeTrimAnim(contents, "erase", comp);
  } else if (preset === "loadingCircle") {
    ae_shapeGetStroke(layer);
    var trimC = contents.addProperty("ADBE Vector Filter - Trim");
    try { trimC.property("ADBE Vector Trim Start").setValue(0); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_009", e); }
    try { trimC.property("ADBE Vector Trim End").setValue(25); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_010", e); }
    try { trimC.property("ADBE Vector Trim Offset").expression = "time * 360;"; } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_011", e); }
  } else if (preset === "spinner") {
    ae_shapeGetStroke(layer);
    var trimS = contents.addProperty("ADBE Vector Filter - Trim");
    try { trimS.property("ADBE Vector Trim End").setValue(30); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_012", e); }
    try { layer.property("ADBE Transform Group").property("ADBE Rotate Z").expression = "time * 360;"; } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_013", e); }
  } else if (preset === "loadingBar") {
    ae_shapeGetStroke(layer);
    var trimB = contents.addProperty("ADBE Vector Filter - Trim");
    var endB = trimB.property("ADBE Vector Trim End");
    try { endB.setValue(0); } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_014", e); }
    endB.setValueAtTime(comp.time, 0);
    endB.setValueAtTime(comp.time + Math.min(1.5, comp.duration), 100);
    try { endB.expression = "loopOut('cycle');"; } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_015", e); }
  } else if (preset === "arrowDraw") {
    stroke = ae_shapeGetStroke(layer);
    ae_shapeRoundCap(stroke);
    try { var tp4 = stroke.property("ADBE Vector Stroke Taper"); if (tp4) { tp4.property("ADBE Vector Taper End Length").setValue(100); tp4.property("ADBE Vector Taper End Width").setValue(0); } } catch (e) { compxAuditFallback("HOST_AE_APPLYSHAPEPRESET_016", e); }
    ae_shapeTrimAnim(contents, "draw", comp);
  }
}

function ae_shapePreset(preset) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = ae_getShapeLayers(comp);
    if (!layers.length) return toolResult(false, "Select one or more Shape Layers.");

    app.beginUndoGroup("Shape Preset: " + preset);
    var count = 0;
    for (var i = 0; i < layers.length; i++) {
      try {
        ae_applyShapePreset(preset, layers[i], layers[i].property("ADBE Root Vectors Group"), comp);
        count++;
      } catch (le) { compxAuditFallback("HOST_AE_SHAPEPRESET_001", le); }
    }
    app.endUndoGroup();
    if (!count) return toolResult(false, "Could not apply to the selected layer(s).");
    return toolResult(true, "Applied to " + count + " layer(s).");
  } catch (e) {
    return toolResult(false, String(e));
  }
}

// ================================================================
// SHAPE CONTROLS — parameterized Trim / Taper / Dashes with sliders
// and quick presets. cfgStr is a JSON string: { type, preset, ... }.
// ================================================================
function ae_ctrlTrim(layer, contents, cfg, comp) {
  ae_shapeGetStroke(layer);
  var trim = contents.addProperty("ADBE Vector Filter - Trim");
  var sP = trim.property("ADBE Vector Trim Start");
  var eP = trim.property("ADBE Vector Trim End");
  var oP = trim.property("ADBE Vector Trim Offset");
  var t0 = comp.time, dur = Math.min(1.0, comp.duration);
  var preset = cfg.preset || "custom";
  if (preset === "writeOn") {
    eP.setValue(0); eP.setValueAtTime(t0, 0); eP.setValueAtTime(t0 + dur, 100); ae_shapeEasyEase(eP);
  } else if (preset === "reveal") {
    sP.setValueAtTime(t0, 0); sP.setValueAtTime(t0 + dur, 100); ae_shapeEasyEase(sP);
  } else if (preset === "circleDraw") {
    eP.setValue(0); eP.setValueAtTime(t0, 0); eP.setValueAtTime(t0 + dur, 100); ae_shapeEasyEase(eP);
    try { oP.setValue(-90); } catch (e) { compxAuditFallback("HOST_AE_CTRLTRIM_001", e); }
  } else if (preset === "reverseDraw") {
    sP.setValueAtTime(t0, 100); sP.setValueAtTime(t0 + dur, 0); ae_shapeEasyEase(sP);
  } else if (preset === "loop") {
    eP.setValueAtTime(t0, 0); eP.setValueAtTime(t0 + dur, 100);
    try { eP.expression = "loopOut('cycle');"; } catch (e) { compxAuditFallback("HOST_AE_CTRLTRIM_002", e); }
  } else {
    if (cfg.animate) {
      eP.setValue(0); eP.setValueAtTime(t0, 0); eP.setValueAtTime(t0 + dur, (cfg.end !== undefined ? cfg.end : 100)); ae_shapeEasyEase(eP);
      if (cfg.start !== undefined) { try { sP.setValue(cfg.start); } catch (e) { compxAuditFallback("HOST_AE_CTRLTRIM_003", e); } }
    } else {
      if (cfg.start !== undefined) { try { sP.setValue(cfg.start); } catch (e) { compxAuditFallback("HOST_AE_CTRLTRIM_004", e); } }
      if (cfg.end !== undefined) { try { eP.setValue(cfg.end); } catch (e) { compxAuditFallback("HOST_AE_CTRLTRIM_005", e); } }
    }
    if (cfg.offset !== undefined) { try { oP.setValue(cfg.offset); } catch (e) { compxAuditFallback("HOST_AE_CTRLTRIM_006", e); } }
  }
}

function ae_ctrlTaper(layer, cfg) {
  var stroke = ae_shapeGetStroke(layer);
  var taper = null;
  try { taper = stroke.property("ADBE Vector Stroke Taper"); } catch (e1) { compxAuditFallback("HOST_AE_CTRLTAPER_001", e1); }
  if (!taper) { try { taper = stroke.property("ADBE Vector Taper"); } catch (e2) { compxAuditFallback("HOST_AE_CTRLTAPER_002", e2); } }
  if (!taper) throw new Error("Taper needs After Effects 2020 or newer.");
  var sw = cfg.startWidth, ew = cfg.endWidth, sl = cfg.startLength, el = cfg.endLength, ease = cfg.ease;
  var preset = cfg.preset;
  if (preset === "arrow") { sw = 100; ew = 0; sl = 0; el = 100; ease = 50; }
  else if (preset === "brush") { sw = 0; ew = 100; sl = 30; el = 30; ease = 70; }
  else if (preset === "needle") { sw = 0; ew = 0; sl = 50; el = 50; ease = 100; }
  else if (preset === "speedLine") { sw = 100; ew = 0; sl = 0; el = 80; ease = 100; }
  var setT = function (mn, v) { if (v === undefined) return; try { taper.property(mn).setValue(v); } catch (e) { compxAuditFallback("HOST_AE_CTRLTAPER_003", e); } };
  setT("ADBE Vector Taper Start Width", sw);
  setT("ADBE Vector Taper End Width", ew);
  setT("ADBE Vector Taper Start Length", sl);
  setT("ADBE Vector Taper End Length", el);
  setT("ADBE Vector Taper Start Ease", ease);
  setT("ADBE Vector Taper End Ease", ease);
}

function ae_ctrlDashes(layer, cfg) {
  var stroke = ae_shapeGetStroke(layer);
  var dg = stroke.property("ADBE Vector Stroke Dashes");
  var dash = dg.addProperty("ADBE Vector Stroke Dash 1");
  try { if (cfg.dash !== undefined) dash.setValue(cfg.dash); } catch (e) { compxAuditFallback("HOST_AE_CTRLDASHES_001", e); }
  try { var gap = dg.addProperty("ADBE Vector Stroke Gap 1"); if (cfg.gap !== undefined) gap.setValue(cfg.gap); } catch (e) { compxAuditFallback("HOST_AE_CTRLDASHES_002", e); }
  var off = null;
  try { off = dg.property("ADBE Vector Stroke Offset"); } catch (e) { compxAuditFallback("HOST_AE_CTRLDASHES_003", e); }
  if (off) {
    if (cfg.animate) { try { off.expression = "time * 200;"; } catch (e) { compxAuditFallback("HOST_AE_CTRLDASHES_004", e); } }
    else if (cfg.offset !== undefined) { try { off.setValue(cfg.offset); } catch (e) { compxAuditFallback("HOST_AE_CTRLDASHES_005", e); } }
  }
}

function ae_shapeControl(cfgStr) {
  try {
    var cfg = JSON.parse(String(cfgStr || "{}"));
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = ae_getShapeLayers(comp);
    if (!layers.length) return toolResult(false, "Select one or more Shape Layers.");
    app.beginUndoGroup("Shape Control: " + cfg.type);
    var count = 0, warn = "";
    for (var i = 0; i < layers.length; i++) {
      try {
        var contents = layers[i].property("ADBE Root Vectors Group");
        if (cfg.type === "trim") ae_ctrlTrim(layers[i], contents, cfg, comp);
        else if (cfg.type === "taper") ae_ctrlTaper(layers[i], cfg);
        else if (cfg.type === "dashes") ae_ctrlDashes(layers[i], cfg);
        count++;
      } catch (le) { warn = String(le.message || le); }
    }
    app.endUndoGroup();
    if (!count) return toolResult(false, warn || "Could not apply to the selected layer(s).");
    return toolResult(true, "Applied to " + count + " layer(s).");
  } catch (e) {
    return toolResult(false, String(e));
  }
}

// -----------------------------------------------------------------------------
// COPY PASTA - Rebuilt isolated clipboard pipeline
// ASCII + ExtendScript-safe version.

function compxCopyPasta_isWindows() {
  try {
    return $.os && $.os.toLowerCase().indexOf("windows") >= 0;
  } catch (e) {
    return false;
  }
}
function compxCopyPasta_sep() {
  return compxCopyPasta_isWindows() ? "\\" : "/";
}
function compxCopyPasta_trimLeadingSlashes(part) {
  part = String(part || "");
  while (part.length > 0) {
    var ch = part.charAt(0);
    if (ch === "/" || ch === "\\") part = part.substring(1);
    else break;
  }
  return part;
}
function compxCopyPasta_trimTrailingSlashes(part) {
  part = String(part || "");
  while (part.length > 0) {
    var ch = part.charAt(part.length - 1);
    if (ch === "/" || ch === "\\") part = part.substring(0, part.length - 1);
    else break;
  }
  return part;
}
function compxCopyPasta_joinPath() {
  var sep = compxCopyPasta_sep();
  var out = [];
  var i, part;
  for (i = 0; i < arguments.length; i++) {
    part = String(arguments[i] || "");
    if (!part) continue;
    if (i > 0) part = compxCopyPasta_trimLeadingSlashes(part);
    if (i < arguments.length - 1) part = compxCopyPasta_trimTrailingSlashes(part);
    out.push(part);
  }
  return out.join(sep);
}
function compxCopyPasta_quote(s) {
  s = String(s || "");
  s = s.split('"').join('\\"');
  return '"' + s + '"';
}
function compxCopyPasta_getExtensionRoot() {
  try {
    return File($.fileName).parent.parent.fsName;
  } catch (e) {
    return Folder.temp.fsName;
  }
}
function compxCopyPasta_getBinFile(name) {
  return new File(compxCopyPasta_joinPath(compxCopyPasta_getExtensionRoot(), 'bin', name));
}
function compxCopyPasta_writeTextFile(path, body) {
  var f = new File(path);
  f.encoding = 'UTF-8';
  try { if (f.exists) f.remove(); } catch (e0) { compxAuditFallback("HOST_COMPXCOPYPASTA_WRITETEXTFILE_001", e0); }
  if (!f.open('w')) throw new Error('Could not open file for write: ' + path);
  f.write(body);
  f.close();
  return f;
}
function compxCopyPasta_runCommand(cmd) {
  try {
    return system.callSystem(cmd);
  } catch (e) {
    return String(e);
  }
}
function compxCopyPasta_runPowerShell(scriptBody) {
  if (!compxCopyPasta_isWindows()) return '';
  var base = compxCopyPasta_joinPath(Folder.temp.fsName, 'compx_copypasta_' + (new Date().getTime()));
  var ps1 = compxCopyPasta_writeTextFile(base + '.ps1', scriptBody);
  var command = 'powershell.exe -Sta -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + compxCopyPasta_quote(ps1.fsName);
  var result = compxCopyPasta_runCommand(command);
  try { if (ps1.exists) ps1.remove(); } catch (e1) { compxAuditFallback("HOST_COMPXCOPYPASTA_RUNPOWERSHELL_001", e1); }
  return String(result || '');
}
function compxCopyPasta_waitForStableFile(path, timeoutMs) {
  var started = new Date().getTime();
  var prevSize = -1;
  var stable = 0;
  while ((new Date().getTime() - started) < timeoutMs) {
    var f = new File(path);
    if (f.exists) {
      try {
        var size = f.length;
        if (size > 0 && size === prevSize) {
          stable++;
          if (stable >= 3) return true;
        } else {
          stable = 0;
          prevSize = size;
        }
      } catch (e2) { compxAuditFallback("HOST_COMPXCOPYPASTA_WAITFORSTABLEFILE_001", e2); }
    }
    $.sleep(120);
  }
  return false;
}
function compxCopyPasta_getProjectDir() {
  try {
    if (app.project && app.project.file) return app.project.file.parent.fsName;
  } catch (e) { compxAuditFallback("HOST_COMPXCOPYPASTA_GETPROJECTDIR_001", e); }
  return null;
}
function compxCopyPasta_getPasteDir() {
  var candidates = [];
  var projectDir = compxCopyPasta_getProjectDir();
  var i, folder, testFile;
  if (projectDir) candidates.push(compxCopyPasta_joinPath(projectDir, 'CopyPasta'));
  try {
    if (Folder.myDocuments) candidates.push(compxCopyPasta_joinPath(Folder.myDocuments.fsName, 'CopyPasta'));
  } catch (e0) { compxAuditFallback("HOST_COMPXCOPYPASTA_GETPASTEDIR_001", e0); }
  candidates.push(compxCopyPasta_joinPath(Folder.temp.fsName, 'CopyPasta'));
  for (i = 0; i < candidates.length; i++) {
    try {
      folder = new Folder(candidates[i]);
      if (!folder.exists) folder.create();
      testFile = new File(compxCopyPasta_joinPath(folder.fsName, '.write_test_' + (new Date().getTime())));
      if (testFile.open('w')) {
        testFile.write('ok');
        testFile.close();
        try { testFile.remove(); } catch (e1) { compxAuditFallback("HOST_COMPXCOPYPASTA_GETPASTEDIR_002", e1); }
        return folder.fsName;
      }
    } catch (e2) { compxAuditFallback("HOST_COMPXCOPYPASTA_GETPASTEDIR_003", e2); }
  }
  return Folder.temp.fsName;
}
function compxCopyPasta_setSelectedAsVisible(comp) {
  if (!comp || !comp.selectedLayers || comp.selectedLayers.length === 0) return null;
  var previousVisible = [];
  var i, layer;
  for (i = 1; i <= comp.layers.length; i++) {
    layer = comp.layers[i];
    previousVisible.push(layer.enabled);
    try { layer.enabled = !!layer.selected; } catch (e) { compxAuditFallback("HOST_COMPXCOPYPASTA_SETSELECTEDASVISIBLE_001", e); }
  }
  return previousVisible;
}
function compxCopyPasta_restoreVisible(comp, previousVisible) {
  if (!comp || !previousVisible) return;
  var i;
  for (i = 1; i <= comp.layers.length && i <= previousVisible.length; i++) {
    try { comp.layers[i].enabled = previousVisible[i - 1]; } catch (e) { compxAuditFallback("HOST_COMPXCOPYPASTA_RESTOREVISIBLE_001", e); }
  }
}
function compxCopyPasta_renderFrame(comp, outputPath) {
  var previousVisible = compxCopyPasta_setSelectedAsVisible(comp);
  try {
    var outFile = new File(outputPath);
    try { if (outFile.exists) outFile.remove(); } catch (e0) { compxAuditFallback("HOST_COMPXCOPYPASTA_RENDERFRAME_001", e0); }
    comp.saveFrameToPng(comp.time, outFile);
    if (!outFile.exists) throw new Error('PNG was not written.');
    return outFile.fsName;
  } finally {
    compxCopyPasta_restoreVisible(comp, previousVisible);
  }
}
function compxCopyPasta_copyImageToClipboard(pngPath) {
  if (!compxCopyPasta_isWindows()) return false;
  var script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$file = Get-Item -LiteralPath " + compxCopyPasta_quote(pngPath),
    "$img = $null",
    "try {",
    "  $img = [System.Drawing.Image]::FromFile($file.FullName)",
    "  [System.Windows.Forms.Clipboard]::SetImage($img)",
    "  Write-Output 'COPYPASTA_OK'",
    "} finally {",
    "  if ($img -ne $null) { $img.Dispose() }",
    "}"
  ].join("\r\n");
  var result = compxCopyPasta_runPowerShell(script);
  return result.indexOf('COPYPASTA_OK') !== -1;
}
function compxCopyPasta_pasteClipboardToFile(outputPath) {
  var outFile = new File(outputPath);
  try { if (outFile.exists) outFile.remove(); } catch (e0) { compxAuditFallback("HOST_COMPXCOPYPASTA_PASTECLIPBOARDTOFILE_001", e0); }
  if (!compxCopyPasta_isWindows()) return false;
  // Use the auditable PowerShell clipboard path instead of executing a
  // bundled native helper. The CEP-side implementation uses the same APIs.
  var script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Drawing",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$path = " + compxCopyPasta_quote(outFile.fsName),
    "$dir = [System.IO.Path]::GetDirectoryName($path)",
    "if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }",
    "$image = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $image) { Write-Output 'NO_IMAGE'; exit 2 }",
    "$image.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)",
    "Write-Output 'PASTE_OK'"
  ].join("\r\n");
  var result = compxCopyPasta_runPowerShell(script);
  if (result.indexOf('PASTE_OK') !== -1 && compxCopyPasta_waitForStableFile(outFile.fsName, 2500)) return true;
  return false;
}
function compxCopyPasta_getOrCreateProjectFolder(name) {
  var parentFolder = app.project.rootFolder;
  var foundFolder = null;
  var i, item;
  for (i = 1; i <= parentFolder.items.length; i++) {
    item = parentFolder.items[i];
    if (item instanceof FolderItem && item.name === name) {
      foundFolder = item;
      break;
    }
  }
  if (!foundFolder) foundFolder = parentFolder.items.addFolder(name);
  return foundFolder;
}
function compxCopyPasta_importStill(filePath, comp) {
  var srcFile = new File(filePath);
  if (!srcFile.exists) throw new Error('Clipboard PNG file not found: ' + filePath);
  var importOpts = new ImportOptions(srcFile);
  importOpts.importAs = ImportAsType.FOOTAGE;
  var footage = app.project.importFile(importOpts);
  if (!footage) throw new Error('AE could not import clipboard PNG.');
  try { footage.parentFolder = compxCopyPasta_getOrCreateProjectFolder('Copy Pasta'); } catch (e0) { compxAuditFallback("HOST_COMPXCOPYPASTA_IMPORTSTILL_001", e0); }
  var newLayer = comp.layers.add(footage);
  newLayer.startTime = comp.time;
  var remaining = comp.duration - comp.time;
  var layerDur = Math.max(remaining, 1);
  newLayer.outPoint = Math.min(comp.duration, comp.time + layerDur);
  var i;
  for (i = 1; i <= comp.numLayers; i++) {
    try { comp.layer(i).selected = false; } catch (e1) { compxAuditFallback("HOST_COMPXCOPYPASTA_IMPORTSTILL_002", e1); }
  }
  try { newLayer.selected = true; } catch (e2) { compxAuditFallback("HOST_COMPXCOPYPASTA_IMPORTSTILL_003", e2); }
  comp.openInViewer();
  return { footage: footage, layer: newLayer, duration: layerDur };
}
function ae_copyPastaCapture() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, 'No active composition.');
    var outPath = compxCopyPasta_joinPath(Folder.temp.fsName, 'compx_copypasta_' + Math.floor(Math.random() * 999999) + '.png');
    compxCopyPasta_renderFrame(comp, outPath);
    if (!compxCopyPasta_copyImageToClipboard(outPath)) {
      return toolResult(false, 'Copy Pasta could not place the rendered PNG on the system clipboard.');
    }
    try { app.settings.saveSetting('compx', 'copypasta_last_png', outPath); } catch (s0) { compxAuditFallback("HOST_AE_COPYPASTACAPTURE_001", s0); }
    return toolResult(true, 'Copied current frame to clipboard.');
  } catch (e) {
    return toolResult(false, String(e));
  }
}
function ae_copyPastaPaste() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, 'No active composition.');
    var pasteDir = compxCopyPasta_getPasteDir();
    var outPath = compxCopyPasta_joinPath(pasteDir, 'CopyPasta_' + (new Date().getTime()) + '.png');
    if (!compxCopyPasta_pasteClipboardToFile(outPath)) {
      return toolResult(false, 'Clipboard does not contain an image or helper could not write the PNG.');
    }
    app.beginUndoGroup('Copy Pasta Paste');
    var result = compxCopyPasta_importStill(outPath, comp);
    app.endUndoGroup();
    return toolResult(true, 'Clipboard image pasted as "' + result.footage.name + '".');
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_COPYPASTAPASTE_001", e2); }
    return toolResult(false, String(e));
  }
}

// LIBRARY TEXT STYLES — 10 presets for selected text layers.
function ae_applyTextAnimStyle(style) {
  function copyVec(v) {
    if (v instanceof Array) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(v[i]);
      return out;
    }
    return v;
  }
  function makePos(base, dx, dy) {
    var v = copyVec(base);
    if (v instanceof Array) {
      v[0] += dx || 0;
      v[1] += dy || 0;
    }
    return v;
  }
  function makeScale(base, sx, sy) {
    var v = copyVec(base);
    if (v instanceof Array) {
      v[0] = sx;
      v[1] = sy;
      if (v.length > 2 && typeof v[2] !== 'undefined') v[2] = base.length > 2 ? base[2] : 100;
    }
    return v;
  }
  function setEase(prop, influence) {
    try {
      var ease = new KeyframeEase(0, influence || 75);
      var dims = 1;
      try { dims = prop.value instanceof Array ? prop.value.length : 1; } catch (e) { compxAuditFallback("HOST_SETEASE_001", e); }
      var ins = [], outs = [];
      for (var i = 0; i < dims; i++) { ins.push(ease); outs.push(ease); }
      var n = prop.numKeys;
      for (var k = 1; k <= n; k++) prop.setTemporalEaseAtKey(k, ins, outs);
    } catch (e) { compxAuditFallback("HOST_SETEASE_002", e); }
  }
  function addNativeGlow(layer, threshold, radius, intensity, colorA, colorB) {
    try {
      var fx = layer.property("ADBE Effect Parade");
      if (!fx) return null;
      var glow = null;
      try { glow = fx.addProperty("ADBE Glo2"); } catch (e1) { compxAuditFallback("HOST_ADDNATIVEGLOW_001", e1); }
      if (!glow) return null;
      try { glow.property("ADBE Glo2-0001").setValue(threshold); } catch (e2) { compxAuditFallback("HOST_ADDNATIVEGLOW_002", e2); }
      try { glow.property("ADBE Glo2-0002").setValue(radius); } catch (e3) { compxAuditFallback("HOST_ADDNATIVEGLOW_003", e3); }
      try { glow.property("ADBE Glo2-0003").setValue(intensity); } catch (e4) { compxAuditFallback("HOST_ADDNATIVEGLOW_004", e4); }
      try { glow.property("ADBE Glo2-0005").setValue(colorA); } catch (e5) { compxAuditFallback("HOST_ADDNATIVEGLOW_005", e5); }
      try { glow.property("ADBE Glo2-0006").setValue(colorB); } catch (e6) { compxAuditFallback("HOST_ADDNATIVEGLOW_006", e6); }
      return glow;
    } catch (e) { return null; }
  }
  function addGradientRamp(layer, c1, c2, angleDeg) {
    try {
      var fx = layer.property("ADBE Effect Parade");
      if (!fx) return null;
      var ramp = null;
      try { ramp = fx.addProperty("ADBE Ramp"); } catch (e1) { compxAuditFallback("HOST_ADDGRADIENTRAMP_001", e1); }
      if (!ramp) return null;
      var comp = layer.containingComp;
      var cx = comp.width * 0.5, cy = comp.height * 0.5;
      var rad = (angleDeg || 0) * Math.PI / 180;
      var len = Math.max(comp.width, comp.height) * 0.35;
      var dx = Math.cos(rad) * len;
      var dy = Math.sin(rad) * len;
      try { ramp.property("ADBE Ramp-0001").setValue([cx - dx, cy - dy]); } catch (e2) { compxAuditFallback("HOST_ADDGRADIENTRAMP_002", e2); }
      try { ramp.property("ADBE Ramp-0002").setValue(c1); } catch (e3) { compxAuditFallback("HOST_ADDGRADIENTRAMP_003", e3); }
      try { ramp.property("ADBE Ramp-0003").setValue([cx + dx, cy + dy]); } catch (e4) { compxAuditFallback("HOST_ADDGRADIENTRAMP_004", e4); }
      try { ramp.property("ADBE Ramp-0004").setValue(c2); } catch (e5) { compxAuditFallback("HOST_ADDGRADIENTRAMP_005", e5); }
      try { ramp.property("ADBE Ramp-0005").setValue(1); } catch (e6) { compxAuditFallback("HOST_ADDGRADIENTRAMP_006", e6); }
      return ramp;
    } catch (e) { return null; }
  }
  function revealText(tdProp, fullText, mode, t0, dur) {
    try {
      if (!tdProp) return;
      var txt = String(fullText || "");
      if (!txt.length) return;
      var parts = [];
      if (mode === "words") {
        var ws = txt.split(/(\s+)/);
        var build = "";
        for (var i = 0; i < ws.length; i++) {
          build += ws[i];
          if (ws[i].replace(/\s+/g, '').length) parts.push(build);
        }
      } else {
        for (var c = 1; c <= txt.length; c++) parts.push(txt.substring(0, c));
      }
      var baseDoc = tdProp.value;
      var emptyDoc = tdProp.value;
      emptyDoc.text = "";
      tdProp.setValueAtTime(t0, emptyDoc);
      var steps = Math.max(1, parts.length);
      for (var s = 0; s < parts.length; s++) {
        var d = tdProp.value;
        d.text = parts[s];
        tdProp.setValueAtTime(t0 + (dur * ((s + 1) / steps)), d);
      }
    } catch (e) { compxAuditFallback("HOST_REVEALTEXT_001", e); }
  }
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var ls = getSelectedLayers(comp);
    var s = String(style || "luxePop");
    app.beginUndoGroup("Premium Text Style: " + s);

    var textLayers = [];
    var createdDemo = false;
    for (var i0 = 0; i0 < ls.length; i0++) {
      try { if (ls[i0].property("ADBE Text Properties")) textLayers.push(ls[i0]); } catch (ee0) { compxAuditFallback("HOST_REVEALTEXT_002", ee0); }
    }
    if (!textLayers.length) {
      var demo = comp.layers.addText("Demo Text");
      demo.name = "CompX Demo Text";
      demo.startTime = comp.time;
      try {
        var tr0 = demo.property("ADBE Transform Group");
        var p0 = tr0.property("ADBE Position");
        var baseP = p0.value;
        p0.setValue(baseP.length === 3 ? [comp.width/2, comp.height/2, baseP[2]] : [comp.width/2, comp.height/2]);
      } catch (pe0) { compxAuditFallback("HOST_REVEALTEXT_003", pe0); }
      try {
        var td0 = demo.property("ADBE Text Properties").property("ADBE Text Document");
        var doc0 = td0.value;
        doc0.fontSize = 120;
        doc0.justification = ParagraphJustification.CENTER_JUSTIFY;
        td0.setValue(doc0);
      } catch (te0) { compxAuditFallback("HOST_REVEALTEXT_004", te0); }
      try { demo.selected = true; } catch (se0) { compxAuditFallback("HOST_REVEALTEXT_005", se0); }
      textLayers.push(demo);
      createdDemo = true;
    }

    var done = 0;
    for (var i = 0; i < textLayers.length; i++) {
      var l = textLayers[i];
      var tp = l.property("ADBE Text Properties");
      if (!tp) continue;
      var tdProp = tp.property("ADBE Text Document");
      var tr = l.property("ADBE Transform Group");
      if (!tr) continue;

      var pos = tr.property("ADBE Position");
      var sc = tr.property("ADBE Scale");
      var rot = tr.property("ADBE Rotate Z") || tr.property("ADBE Rotation");
      var op = tr.property("ADBE Opacity");
      if (!pos || !sc || !op) continue;

      var t0 = comp.time;
      var dur = 0.8;
      var mid = t0 + dur * 0.55;
      var late = t0 + dur * 0.78;
      var end = t0 + dur;
      var basePos = copyVec(pos.value);
      var baseScale = copyVec(sc.value);
      var baseRot = rot ? rot.value : 0;
      var fullText = "";
      try { fullText = tdProp.value.text || ""; } catch (txe) { compxAuditFallback("HOST_REVEALTEXT_006", txe); }

      if (s === "luxePop" || s === "characterPop") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100);
        pos.setValueAtTime(t0, makePos(basePos, 0, 26)); pos.setValueAtTime(mid, makePos(basePos, 0, -5)); pos.setValueAtTime(end, basePos);
        sc.setValueAtTime(t0, makeScale(baseScale, 72, 72)); sc.setValueAtTime(mid, makeScale(baseScale, 108, 108)); sc.setValueAtTime(end, baseScale);
        setEase(op, 80); setEase(pos, 78); setEase(sc, 82);
      } else if (s === "silkRise" || s === "slideUp") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(end, 100);
        pos.setValueAtTime(t0, makePos(basePos, 0, 90)); pos.setValueAtTime(end, basePos);
        sc.setValueAtTime(t0, makeScale(baseScale, 96, 96)); sc.setValueAtTime(end, baseScale);
        setEase(op, 72); setEase(pos, 86); setEase(sc, 70);
      } else if (s === "dropBounce" || s === "slideDown") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100);
        pos.setValueAtTime(t0, makePos(basePos, 0, -120)); pos.setValueAtTime(mid, makePos(basePos, 0, 16)); pos.setValueAtTime(end, basePos);
        sc.setValueAtTime(t0, makeScale(baseScale, 88, 88)); sc.setValueAtTime(mid, makeScale(baseScale, 104, 104)); sc.setValueAtTime(end, baseScale);
        setEase(op, 70); setEase(pos, 84); setEase(sc, 76);
      } else if (s === "velocityLeft") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100);
        pos.setValueAtTime(t0, makePos(basePos, 150, 0)); pos.setValueAtTime(mid, makePos(basePos, -10, 0)); pos.setValueAtTime(end, basePos);
        if (rot) { rot.setValueAtTime(t0, baseRot - 4); rot.setValueAtTime(mid, baseRot + 1.5); rot.setValueAtTime(end, baseRot); setEase(rot, 80); }
        setEase(op, 72); setEase(pos, 88);
      } else if (s === "velocityRight") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100);
        pos.setValueAtTime(t0, makePos(basePos, -150, 0)); pos.setValueAtTime(mid, makePos(basePos, 10, 0)); pos.setValueAtTime(end, basePos);
        if (rot) { rot.setValueAtTime(t0, baseRot + 4); rot.setValueAtTime(mid, baseRot - 1.5); rot.setValueAtTime(end, baseRot); setEase(rot, 80); }
        setEase(op, 72); setEase(pos, 88);
      } else if (s === "heroRotate" || s === "rotateIn") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100);
        sc.setValueAtTime(t0, makeScale(baseScale, 84, 84)); sc.setValueAtTime(mid, makeScale(baseScale, 104, 104)); sc.setValueAtTime(end, baseScale);
        if (rot) { rot.setValueAtTime(t0, baseRot - 28); rot.setValueAtTime(mid, baseRot + 6); rot.setValueAtTime(end, baseRot); setEase(rot, 84); }
        pos.setValueAtTime(t0, makePos(basePos, 0, 22)); pos.setValueAtTime(end, basePos);
        setEase(op, 75); setEase(sc, 82); setEase(pos, 72);
      } else if (s === "trackingSnap" || s === "trackingTighten") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(end, 100);
        sc.setValueAtTime(t0, makeScale(baseScale, 145, 100)); sc.setValueAtTime(late, makeScale(baseScale, 97, 100)); sc.setValueAtTime(end, baseScale);
        pos.setValueAtTime(t0, makePos(basePos, 18, 0)); pos.setValueAtTime(end, basePos);
        setEase(op, 70); setEase(sc, 86); setEase(pos, 70);
      } else if (s === "punchIn" || s === "bounceOvershoot") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100);
        sc.setValueAtTime(t0, makeScale(baseScale, 42, 42)); sc.setValueAtTime(mid, makeScale(baseScale, 118, 118)); sc.setValueAtTime(late, makeScale(baseScale, 98, 98)); sc.setValueAtTime(end, baseScale);
        setEase(op, 76); setEase(sc, 90);
      } else if (s === "neonFlicker" || s === "brokenGlitch") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(t0 + dur * 0.12, 35); op.setValueAtTime(t0 + dur * 0.22, 0); op.setValueAtTime(t0 + dur * 0.38, 68); op.setValueAtTime(t0 + dur * 0.52, 18); op.setValueAtTime(end, 100);
        pos.setValueAtTime(t0, makePos(basePos, -8, 0)); pos.setValueAtTime(t0 + dur * 0.18, makePos(basePos, 10, 0)); pos.setValueAtTime(t0 + dur * 0.36, makePos(basePos, -6, 0)); pos.setValueAtTime(end, basePos);
        if (rot) { rot.setValueAtTime(t0, baseRot - 2); rot.setValueAtTime(t0 + dur * 0.2, baseRot + 2); rot.setValueAtTime(end, baseRot); setEase(rot, 55); }
        setEase(op, 68); setEase(pos, 55);
      } else if (s === "cinematicFade") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(end, 100);
        pos.setValueAtTime(t0, makePos(basePos, 0, 24)); pos.setValueAtTime(end, basePos);
        if (rot) { rot.setValueAtTime(t0, baseRot - 1.5); rot.setValueAtTime(end, baseRot); setEase(rot, 60); }
        setEase(op, 62); setEase(pos, 72);
      } else if (s === "wordStagger") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(end, 100);
        revealText(tdProp, fullText, "words", t0, dur);
        pos.setValueAtTime(t0, makePos(basePos, 0, 18)); pos.setValueAtTime(end, basePos);
        setEase(op, 66); setEase(pos, 74);
      } else if (s === "typewriter") {
        revealText(tdProp, fullText, "chars", t0, dur);
        op.setValueAtTime(t0, 100); op.setValueAtTime(end, 100);
      } else if (s === "blurReveal") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(end, 100);
        pos.setValueAtTime(t0, makePos(basePos, 0, 30)); pos.setValueAtTime(end, basePos);
        sc.setValueAtTime(t0, makeScale(baseScale, 112, 112)); sc.setValueAtTime(end, baseScale);
        setEase(op, 70); setEase(pos, 80); setEase(sc, 70);
      } else if (s === "glowPulse") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100); op.setValueAtTime(end, 100);
        sc.setValueAtTime(t0, makeScale(baseScale, 92, 92)); sc.setValueAtTime(mid, makeScale(baseScale, 104, 104)); sc.setValueAtTime(end, baseScale);
        addNativeGlow(l, 55, 45, 1.8, [1,0.7,0.2], [1,0.35,0.05]);
        setEase(op, 70); setEase(sc, 76);
      } else if (s === "gradientFlow") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(end, 100);
        pos.setValueAtTime(t0, makePos(basePos, 0, 20)); pos.setValueAtTime(end, basePos);
        addGradientRamp(l, [1,0.45,0.15], [1,0.85,0.2], 22);
        addNativeGlow(l, 70, 22, 0.7, [1,0.6,0.18], [1,0.3,0.05]);
        setEase(op, 70); setEase(pos, 70);
      } else if (s === "maskReveal") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100);
        pos.setValueAtTime(t0, makePos(basePos, -90, 0)); pos.setValueAtTime(end, basePos);
        sc.setValueAtTime(t0, makeScale(baseScale, 118, 100)); sc.setValueAtTime(end, baseScale);
        setEase(op, 72); setEase(pos, 84); setEase(sc, 72);
      } else if (s === "wipeReveal") {
        op.setValueAtTime(t0, 0); op.setValueAtTime(mid, 100);
        pos.setValueAtTime(t0, makePos(basePos, 90, 0)); pos.setValueAtTime(end, basePos);
        sc.setValueAtTime(t0, makeScale(baseScale, 82, 100)); sc.setValueAtTime(end, baseScale);
        setEase(op, 72); setEase(pos, 84); setEase(sc, 72);
      } else {
        op.setValueAtTime(t0, 0); op.setValueAtTime(end, 100);
        setEase(op, 70);
      }
      done++;
    }

    app.endUndoGroup();
    if (done > 0) return toolResult(true, (createdDemo ? "Demo text layer created + " : "") + "Text style applied to " + done + " layer(s).");
    return toolResult(false, "Could not find or create a text layer.");
  } catch(e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_REVEALTEXT_007", e2); }
    return toolResult(false, String(e));
  }
}

function ae_findFirstVectorPathPropInGroup(group) {
  if (!group) return null;
  try {
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (!p) continue;
      try {
        if (p.matchName === "ADBE Vector Shape - Group" || p.matchName === "ADBE Vector Shape") return p;
      } catch (e0) { compxAuditFallback("HOST_AE_FINDFIRSTVECTORPATHPROPINGROUP_001", e0); }
      try {
        if (p.matchName === "ADBE Vector Group") {
          var child = p.property("ADBE Vectors Group");
          var found = ae_findFirstVectorPathPropInGroup(child);
          if (found) return found;
        }
      } catch (e1) { compxAuditFallback("HOST_AE_FINDFIRSTVECTORPATHPROPINGROUP_002", e1); }
    }
  } catch (e) { compxAuditFallback("HOST_AE_FINDFIRSTVECTORPATHPROPINGROUP_003", e); }
  return null;
}

function ae_findFirstVectorPathProp(layer) {
  try {
    var root = layer.property("ADBE Root Vectors Group");
    if (!root) return null;
    return ae_findFirstVectorPathPropInGroup(root);
  } catch (e) { return null; }
}

// ── Super Morph geometry helpers (even resampling + correspondence alignment) ──
// Pure math (no AE calls) so it can be unit-tested outside After Effects.
function _cmDist(a, b) { var dx = a[0]-b[0], dy = a[1]-b[1]; return Math.sqrt(dx*dx + dy*dy); }
function _cmZeros(n) { var z = []; for (var i = 0; i < n; i++) z.push([0, 0]); return z; }
function _cmBezier(p0, c1, c2, p3, u) {
  var mu = 1-u, a = mu*mu*mu, b = 3*mu*mu*u, c = 3*mu*u*u, d = u*u*u;
  return [ a*p0[0]+b*c1[0]+c*c2[0]+d*p3[0], a*p0[1]+b*c1[1]+c*c2[1]+d*p3[1] ];
}
// Flatten a bezier path into a dense polyline of anchor points.
function _cmFlatten(shape, perSeg) {
  var V = shape.vertices || [], I = shape.inTangents || [], O = shape.outTangents || [];
  var closed = !!shape.closed, n = V.length;
  if (n < 2) return n ? [[V[0][0], V[0][1]]] : [];
  var segs = closed ? n : (n-1), pts = [];
  for (var s = 0; s < segs; s++) {
    var i = s, j = (s+1) % n;
    var oi = O[i] || [0,0], ij = I[j] || [0,0];
    var p0 = V[i], c1 = [V[i][0]+oi[0], V[i][1]+oi[1]], c2 = [V[j][0]+ij[0], V[j][1]+ij[1]], p3 = V[j];
    var kStart = (s === 0) ? 0 : 1;
    for (var k = kStart; k <= perSeg; k++) pts.push(_cmBezier(p0, c1, c2, p3, k/perSeg));
  }
  return pts;
}
// Resample a polyline to N points equally spaced by arc length.
function _cmResample(poly, N, closed) {
  var m = poly.length, out = [], q, s;
  if (m === 0) return [];
  if (m === 1) { for (q = 0; q < N; q++) out.push([poly[0][0], poly[0][1]]); return out; }
  var cum = [0];
  for (var i = 1; i < m; i++) cum.push(cum[i-1] + _cmDist(poly[i-1], poly[i]));
  var total = cum[m-1];
  if (total <= 0) { for (q = 0; q < N; q++) out.push([poly[0][0], poly[0][1]]); return out; }
  for (s = 0; s < N; s++) {
    var frac = closed ? (s / N) : (s / (N - 1));
    var target = frac * total, idx = 1;
    while (idx < m && cum[idx] < target) idx++;
    if (idx > m - 1) idx = m - 1;
    var segLen = cum[idx] - cum[idx-1];
    var f = segLen > 0 ? (target - cum[idx-1]) / segLen : 0;
    var pa = poly[idx-1], pb = poly[idx];
    out.push([ pa[0] + (pb[0]-pa[0])*f, pa[1] + (pb[1]-pa[1])*f ]);
  }
  return out;
}
function _cmReverse(pts) { var r = []; for (var i = pts.length-1; i >= 0; i--) r.push(pts[i]); return r; }
function _cmRotate(pts, off) { var n = pts.length, r = []; for (var i = 0; i < n; i++) r.push(pts[(i+off) % n]); return r; }
function _cmCost(A, B) { var sum = 0; for (var i = 0; i < A.length; i++) { var dx = A[i][0]-B[i][0], dy = A[i][1]-B[i][1]; sum += dx*dx + dy*dy; } return sum; }
// Rotate/flip B so its point order best matches A (minimizes total travel).
function _cmAlign(A, B, closed) {
  var best = B, bestCost = _cmCost(A, B), c, off, cand, rot, cost;
  if (closed) {
    var cands = [B, _cmReverse(B)];
    for (c = 0; c < cands.length; c++) {
      cand = cands[c];
      for (off = 0; off < cand.length; off++) {
        rot = _cmRotate(cand, off);
        cost = _cmCost(A, rot);
        if (cost < bestCost) { bestCost = cost; best = rot; }
      }
    }
  } else {
    var rev = _cmReverse(B), rc = _cmCost(A, rev);
    if (rc < bestCost) { bestCost = rc; best = rev; }
  }
  return best;
}

// -- Parametric shape -> outline polyline (so ellipses / rects / stars /
// polygons can be morphed even though they have no editable bezier path) --
function _cmEllipsePoly(cx, cy, rx, ry) {
  var pts = [], N = 96;
  for (var i = 0; i <= N; i++) {
    var a = (Math.PI * 2 * i) / N;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}
function _cmRectPoly(cx, cy, w, h, r) {
  var hw = w / 2, hh = h / 2;
  r = Math.max(0, Math.min(r || 0, Math.min(hw, hh)));
  var pts = [], seg = 6;
  function corner(ccx, ccy, a0, a1) {
    for (var i = 0; i <= seg; i++) {
      var a = a0 + (a1 - a0) * (i / seg);
      pts.push([ccx + r * Math.cos(a), ccy + r * Math.sin(a)]);
    }
  }
  if (r <= 0) {
    pts.push([cx - hw, cy - hh]);
    pts.push([cx + hw, cy - hh]);
    pts.push([cx + hw, cy + hh]);
    pts.push([cx - hw, cy + hh]);
    pts.push([cx - hw, cy - hh]);
    return pts;
  }
  corner(cx + hw - r, cy - hh + r, -Math.PI / 2, 0);
  corner(cx + hw - r, cy + hh - r, 0, Math.PI / 2);
  corner(cx - hw + r, cy + hh - r, Math.PI / 2, Math.PI);
  corner(cx - hw + r, cy - hh + r, Math.PI, Math.PI * 1.5);
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}
function _cmStarPoly(cx, cy, type, points, rot, outerR, innerR) {
  var n = Math.round(points); if (n < 3) n = 3;
  var isStar = (Number(type) === 1);
  var total = isStar ? n * 2 : n;
  var start = ((rot || 0) - 90) * Math.PI / 180;
  var pts = [];
  for (var i = 0; i <= total; i++) {
    var a = start + (Math.PI * 2 * i) / total;
    var rad = isStar ? ((i % 2 === 0) ? outerR : innerR) : outerR;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return pts;
}
function _cmParaVal(p, name, dflt) {
  try { var pr = p.property(name); if (pr) return pr.value; } catch (e) { compxAuditFallback("HOST_AE_CMPARAVAL_001", e); }
  return dflt;
}
function ae_findParametricShape(group) {
  if (!group) return null;
  try {
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i); if (!p) continue;
      var mn = null; try { mn = p.matchName; } catch (e0) { compxAuditFallback("HOST_AE_FINDPARAMETRICSHAPE_002", e0); continue; }
      if (mn === "ADBE Vector Shape - Ellipse") {
        var esz = _cmParaVal(p, "ADBE Vector Ellipse Size", [100, 100]);
        var eps = _cmParaVal(p, "ADBE Vector Ellipse Position", [0, 0]);
        return { poly: _cmEllipsePoly(eps[0], eps[1], esz[0] / 2, esz[1] / 2), closed: true };
      }
      if (mn === "ADBE Vector Shape - Rect") {
        var rsz = _cmParaVal(p, "ADBE Vector Rect Size", [100, 100]);
        var rps = _cmParaVal(p, "ADBE Vector Rect Position", [0, 0]);
        var rr = _cmParaVal(p, "ADBE Vector Rect Roundness", 0);
        return { poly: _cmRectPoly(rps[0], rps[1], rsz[0], rsz[1], rr), closed: true };
      }
      if (mn === "ADBE Vector Shape - Star") {
        var stype = _cmParaVal(p, "ADBE Vector Star Type", 1);
        var spts  = _cmParaVal(p, "ADBE Vector Star Points", 5);
        var spos  = _cmParaVal(p, "ADBE Vector Star Position", [0, 0]);
        var srot  = _cmParaVal(p, "ADBE Vector Star Rotation", 0);
        var soR   = _cmParaVal(p, "ADBE Vector Star Outer Radius", 100);
        var siR   = _cmParaVal(p, "ADBE Vector Star Inner Radius", 50);
        return { poly: _cmStarPoly(spos[0], spos[1], stype, spts, srot, soR, siR), closed: true };
      }
      if (mn === "ADBE Vector Group") {
        var child = null; try { child = p.property("ADBE Vectors Group"); } catch (e1) { compxAuditFallback("HOST_AE_FINDPARAMETRICSHAPE_003", e1); child = null; }
        var found = ae_findParametricShape(child);
        if (found) return found;
      }
    }
  } catch (e) { compxAuditFallback("HOST_AE_FINDPARAMETRICSHAPE_001", e); }
  return null;
}
// Returns { poly:[[x,y],...], closed:bool } for a layer: editable bezier path
// first, otherwise a synthesized outline for parametric shapes.
function ae_extractMorphPoly(layer, perSeg) {
  try {
    var root = layer.property("ADBE Root Vectors Group");
    if (!root) return null;
    var pathProp = ae_findFirstVectorPathPropInGroup(root);
    if (pathProp) {
      var sh = pathProp.value;
      if (sh && sh.vertices && sh.vertices.length >= 2) {
        return { poly: _cmFlatten(sh, perSeg || 16), closed: !!sh.closed };
      }
    }
    return ae_findParametricShape(root);
  } catch (e) { compxAuditFallback("HOST_AE_EXTRACTMORPHPOLY_001", e); return null; }
}

function ae_shapePathMorph(dataStr) {
  try {
    var opts = { duration: 1.2, smoothness: 70, autoEase: true };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        if (parsed.duration !== undefined) opts.duration = Number(parsed.duration);
        if (parsed.smoothness !== undefined) opts.smoothness = Number(parsed.smoothness);
        if (parsed.autoEase !== undefined) opts.autoEase = !!parsed.autoEase;
      } catch (pe) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_001", pe); }
    }
    opts.duration = Math.max(0.2, Math.min(8, opts.duration || 1.2));
    opts.smoothness = Math.max(0, Math.min(100, opts.smoothness || 70));

    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length !== 2) return toolResult(false, "Select exactly 2 Shape Layers.");

    var layerA = layers[0], layerB = layers[1];
    var polyA = ae_extractMorphPoly(layerA, 16);
    var polyB = ae_extractMorphPoly(layerB, 16);
    if (!polyA || !polyB || polyA.poly.length < 2 || polyB.poly.length < 2) {
      return toolResult(false, "Could not read a shape outline from both layers. Select two Shape Layers (paths, ellipses, rectangles, stars, or polygons).");
    }

    // Offset the target outline so the morph ends where layer B actually sits.
    try {
      var pA = layerA.property("ADBE Transform Group").property("ADBE Position").value;
      var pB = layerB.property("ADBE Transform Group").property("ADBE Position").value;
      var dxB = (pB[0] || 0) - (pA[0] || 0), dyB = (pB[1] || 0) - (pA[1] || 0);
      if (dxB || dyB) { var bpts = polyB.poly; for (var bi = 0; bi < bpts.length; bi++) { bpts[bi] = [bpts[bi][0] + dxB, bpts[bi][1] + dyB]; } }
    } catch (offErr) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_011", offErr); }

    var closed = !!(polyA.closed && polyB.closed);

    // ── Super Morph v2: even arc-length resampling + correspondence alignment ──
    // Old code padded the shorter path with its last vertex (points bunched up)
    // and never matched vertex order (shapes twisted). Now we resample BOTH
    // paths to the same number of evenly spaced points along real bezier arc
    // length, then rotate/flip path B so its points line up with path A.
    var morphN = Math.max(24, Math.round(48 + (opts.smoothness / 100) * 96));
    var A2 = _cmResample(polyA.poly, morphN, closed);
    var B2 = _cmResample(polyB.poly, morphN, closed);
    B2 = _cmAlign(A2, B2, closed);
    if (A2.length !== B2.length || A2.length < 2) return toolResult(false, "Could not resample shape paths.");
    var maxLen = A2.length;
    var t0 = comp.time;
    var dur = opts.duration;

    app.beginUndoGroup("Super Morph Shape Path");

    var shapeLayer = comp.layers.addShape();
    shapeLayer.name = "MORPH_" + layerA.name + "_to_" + layerB.name;
    try { shapeLayer.moveBefore(layerA); } catch (mb) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_002", mb); }

    var tr = shapeLayer.property("ADBE Transform Group");
    var srcTr = layerA.property("ADBE Transform Group");
    try { tr.property("ADBE Position").setValue(srcTr.property("ADBE Position").value); } catch (e2) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_003", e2); }
    try { tr.property("ADBE Anchor Point").setValue(srcTr.property("ADBE Anchor Point").value); } catch (e3) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_004", e3); }
    try { tr.property("ADBE Scale").setValue(srcTr.property("ADBE Scale").value); } catch (e4) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_005", e4); }
    try { tr.property("ADBE Rotation").setValue(srcTr.property("ADBE Rotation").value); } catch (e5) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_006", e5); }
    try { tr.property("ADBE Opacity").setValue(100); } catch (e6) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_007", e6); }

    var root = shapeLayer.property("ADBE Root Vectors Group");
    var group = root.addProperty("ADBE Vector Group");
    group.name = "Morph Path";
    var gRoot = group.property("ADBE Vectors Group");
    var pathProp = gRoot.addProperty("ADBE Vector Shape - Group");
    gRoot.addProperty("ADBE Vector Graphic - Fill");
    try {
      var stroke = gRoot.addProperty("ADBE Vector Graphic - Stroke");
      stroke.property("ADBE Vector Stroke Width").setValue(4);
    } catch (se) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_008", se); }

    // Two path keyframes are enough now that correspondence is aligned — After
    // Effects interpolates the equal-count paths vertex-by-vertex for an even
    // morph; temporal easing (below) controls the timing. Resampled points are
    // plain anchors (zero tangents) but dense enough to stay visually smooth.
    var shape0 = ae_plainToShape({ vertices: A2, inTangents: _cmZeros(maxLen), outTangents: _cmZeros(maxLen), closed: closed });
    var shape1 = ae_plainToShape({ vertices: B2, inTangents: _cmZeros(maxLen), outTangents: _cmZeros(maxLen), closed: closed });
    pathProp.setValueAtTime(t0, shape0);
    pathProp.setValueAtTime(t0 + dur, shape1);

    if (opts.autoEase) {
      try { smoothMorphKeys(pathProp); } catch (ee) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_009", ee); }
    }

    app.endUndoGroup();
    return toolResult(true, "Shape-path Super Morph created: " + layerA.name + " → " + layerB.name + " (" + maxLen + " matched points).");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_SHAPEPATHMORPH_010", e2); }
    return toolResult(false, "Shape-path morph failed: " + String(e));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SUPER MORPH  v4  —  "Morph anything" layer-based system
// Works on ANY layer type (shape, text, image, video, solid). Supports:
//   • one-click morph between two layers
//   • multi-object CHAIN morph across 2+ selected layers
//   • Trails (Echo)  • Slicer (CC Griddler)  • full customization
// Vector-path interpolation stays available via mode:"path" for 2 shape layers.
// ─────────────────────────────────────────────────────────────────────────

// Trails — adds an Echo effect so the morph smears/streaks. Fail-safe: any
// missing sub-property is skipped without breaking the core morph.
function ae_morphAddTrails(layer, amount) {
  try {
    var fx = layer.property("ADBE Effect Parade");
    if (!fx) return false;
    var echo = fx.addProperty("ADBE Echo");
    if (!echo) return false;
    var echoes = Math.max(2, Math.round(2 + (amount / 100) * 8));
    try { echo.property("ADBE Echo-0001").setValue(-0.033); } catch (e1) { compxAuditFallback("HOST_AE_MORPHTRAILS_001", e1); }
    try { echo.property("ADBE Echo-0002").setValue(echoes); } catch (e2) { compxAuditFallback("HOST_AE_MORPHTRAILS_002", e2); }
    try { echo.property("ADBE Echo-0003").setValue(1); } catch (e3) { compxAuditFallback("HOST_AE_MORPHTRAILS_003", e3); }
    try { echo.property("ADBE Echo-0004").setValue(0.35 + (amount / 100) * 0.5); } catch (e4) { compxAuditFallback("HOST_AE_MORPHTRAILS_004", e4); }
    try { echo.property("ADBE Echo-0005").setValue(6); } catch (e5) { compxAuditFallback("HOST_AE_MORPHTRAILS_005", e5); } // Composite In Front
    return true;
  } catch (e) { compxAuditFallback("HOST_AE_MORPHTRAILS_006", e); return false; }
}

// Slicer — adds CC Griddler and animates the slice scale so the object breaks
// into strips and reassembles across the transition. Fail-safe.
function ae_morphAddSlicer(layer, sliceCount, tStart, tEnd, doEase) {
  try {
    var fx = layer.property("ADBE Effect Parade");
    if (!fx) return false;
    var grid = fx.addProperty("CC Griddler");
    if (!grid) return false;
    try { var ca = grid.property("Cutting Angle"); if (ca) ca.setValue(0); } catch (e2) { compxAuditFallback("HOST_AE_MORPHSLICER_001", e2); }
    var hs = null;
    try { hs = grid.property("Horizontal Scale"); } catch (e0) { compxAuditFallback("HOST_AE_MORPHSLICER_002", e0); }
    if (!hs) { try { hs = grid.property(1); } catch (e1) { compxAuditFallback("HOST_AE_MORPHSLICER_003", e1); } }
    if (hs) {
      var lo = Math.max(15, 100 - (Number(sliceCount) || 8) * 6);
      hs.setValueAtTime(tStart, lo);
      hs.setValueAtTime(tEnd, 100);
      if (doEase) { try { smoothMorphKeys(hs); } catch (ee) { compxAuditFallback("HOST_AE_MORPHSLICER_004", ee); } }
    }
    return true;
  } catch (e) { compxAuditFallback("HOST_AE_MORPHSLICER_005", e); return false; }
}

function ae_superMorphSmart(dataStr) {
  try {
    var opts = {
      duration: 1.2, smoothness: 70, elasticity: 25, style: "liquid",
      autoEase: true, mode: "liquid", trails: false, trailAmount: 60,
      slicer: false, sliceCount: 8
    };
    if (dataStr) {
      try {
        var parsed = JSON.parse(dataStr);
        for (var pk in parsed) { if (parsed.hasOwnProperty(pk)) opts[pk] = parsed[pk]; }
      } catch (pe) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_001", pe); }
    }
    opts.duration = Math.max(0.2, Math.min(8, Number(opts.duration) || 1.2));
    var el = Number(opts.elasticity); if (isNaN(el)) el = 25;
    opts.elasticity = Math.max(0, Math.min(100, el));

    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp);
    if (layers.length < 2) return toolResult(false, "Select at least 2 layers to morph (source first, target last).");

    // Vector-path mode: true path interpolation for exactly 2 shape layers.
    if (String(opts.mode) === "path" && layers.length === 2) {
      var pres = ae_shapePathMorph(dataStr);
      if (pres && pres.success) return pres;
      // else fall through to the universal liquid morph
    }

    var n = layers.length;
    var t0 = comp.time;
    var dur = opts.duration;

    var styleName = String(opts.style || "liquid").toLowerCase();
    var styleWarp = 1.0;
    if (styleName === "mechanical") styleWarp = 0.25;
    else if (styleName === "clean") styleWarp = 0.55;
    else if (styleName === "liquid") styleWarp = 1.0;
    else if (styleName === "gooey") styleWarp = 1.35;
    else if (styleName === "organic") styleWarp = 1.15;
    var doEase = (styleName === "mechanical") ? false : !!opts.autoEase;
    var warpMax = (opts.elasticity / 100) * 260 * styleWarp;
    var pinch = 1 - (opts.elasticity / 100) * 0.22;

    app.beginUndoGroup("Super Morph");

    for (var li = 0; li < n; li++) {
      var layer = layers[li];
      var tr = layer.property("ADBE Transform Group");
      var op = tr.property("ADBE Opacity");
      var sc = tr.property("ADBE Scale");
      var baseScale = sc.value;

      // Opacity role in the A->B->C... chain (triangle peak for middle layers).
      var kf = [];
      if (li === 0) { kf.push([t0, 100]); kf.push([t0 + dur, 0]); }
      else if (li === n - 1) { kf.push([t0 + (li - 1) * dur, 0]); kf.push([t0 + li * dur, 100]); }
      else { kf.push([t0 + (li - 1) * dur, 0]); kf.push([t0 + li * dur, 100]); kf.push([t0 + (li + 1) * dur, 0]); }

      for (var ki = 0; ki < kf.length; ki++) {
        var tt = kf[ki][0], ov = kf[ki][1];
        try { op.setValueAtTime(tt, ov); } catch (oe) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_002", oe); }
        if (opts.elasticity > 0) {
          var f = pinch + (1 - pinch) * (ov / 100);
          var sv = (baseScale.length === 3) ? [baseScale[0] * f, baseScale[1] * f, baseScale[2]] : [baseScale[0] * f, baseScale[1] * f];
          try { sc.setValueAtTime(tt, sv); } catch (se) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_003", se); }
        }
      }
      if (doEase) {
        try { smoothMorphKeys(op); } catch (e1) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_004", e1); }
        if (opts.elasticity > 0) { try { smoothMorphKeys(sc); } catch (e2) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_005", e2); } }
      }

      // Liquid warp: Turbulent Displace amount is high while transitioning,
      // zero when the layer is fully visible (inverse of opacity).
      if (warpMax > 0) {
        try {
          var fx = layer.property("ADBE Effect Parade");
          var td = fx.addProperty("ADBE Turbulent Displace");
          var amt = td.property("ADBE Turbulent Displace-0001");
          for (var wi = 0; wi < kf.length; wi++) {
            try { amt.setValueAtTime(kf[wi][0], (1 - kf[wi][1] / 100) * warpMax); } catch (we2) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_006", we2); }
          }
          if (doEase) { try { smoothMorphKeys(amt); } catch (we3) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_007", we3); } }
          if (styleName === "gooey") { try { td.property("ADBE Turbulent Displace-0003").setValue(60); } catch (we4) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_008", we4); } }
        } catch (we) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_009", we); }
      }

      var winStart = kf[0][0], winEnd = kf[kf.length - 1][0];
      if (opts.trails) ae_morphAddTrails(layer, Number(opts.trailAmount) || 60);
      if (opts.slicer) ae_morphAddSlicer(layer, Number(opts.sliceCount) || 8, winStart, winEnd, doEase);
      try { layer.motionBlur = true; } catch (mbe) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_010", mbe); }
    }

    app.endUndoGroup();
    var extras = [];
    if (opts.trails) extras.push("trails");
    if (opts.slicer) extras.push("slicer");
    var extraStr = extras.length ? (" + " + extras.join(" + ")) : "";
    return toolResult(true, "Super Morph created: " + n + " object" + (n > 1 ? "s" : "") + " chained (" + styleName + ", " + dur + "s" + extraStr + ").");
  } catch (e) {
    try { app.endUndoGroup(); } catch (ee) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_011", ee); }
    return toolResult(false, "Super Morph failed: " + String(e));
  }
}


// CompX — Paste Feature (Global Scope Fallback)
// These functions MUST live at global scope so csInterface.evalScript() can find them.
// This file acts as a safety net if the main binary fails to register them.

$.global.CompX_getPasteImagePath = function() {
    try {
        var proj = app.project;
        var targetFolder = null;
        if (proj && proj.file) {
            var parentFolder = proj.file.parent;
            if (parentFolder) {
                targetFolder = new Folder(parentFolder.fsName + "/CompX Pasted");
            }
        }

        // Fallback 1: Desktop
        if (!targetFolder) {
            var desktop = Folder.desktop;
            if (desktop && desktop.exists) {
                targetFolder = new Folder(desktop.fsName + "/CompX Pasted");
            }
        }

        // Fallback 2: Documents
        if (!targetFolder) {
            var myDocuments = Folder.myDocuments;
            if (myDocuments && myDocuments.exists) {
                targetFolder = new Folder(myDocuments.fsName + "/CompX Pasted");
            }
        }

        // Fallback 3: Temporary folder (always exists)
        if (!targetFolder) {
            var temp = Folder.temp;
            if (temp) {
                targetFolder = new Folder(temp.fsName + "/CompX Pasted");
            }
        }

        if (!targetFolder) {
            return "ERR:Could not resolve a target folder for pasted images.";
        }

        if (!targetFolder.exists) {
            var created = targetFolder.create();
            if (!created) {
                targetFolder = Folder.temp;
            }
        }

        var randomNumber = Math.floor(100 + Math.random() * 9000);
        var targetPath = targetFolder.fsName + "/compx_img_" + randomNumber + ".png";
        return targetPath.replace(new RegExp("\\\\", "g"), "/");
    } catch (e) {
        return "ERR:getPasteImagePath failed: " + e.toString();
    }
}

$.global.CompX_getDownloadFolder = function() {
    var proj = app.project;
    var targetFolder;
    if (proj && proj.file) {
        var parentFolder = proj.file.parent;
        targetFolder = new Folder(parentFolder.fsName + "/CompX Downloads");
    } else {
        targetFolder = new Folder(Folder.desktop.fsName + "/CompX Downloads");
    }
    if (!targetFolder.exists) {
        targetFolder.create();
    }
    return targetFolder.fsName.replace(new RegExp("\\\\", "g"), "/");
}

$.global.CompX_selectDownloadFolder = function() {
    var picked = Folder.selectDialog("Choose Download Folder");
    if (picked) {
        return picked.fsName.replace(new RegExp("\\\\", "g"), "/");
    }
    return "";
}

$.global.CompX_pasteImageFromFile = function(filePath, appName, toShapes) {
    if (appName === "AEFT") {
        var item;
        var xfile = File(filePath);
        try {
            if (!xfile.exists) return "ERR: Source image does not exist: " + filePath;
            if (!app.project || !app.project.activeItem || !(app.project.activeItem instanceof CompItem)) {
                return "ERR: Open an active composition before importing an image or icon.";
            }
            app.beginUndoGroup("Paste Image");
            item = app.project.importFile(new ImportOptions(xfile));
            if (item && app.project.activeItem && app.project.activeItem instanceof CompItem) {
                var comp = app.project.activeItem;
                var sel = comp.selectedLayers;
                var newLayer = comp.layers.add(item);
                
                // Set Layer range to match selection if applicable
                if (sel.length > 0) {
                    var minIn = 99999, maxOut = -99999, topIndex = 99999;
                    for (var i = 0; i < sel.length; i++) {
                        if (sel[i].inPoint < minIn) minIn = sel[i].inPoint;
                        if (sel[i].outPoint > maxOut) maxOut = sel[i].outPoint;
                        if (sel[i].index < topIndex) topIndex = sel[i].index;
                    }
                    newLayer.inPoint = minIn;
                    newLayer.outPoint = maxOut;
                    newLayer.moveBefore(comp.layers[topIndex]);
                } else {
                    // With no reference selection, insert at the playhead.
                    try {
                        newLayer.startTime = comp.time;
                        newLayer.inPoint = comp.time;
                        newLayer.outPoint = comp.duration;
                    } catch (pasteTimingErr) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_002", pasteTimingErr); }
                }
                
                // Convert SVG to Shape Layer automatically if requested
                if (toShapes === true || toShapes === "true" || toShapes === 1 || toShapes === "1") {
                    for (var j = 1; j <= comp.numLayers; j++) {
                        comp.layer(j).selected = false;
                    }
                    newLayer.selected = true;
                    var cmdId = app.findMenuCommandId("Create Shapes from Vector Layer");
                    if (cmdId) {
                        app.executeCommand(cmdId);
                        try {
                            newLayer.remove();
                        } catch (remErr) { compxAuditFallback("HOST_AE_SUPERMORPHSMART_003", remErr); }
                    }
                }
            } else {
                app.endUndoGroup();
                return "ERR: After Effects imported no usable footage item.";
            }
            app.endUndoGroup();
            return "SUCCESS";
        } catch (e) {
            app.endUndoGroup();
            return "ERR: " + e.toString();
        }
    }
    return "Not AEFT";
}

$.global.CompX_alignLayers = function(directionModeStr) {
    var c = app.project.activeItem;
    if (!c || !(c instanceof CompItem) || c.selectedLayers.length < 1) return;

    // Local helper to get position value safely (handles separated dimensions)
    function getPos(l) {
        try {
            var tForm = l.property("ADBE Transform Group");
            var posProp = tForm.property("ADBE Position");
            if (posProp.dimensionsSeparated) {
                var x = tForm.property("ADBE Position X").value;
                var y = tForm.property("ADBE Position Y").value;
                var z = tForm.property("ADBE Position Z") ? tForm.property("ADBE Position Z").value : 0;
                return [x, y, z];
            } else {
                var val = posProp.value;
                return [val[0], val[1], val.length > 2 ? val[2] : 0];
            }
        } catch (e) {
            return [0, 0, 0];
        }
    }

    // Local helper to set position value safely (handles separated dimensions)
    function setPos(l, val) {
        try {
            var tForm = l.property("ADBE Transform Group");
            var posProp = tForm.property("ADBE Position");
            if (posProp.dimensionsSeparated) {
                tForm.property("ADBE Position X").setValue(val[0]);
                tForm.property("ADBE Position Y").setValue(val[1]);
                if (tForm.property("ADBE Position Z") && val.length > 2) {
                    tForm.property("ADBE Position Z").setValue(val[2]);
                }
            } else {
                posProp.setValue(val);
            }
        } catch (e) { compxAuditFallback("HOST_SETPOS_001", e); }
    }

    // Local helper to get composition (world) position of a layer using temporary expression
    function getLayerWorldPos(layer, time) {
        try {
            var tForm = layer.property("ADBE Transform Group");
            if (!tForm) return getPos(layer);
            var anchorProp = tForm.property("ADBE Anchor Point");
            if (!anchorProp) return getPos(layer);
            
            var hasExpr = anchorProp.expressionEnabled;
            var origExpr = anchorProp.expression;
            
            anchorProp.expression = "toComp(anchorPoint)";
            var val = anchorProp.valueAtTime(time, false);
            
            anchorProp.expression = origExpr;
            anchorProp.expressionEnabled = hasExpr;
            
            return [val[0], val[1], val.length > 2 ? val[2] : 0];
        } catch (e) {
            return getPos(layer);
        }
    }

    // Parse arguments: direction and alignment target
    var parts = directionModeStr.split("|");
    var direction = parts[0];
    var alignTo = parts.length > 1 ? parts[1] : "comp";

    app.beginUndoGroup("Align Layers " + direction);
    try {
        var layers = [];
        for (var i = 0; i < c.selectedLayers.length; i++) {
            var l = c.selectedLayers[i];
            if (l.property("ADBE Transform Group") && l.property("ADBE Transform Group").property("ADBE Position")) {
                layers.push(l);
            }
        }
        if (layers.length === 0) { app.endUndoGroup(); return; }
        if ((alignTo === "selection" || alignTo === "key") && layers.length < 2) alignTo = "comp";

        // Calculate target bounds based on mode
        var compLeft = 0;
        var compRight = c.width;
        var compTop = 0;
        var compBottom = c.height;
        var compCenterX = c.width / 2;
        var compCenterY = c.height / 2;

        if (alignTo === "selection" || alignTo === "key") {
            var minLeft = 999999;
            var maxRight = -999999;
            var minTop = 999999;
            var maxBottom = -999999;

            var refLayers = layers;
            // In key mode, the key object is the last selected layer
            if (alignTo === "key" && layers.length >= 1) {
                refLayers = [layers[layers.length - 1]];
            }

            for (var k = 0; k < refLayers.length; k++) {
                var rl = refLayers[k];
                var rRect = rl.sourceRectAtTime(c.time, false);
                var rTForm = rl.property("ADBE Transform Group");
                var rAnchor = rTForm.property("ADBE Anchor Point").value;
                var rScale = rTForm.property("ADBE Scale").value;
                var rPos = getPos(rl);

                // Calculate parent scales for reference layer
                var rParentScaleX = 1;
                var rParentScaleY = 1;
                var rp = rl.parent;
                while (rp) {
                    try {
                        var rpTForm = rp.property("ADBE Transform Group");
                        if (rpTForm) {
                            var rpScaleProp = rpTForm.property("ADBE Scale");
                            if (rpScaleProp) {
                                var rpScale = rpScaleProp.value;
                                rParentScaleX *= (rpScale[0] / 100);
                                rParentScaleY *= (rpScale[1] / 100);
                            }
                        }
                    } catch (parentScaleErr) { compxAuditFallback("HOST_GETLAYERWORLDPOS_001", parentScaleErr); }
                    rp = rp.parent;
                }

                var rEffScaleX = (rScale[0] / 100) * rParentScaleX;
                var rEffScaleY = (rScale[1] / 100) * rParentScaleY;

                var rWorldX, rWorldY;
                if (rl.parent) {
                    var rWorldPt = getLayerWorldPos(rl, c.time);
                    rWorldX = rWorldPt[0];
                    rWorldY = rWorldPt[1];
                } else {
                    rWorldX = rPos[0];
                    rWorldY = rPos[1];
                }

                var rLeft = rWorldX + (rRect.left - rAnchor[0]) * rEffScaleX;
                var rRight = rLeft + rRect.width * rEffScaleX;
                var rTop = rWorldY + (rRect.top - rAnchor[1]) * rEffScaleY;
                var rBottom = rTop + rRect.height * rEffScaleY;

                if (rLeft < minLeft) minLeft = rLeft;
                if (rRight > maxRight) maxRight = rRight;
                if (rTop < minTop) minTop = rTop;
                if (rBottom > maxBottom) maxBottom = rBottom;
            }

            if (minLeft !== 999999) {
                compLeft = minLeft;
                compRight = maxRight;
                compTop = minTop;
                compBottom = maxBottom;
                compCenterX = (compLeft + compRight) / 2;
                compCenterY = (compTop + compBottom) / 2;
            }
        }

        for (var j = 0; j < layers.length; j++) {
            var l = layers[j];
            // In key mode, skip moving the key layer itself
            if (alignTo === "key" && j === layers.length - 1) continue;

            var rect = l.sourceRectAtTime(c.time, false);
            var tForm = l.property("ADBE Transform Group");
            var pos = getPos(l);
            var anchor = tForm.property("ADBE Anchor Point").value;
            var scale = tForm.property("ADBE Scale").value;

            var parentScaleX = 1;
            var parentScaleY = 1;
            var p = l.parent;
            while (p) {
                try {
                    var pTForm = p.property("ADBE Transform Group");
                    if (pTForm) {
                        var pScaleProp = pTForm.property("ADBE Scale");
                        if (pScaleProp) {
                            var pScale = pScaleProp.value;
                            parentScaleX *= (pScale[0] / 100);
                            parentScaleY *= (pScale[1] / 100);
                        }
                    }
                } catch (parentScaleErr) { compxAuditFallback("HOST_GETLAYERWORLDPOS_002", parentScaleErr); }
                p = p.parent;
            }

            var effScaleX = (scale[0] / 100) * parentScaleX;
            var effScaleY = (scale[1] / 100) * parentScaleY;

            var worldX, worldY;
            if (l.parent) {
                var worldPt = getLayerWorldPos(l, c.time);
                worldX = worldPt[0];
                worldY = worldPt[1];
            } else {
                worldX = pos[0];
                worldY = pos[1];
            }

            var layerLeft = worldX + (rect.left - anchor[0]) * effScaleX;
            var layerRight = layerLeft + rect.width * effScaleX;
            var layerTop = worldY + (rect.top - anchor[1]) * effScaleY;
            var layerBottom = layerTop + rect.height * effScaleY;
            var layerCenterX = (layerLeft + layerRight) / 2;
            var layerCenterY = (layerTop + layerBottom) / 2;

            var deltaX = 0;
            var deltaY = 0;

            if (direction === "left") {
                deltaX = compLeft - layerLeft;
            } else if (direction === "center") {
                deltaX = compCenterX - layerCenterX;
            } else if (direction === "right") {
                deltaX = compRight - layerRight;
            } else if (direction === "top") {
                deltaY = compTop - layerTop;
            } else if (direction === "middle") {
                deltaY = compCenterY - layerCenterY;
            } else if (direction === "bottom") {
                deltaY = compBottom - layerBottom;
            }

            if (l.parent) {
                var localDeltaX = deltaX / parentScaleX;
                var localDeltaY = deltaY / parentScaleY;
                setPos(l, [
                    pos[0] + localDeltaX,
                    pos[1] + localDeltaY,
                    pos.length > 2 ? pos[2] : 0
                ]);
            } else {
                setPos(l, [
                    pos[0] + deltaX,
                    pos[1] + deltaY,
                    pos.length > 2 ? pos[2] : 0
                ]);
            }
        }
    } catch (e) {
        app.endUndoGroup();
        return "ERR:" + e.toString();
    }
    app.endUndoGroup();
    return "SUCCESS";
}

// Disabled fallback retained for future testing. The stable 6.6.x implementation above
// must remain the active global command because it is the proven cross-version AE path.
$.global.CompX_alignLayers_v2_disabled = function (directionModeStr) {

    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) return "ERR:Open a composition first.";
    if (!comp.selectedLayers || comp.selectedLayers.length < 1) return "ERR:Select at least one layer.";

    var parts = String(directionModeStr || "").split("|");
    var direction = parts[0] || "";
    var alignTo = parts.length > 1 ? parts[1] : "comp";
    if (direction !== "left" && direction !== "center" && direction !== "right" && direction !== "top" && direction !== "middle" && direction !== "bottom") {
        return "ERR:Unknown alignment direction.";
    }
    if (alignTo !== "comp" && alignTo !== "selection" && alignTo !== "key") alignTo = "comp";

    function valueNow(prop) {
        try { return prop.valueAtTime(comp.time, false); } catch (e) { return prop.value; }
    }

    function setNow(prop, value) {
        if (!prop) return false;
        try {
            if (prop.numKeys && prop.numKeys > 0) prop.setValueAtTime(comp.time, value);
            else prop.setValue(value);
            return true;
        } catch (e) { return false; }
    }

    function getPosition(layer) {
        var transform = layer.property("ADBE Transform Group");
        var position = transform ? transform.property("ADBE Position") : null;
        if (!position) return null;
        if (position.dimensionsSeparated) {
            var xProp = transform.property("ADBE Position X");
            var yProp = transform.property("ADBE Position Y");
            var zProp = transform.property("ADBE Position Z");
            return [valueNow(xProp), valueNow(yProp), zProp ? valueNow(zProp) : 0];
        }
        var value = valueNow(position);
        return [value[0], value[1], value.length > 2 ? value[2] : 0];
    }

    function setPosition(layer, value) {
        var transform = layer.property("ADBE Transform Group");
        var position = transform ? transform.property("ADBE Position") : null;
        if (!position) return false;
        if (position.dimensionsSeparated) {
            var okX = setNow(transform.property("ADBE Position X"), value[0]);
            var okY = setNow(transform.property("ADBE Position Y"), value[1]);
            var zProp = transform.property("ADBE Position Z");
            if (zProp) setNow(zProp, value[2]);
            return okX && okY;
        }
        var original = valueNow(position);
        if (original.length > 2) return setNow(position, [value[0], value[1], value[2]]);
        return setNow(position, [value[0], value[1]]);
    }

    function pointToComp(layer, point) {
        try {
            var result = layer.sourcePointToComp([point[0], point[1]]);
            if (result && result.length >= 2) return [result[0], result[1]];
        } catch (e) { compxAuditFallback("HOST_POINTTOCOMP_001", e); }
        try {
            var transform = layer.property("ADBE Transform Group");
            var anchor = valueNow(transform.property("ADBE Anchor Point"));
            var scale = valueNow(transform.property("ADBE Scale"));
            var position = getPosition(layer);
            if (position) return [position[0] + (point[0] - anchor[0]) * scale[0] / 100, position[1] + (point[1] - anchor[1]) * scale[1] / 100];
        } catch (fallbackError) { compxAuditFallback("HOST_POINTTOCOMP_002", fallbackError); }
        return null;
    }

    function getBounds(layer) {
        var transform = layer.property("ADBE Transform Group");
        if (!transform) return null;
        var anchorProp = transform.property("ADBE Anchor Point");
        var anchor = anchorProp ? valueNow(anchorProp) : [0, 0, 0];
        var rect = null;
        try { rect = layer.sourceRectAtTime(comp.time, false); } catch (e) { rect = null; }

        var points = [];
        if (rect && isFinite(rect.left) && isFinite(rect.top) && isFinite(rect.width) && isFinite(rect.height)) {
            points.push([rect.left, rect.top, 0]);
            points.push([rect.left + rect.width, rect.top, 0]);
            points.push([rect.left, rect.top + rect.height, 0]);
            points.push([rect.left + rect.width, rect.top + rect.height, 0]);
        } else {
            points.push([anchor[0], anchor[1], anchor.length > 2 ? anchor[2] : 0]);
        }

        var minX = 999999999;
        var maxX = -999999999;
        var minY = 999999999;
        var maxY = -999999999;
        for (var i = 0; i < points.length; i++) {
            var compPoint = pointToComp(layer, points[i]);
            if (!compPoint) continue;
            if (compPoint[0] < minX) minX = compPoint[0];
            if (compPoint[0] > maxX) maxX = compPoint[0];
            if (compPoint[1] < minY) minY = compPoint[1];
            if (compPoint[1] > maxY) maxY = compPoint[1];
        }

        if (minX === 999999999) {
            var position = getPosition(layer);
            if (!position) return null;
            minX = maxX = position[0];
            minY = maxY = position[1];
        }
        return { left: minX, right: maxX, top: minY, bottom: maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 };
    }

    function unionBounds(layers) {
        var result = null;
        for (var i = 0; i < layers.length; i++) {
            var bounds = getBounds(layers[i]);
            if (!bounds) continue;
            if (!result) result = { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
            else {
                if (bounds.left < result.left) result.left = bounds.left;
                if (bounds.right > result.right) result.right = bounds.right;
                if (bounds.top < result.top) result.top = bounds.top;
                if (bounds.bottom > result.bottom) result.bottom = bounds.bottom;
            }
        }
        if (result) {
            result.centerX = (result.left + result.right) / 2;
            result.centerY = (result.top + result.bottom) / 2;
        }
        return result;
    }

    function compDeltaToPositionDelta(layer, deltaX, deltaY) {
        if (!layer.parent) return [deltaX, deltaY];
        try {
            var transform = layer.property("ADBE Transform Group");
            var anchorProp = transform ? transform.property("ADBE Anchor Point") : null;
            var anchor = anchorProp ? valueNow(anchorProp) : [0, 0, 0];
            var worldAnchor = pointToComp(layer, anchor);
            var localA = layer.parent.compPointToSource([worldAnchor[0], worldAnchor[1]]);
            var localB = layer.parent.compPointToSource([worldAnchor[0] + deltaX, worldAnchor[1] + deltaY]);
            return [localB[0] - localA[0], localB[1] - localA[1]];
        } catch (e) { return [deltaX, deltaY]; }
    }

    var layers = [];
    for (var i = 0; i < comp.selectedLayers.length; i++) {
        var selected = comp.selectedLayers[i];
        if (!selected.locked && getPosition(selected)) layers.push(selected);
    }
    if (layers.length < 1) return "ERR:No movable selected layers.";
    if (alignTo === "key" && layers.length < 2) return "ERR:Select at least two layers for Key Object alignment.";

    var keyLayer = alignTo === "key" ? layers[layers.length - 1] : null;
    var target = null;
    if (alignTo === "comp") {
        target = { left: 0, right: comp.width, top: 0, bottom: comp.height, centerX: comp.width / 2, centerY: comp.height / 2 };
    } else if (alignTo === "key") {
        target = getBounds(keyLayer);
    } else {
        target = unionBounds(layers);
    }
    if (!target) return "ERR:Unable to calculate alignment bounds.";

    var moved = 0;
    app.beginUndoGroup("CompX Align Layers");
    try {
        for (var j = 0; j < layers.length; j++) {
            var layer = layers[j];
            if (layer === keyLayer) continue;
            var bounds = getBounds(layer);
            var position = getPosition(layer);
            if (!bounds || !position) continue;

            var dx = 0;
            var dy = 0;
            if (direction === "left") dx = target.left - bounds.left;
            else if (direction === "center") dx = target.centerX - bounds.centerX;
            else if (direction === "right") dx = target.right - bounds.right;
            else if (direction === "top") dy = target.top - bounds.top;
            else if (direction === "middle") dy = target.centerY - bounds.centerY;
            else if (direction === "bottom") dy = target.bottom - bounds.bottom;

            var localDelta = compDeltaToPositionDelta(layer, dx, dy);
            if (setPosition(layer, [position[0] + localDelta[0], position[1] + localDelta[1], position[2]])) moved++;
        }
    } catch (error) {
        try { app.endUndoGroup(); } catch (endError) { compxAuditFallback("HOST_COMPDELTATOPOSITIONDELTA_001", endError); }
        return "ERR:" + error.toString();
    }
    // In some AE builds the layer controls update before the cached comp pixels.
    // Re-assigning the current time invalidates that stale frame without moving the CTI.
    try { comp.time = comp.time; } catch (refreshError) { compxAuditFallback("HOST_COMPDELTATOPOSITIONDELTA_002", refreshError); }
    app.endUndoGroup();
    return "SUCCESS:" + moved;
};


/* CompX Curve Engine — isolated from every other CEP extension.
   Safe to evaluate multiple times. ExtendScript ES3 only. */

(function () {
    var engine = null;
    try { engine = $.global.CompXCurveEngine; } catch (eCurve) { compxAuditFallback("HOST_COMPDELTATOPOSITIONDELTA_003", eCurve); }
    if (!engine) { $.global.CompXCurveEngine = {}; engine = $.global.CompXCurveEngine; }
    if (engine.engineVersion && engine.engineVersion >= 2) return;
    engine.engineVersion = 2;

    /* ───────────────────────────────────────────────────────────────────
       CompX Curve 2.0 engine — powers the rebuilt Graph Editor 2.0 panel.
       Payload: model|graphMode|invert|paramsCSV|pointsList
       points: x,y,cx1,cy1,cx2,cy2;... (absolute normalized coords)      */

    engine.fx20Stretch = function (prop) {
        var stretch = 1.0;
        try {
            var lyr = prop.propertyGroup(prop.propertyDepth);
            if (lyr && lyr.stretch !== undefined) stretch = lyr.stretch / 100.0;
        } catch (stretchErr) { compxAuditFallback("HOST_COMPDELTATOPOSITIONDELTA_004", stretchErr); }
        if (isNaN(stretch) || stretch <= 0) stretch = 1.0;
        return stretch;
    };

    engine.fx20SelectedProps = function (comp) {
        var out = [];
        var sel = comp.selectedProperties;
        if (!sel) return out;
        for (var i = 0; i < sel.length; i++) {
            var p = sel[i];
            try {
                if (p.propertyType === PropertyType.PROPERTY && p.numKeys && p.numKeys > 0 && p.canVaryOverTime) out.push(p);
            } catch (selErr) { compxAuditFallback("HOST_COMPDELTATOPOSITIONDELTA_005", selErr); }
        }
        return out;
    };

    engine.fx20KeyRange = function (prop) {
        var first = -1, last = -1;
        var keys = prop.selectedKeys;
        if (keys && keys.length) {
            first = keys[0];
            last = keys[keys.length - 1];
            for (var i = 0; i < keys.length; i++) {
                if (keys[i] < first) first = keys[i];
                if (keys[i] > last) last = keys[i];
            }
        }
        if (first === -1) return null;
        return { first: first, last: last };
    };

    engine.fx20DimInfo = function (prop) {
        var vt = prop.propertyValueType;
        var info = { spatial: false, single: false, dim: 1 };
        if (vt === PropertyValueType.TwoD_SPATIAL || vt === PropertyValueType.ThreeD_SPATIAL) {
            info.spatial = true;
            info.single = true;
        } else if (vt === PropertyValueType.COLOR || vt === PropertyValueType.SHAPE || vt === PropertyValueType.CUSTOM_VALUE) {
            info.single = true;
        }
        if (!info.single) {
            try {
                var v = prop.keyValue(1);
                if (v !== undefined && v.length !== undefined) info.dim = v.length;
            } catch (dimErr) { compxAuditFallback("HOST_COMPDELTATOPOSITIONDELTA_006", dimErr); }
        }
        return info;
    };

    engine.fx20Delta = function (prop, kA, kB, d, info) {
        // Per-dimension value delta between two keys; 1.0 for unreadable types.
        try {
            var vt = prop.propertyValueType;
            if (vt === PropertyValueType.COLOR || vt === PropertyValueType.SHAPE || vt === PropertyValueType.CUSTOM_VALUE) return 1.0;
            var v1 = prop.keyValue(kA);
            var v2 = prop.keyValue(kB);
            if (info.spatial) {
                var dx = v2[0] - v1[0];
                var dy = v2[1] - v1[1];
                var dz = (v1.length === 3) ? (v2[2] - v1[2]) : 0;
                return Math.sqrt(dx * dx + dy * dy + dz * dz);
            }
            if (v1 !== undefined && v1.length !== undefined) return v2[d] - v1[d];
            return v2 - v1;
        } catch (deltaErr) { compxAuditFallback("HOST_COMPDELTATOPOSITIONDELTA_007", deltaErr); }
        return 1.0;
    };

    engine.curve20Apply = function (dataStr) {
        var parts = String(dataStr || "").split("|");
        var model = parts[0] || "bezier";
        var graphMode = parts[1] || "ease";
        var inverted = parts[2] === "1";
        var paramBits = (parts[3] || "").split(",");
        var pointBits = (parts[4] || "").split(";");
        var i, j, d, k;

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "ERR: Open a composition first.";
        var props = this.fx20SelectedProps(comp);
        if (!props.length) return "ERR: Select a property with keyframes first.";

        function num(v, fallback) {
            var n = parseFloat(v);
            return isNaN(n) ? fallback : n;
        }

        // Parse custom points; fall back to a plain linear pair.
        var pts = [];
        for (i = 0; i < pointBits.length; i++) {
            var pieces = String(pointBits[i] || "").split(",");
            if (pieces.length >= 6) {
                var pt = {
                    x: num(pieces[0], 0), y: num(pieces[1], 0),
                    cx1: num(pieces[2], 0), cy1: num(pieces[3], 0),
                    cx2: num(pieces[4], 0), cy2: num(pieces[5], 0)
                };
                pts.push(pt);
            }
        }
        if (model === "bezier") {
            var bz = {
                p1x: Math.max(0.001, Math.min(0.999, num(paramBits[0], 0.42))),
                p1y: num(paramBits[1], 0),
                p2x: Math.max(0.001, Math.min(0.999, num(paramBits[2], 0.58))),
                p2y: num(paramBits[3], 1)
            };
            if (inverted) {
                bz = {
                    p1x: Math.max(0.001, Math.min(0.999, 1 - num(paramBits[2], 0.58))),
                    p1y: 1 - num(paramBits[3], 1),
                    p2x: Math.max(0.001, Math.min(0.999, 1 - num(paramBits[0], 0.42))),
                    p2y: 1 - num(paramBits[1], 0)
                };
            }
            pts = [
                { x: 0, y: 0, cx1: 0, cy1: 0, cx2: bz.p1x, cy2: bz.p1y },
                { x: 1, y: 1, cx1: bz.p2x, cy1: bz.p2y, cx2: 1, cy2: 1 }
            ];
        } else if (model === "custom" && inverted && pts.length >= 2) {
            var mirrored = [];
            for (i = pts.length - 1; i >= 0; i--) {
                mirrored.push({
                    x: 1 - pts[i].x, y: 1 - pts[i].y,
                    cx1: 1 - pts[i].cx2, cy1: 1 - pts[i].cy2,
                    cx2: 1 - pts[i].cx1, cy2: 1 - pts[i].cy1
                });
            }
            pts = mirrored;
        }

        var self = this;
        var applied = 0;
        var pairApplied = 0;
        var unsupported = 0;

        /* ── temporal-ease writer shared by bezier + custom bake ── */
        function easeKeysFromPoints(prop, keyIdx, ptIdx, duration, totalFirst, totalLast) {
            var info = self.fx20DimInfo(prop);
            var stretch = self.fx20Stretch(prop);
            var n = pts.length;
            var p = pts[ptIdx];
            var easeIn = [], easeOut = [];
            var existingIn = prop.keyInTemporalEase(keyIdx);
            var existingOut = prop.keyOutTemporalEase(keyIdx);

            var inInf = 33.33, outInf = 33.33;
            var inSlope = 0, outSlope = 0;
            if (ptIdx > 0) {
                var segDurIn = Math.max(0.0001, p.x - pts[ptIdx - 1].x);
                var dxIn = Math.max(0.001, Math.abs(p.x - p.cx1));
                inInf = Math.max(0.1, Math.min(99, dxIn / segDurIn * 100));
                inSlope = (p.y - p.cy1) / dxIn;
            }
            if (ptIdx < n - 1) {
                var segDurOut = Math.max(0.0001, pts[ptIdx + 1].x - p.x);
                var dxOut = Math.max(0.001, Math.abs(p.cx2 - p.x));
                outInf = Math.max(0.1, Math.min(99, dxOut / segDurOut * 100));
                outSlope = (p.cy2 - p.y) / dxOut;
            }

            var dims = info.single ? 1 : info.dim;
            for (d = 0; d < dims; d++) {
                var totalDelta = self.fx20Delta(prop, totalFirst, totalLast, d, info);
                var speedIn = inSlope * totalDelta / Math.max(0.0001, duration) * stretch;
                var speedOut = outSlope * totalDelta / Math.max(0.0001, duration) * stretch;
                if (info.spatial) { speedIn = Math.abs(speedIn); speedOut = Math.abs(speedOut); }
                if (ptIdx === 0) {
                    var ein = existingIn.length > d ? existingIn[d] : existingIn[0];
                    easeIn.push(new KeyframeEase(ein.speed, Math.max(0.1, Math.min(100, ein.influence))));
                } else {
                    easeIn.push(new KeyframeEase(speedIn, inInf));
                }
                if (ptIdx === n - 1) {
                    var eout = existingOut.length > d ? existingOut[d] : existingOut[0];
                    easeOut.push(new KeyframeEase(eout.speed, Math.max(0.1, Math.min(100, eout.influence))));
                } else {
                    easeOut.push(new KeyframeEase(speedOut, outInf));
                }
            }
            prop.setInterpolationTypeAtKey(keyIdx, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            try { prop.setTemporalAutoBezierAtKey(keyIdx, false); } catch (autoErr) { compxAuditFallback("HOST_EASEKEYSFROMPOINTS_001", autoErr); }
            try { prop.setTemporalContinuousAtKey(keyIdx, false); } catch (contErr) { compxAuditFallback("HOST_EASEKEYSFROMPOINTS_002", contErr); }
            prop.setTemporalEaseAtKey(keyIdx, easeIn, easeOut);
        }

        /* ── pairwise bezier ease across every adjacent selected pair ── */
        function applyBezierEase(prop) {
            var keys = prop.selectedKeys;
            if (!keys || !keys.length) return;
            var info = self.fx20DimInfo(prop);
            var stretch = self.fx20Stretch(prop);
            var p1 = pts[0], p2 = pts[1];
            var infOut = Math.max(0.1, Math.min(100, p1.cx2 * 100));
            var infIn = Math.max(0.1, Math.min(100, (1 - p2.cx1) * 100));

            var isSel = {};
            for (i = 0; i < keys.length; i++) isSel[keys[i]] = true;

            for (i = 0; i < keys.length; i++) {
                k = keys[i];
                var prevSel = (k > 1 && isSel[k - 1]);
                var nextSel = (k < prop.numKeys && isSel[k + 1]);
                if (!prevSel && !nextSel) continue;

                var existingIn = prop.keyInTemporalEase(k);
                var existingOut = prop.keyOutTemporalEase(k);
                var easeIn = [], easeOut = [];
                var dims = info.single ? 1 : info.dim;

                for (d = 0; d < dims; d++) {
                    if (prevSel) {
                        var dtIn = prop.keyTime(k) - prop.keyTime(k - 1);
                        var dvIn = self.fx20Delta(prop, k - 1, k, d, info);
                        var speedIn = 0;
                        if (dtIn > 0) speedIn = ((1 - p2.cy1) / (1 - p2.cx1)) * (dvIn / dtIn) * stretch;
                        if (info.spatial) speedIn = Math.abs(speedIn);
                        easeIn.push(new KeyframeEase(speedIn, infIn));
                    } else {
                        var ein = existingIn.length > d ? existingIn[d] : existingIn[0];
                        easeIn.push(new KeyframeEase(ein.speed, Math.max(0.1, Math.min(100, ein.influence))));
                    }
                    if (nextSel) {
                        var dtOut = prop.keyTime(k + 1) - prop.keyTime(k);
                        var dvOut = self.fx20Delta(prop, k, k + 1, d, info);
                        var speedOut = 0;
                        if (dtOut > 0) speedOut = (p1.cy2 / p1.cx2) * (dvOut / dtOut) * stretch;
                        if (info.spatial) speedOut = Math.abs(speedOut);
                        easeOut.push(new KeyframeEase(speedOut, infOut));
                    } else {
                        var eout = existingOut.length > d ? existingOut[d] : existingOut[0];
                        easeOut.push(new KeyframeEase(eout.speed, Math.max(0.1, Math.min(100, eout.influence))));
                    }
                }
                prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
                try { prop.setTemporalAutoBezierAtKey(k, false); } catch (autoErr2) { compxAuditFallback("HOST_APPLYBEZIEREASE_001", autoErr2); }
                try { prop.setTemporalContinuousAtKey(k, false); } catch (contErr2) { compxAuditFallback("HOST_APPLYBEZIEREASE_002", contErr2); }
                prop.setTemporalEaseAtKey(k, easeIn, easeOut);
                applied++;
                if (nextSel) pairApplied++;
            }
        }

        /* ── custom spline baked into real keys ── */
        function applyCustomBake(prop) {
            var vt = prop.propertyValueType;
            if (vt === PropertyValueType.CUSTOM_VALUE) { unsupported++; return; }
            var range = self.fx20KeyRange(prop);
            if (!range || range.first === range.last) return;
            var t1 = prop.keyTime(range.first);
            var t2 = prop.keyTime(range.last);
            var duration = t2 - t1;
            if (duration <= 0) return;
            var v1 = prop.keyValue(range.first);
            var v2 = prop.keyValue(range.last);
            var isArr = (v1 !== undefined && v1.length !== undefined && vt !== PropertyValueType.SHAPE);
            var isShape = (vt === PropertyValueType.SHAPE);

            function valueAtY(y) {
                if (isShape) return null;
                if (isArr) {
                    var out = [];
                    for (var dd = 0; dd < v1.length; dd++) out.push(v1[dd] + (v2[dd] - v1[dd]) * y);
                    return out;
                }
                return v1 + (v2 - v1) * y;
            }

            // Rebuild interior keys deterministically.
            for (k = range.last - 1; k > range.first; k--) prop.removeKey(k);

            var interior = 0;
            for (i = 1; i < pts.length - 1; i++) {
                var tTime = t1 + pts[i].x * duration;
                var val = valueAtY(pts[i].y);
                if (val === null) continue;
                var idx = prop.addKey(tTime);
                prop.setValueAtKey(idx, val);
                interior++;
            }

            // Locate the rebuilt run and ease every key from its handles.
            var firstIdx = -1, lastIdx = -1;
            for (k = 1; k <= prop.numKeys; k++) {
                if (Math.abs(prop.keyTime(k) - t1) < 0.0001) firstIdx = k;
                if (Math.abs(prop.keyTime(k) - t2) < 0.0001) lastIdx = k;
            }
            if (firstIdx === -1 || lastIdx === -1) return;
            var runLen = lastIdx - firstIdx + 1;
            for (k = firstIdx; k <= lastIdx; k++) {
                var ptIdx = k - firstIdx;
                if (ptIdx >= pts.length) ptIdx = pts.length - 1;
                if (isShape && runLen !== pts.length) break;
                try {
                    easeKeysFromPoints(prop, k, ptIdx, duration, firstIdx, lastIdx);
                } catch (easeErr) { compxAuditFallback("HOST_VALUEATY_001", easeErr); }
            }
            for (k = firstIdx; k <= lastIdx; k++) {
                try { prop.setSelectedAtKey(k, true); } catch (selErr2) { compxAuditFallback("HOST_VALUEATY_002", selErr2); }
            }
            applied += runLen;
            pairApplied++;
        }

        /* ── hold-key staircase ── */
        function applySteps(prop) {
            var vt = prop.propertyValueType;
            if (vt === PropertyValueType.CUSTOM_VALUE) { unsupported++; return; }
            var range = self.fx20KeyRange(prop);
            if (!range || range.first === range.last) return;
            var stepCount = Math.max(2, Math.round(num(paramBits[0], 8)));
            var posCode = Math.round(num(paramBits[1], 0));
            var t1 = prop.keyTime(range.first);
            var t2 = prop.keyTime(range.last);
            var duration = t2 - t1;
            if (duration <= 0) return;
            var v1 = prop.keyValue(range.first);
            var v2 = prop.keyValue(range.last);
            var isArr = (v1 !== undefined && v1.length !== undefined && vt !== PropertyValueType.SHAPE);
            var isShape = (vt === PropertyValueType.SHAPE);
            if (isShape) { unsupported++; return; }

            for (k = range.last - 1; k > range.first; k--) prop.removeKey(k);
            prop.setInterpolationTypeAtKey(range.first, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);

            // Inverting a staircase swaps leading and trailing steps.
            var effPos = posCode;
            if (inverted && posCode === 0) effPos = 1;
            else if (inverted && posCode === 1) effPos = 0;

            for (var s = 1; s < stepCount; s++) {
                var valFraction = (effPos === 1) ? Math.min(1, (s + 1) / stepCount) : s / stepCount;
                var fraction = (effPos === 2) ? (s - 0.5) / stepCount : s / stepCount;
                var val;
                if (isArr) {
                    val = [];
                    for (d = 0; d < v1.length; d++) val.push(v1[d] + (v2[d] - v1[d]) * valFraction);
                } else {
                    val = v1 + (v2 - v1) * valFraction;
                }
                var tTime = t1 + fraction * duration;
                var idx = prop.addKey(tTime);
                prop.setValueAtKey(idx, val);
                prop.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
                applied++;
            }
            pairApplied++;
        }

        /* ── expression writer for procedural models ── */
        function exprBody(t1Idx, t2Idx) {
            var inv = inverted ? "true" : "false";
            var head = "// CompX Curve 2.0 — " + model + "\n" +
                "var i1 = " + t1Idx + ";\n" +
                "var i2 = " + t2Idx + ";\n" +
                "if (numKeys < i2) value; else {\n" +
                "var t1 = key(i1).time, t2 = key(i2).time;\n" +
                "if (time < t1 || time > t2) value; else {\n" +
                "var t = Math.max(0, Math.min(1, (time - t1) / (t2 - t1)));\n" +
                "if (" + inv + ") t = 1 - t;\n";
            var mid = "";
            if (model === "elastic") {
                var amp = num(paramBits[0], 1), freq = num(paramBits[1], 3), decay = num(paramBits[2], 4);
                mid = "var amp = " + amp.toFixed(5) + ", freq = " + freq.toFixed(5) + ", decay = " + decay.toFixed(5) + ";\n" +
                    "var w = Math.exp(-decay);\n" +
                    "var err0 = 1 - amp;\n" +
                    "var err1 = -amp * w * Math.cos(freq * Math.PI * 2);\n" +
                    "var raw = 1 - amp * Math.exp(-decay * t) * Math.cos(freq * Math.PI * 2 * t);\n" +
                    "var eased = raw - (err0 * Math.exp(-2.5 * decay * t) * (1 - t) + err1 * t);\n";
            } else if (model === "bounce") {
                var bounces = Math.round(num(paramBits[0], 3)), stiff = num(paramBits[1], 0.6);
                mid = "var segs = " + (bounces + 1) + ";\n" +
                    "var stiff = " + stiff.toFixed(5) + ";\n" +
                    "var seg = Math.min(Math.floor(t * segs), segs - 1);\n" +
                    "var eased;\n" +
                    "if (seg == 0) { var lt = t * segs; eased = lt * lt; }\n" +
                    "else { var segMid = (seg + 0.5) / segs; var nt = (t - segMid) / (0.5 / segs); eased = 1 - Math.pow(stiff, seg) * (1 - nt * nt); }\n";
            } else if (model === "wave") {
                var wf = num(paramBits[0], 3), wd = num(paramBits[1], 2), ws = num(paramBits[2], 0);
                mid = "var freq = " + wf.toFixed(5) + ", decay = " + wd.toFixed(5) + ", sharp = " + ws.toFixed(5) + ";\n" +
                    "var phase = t * freq;\n" +
                    "var sig = Math.sin(phase * Math.PI * 2 - Math.PI / 2);\n" +
                    "var sm = 0.5 + 0.5 * sig;\n" +
                    "var tr = Math.abs(((phase + 0.5) % 1) * 2 - 1);\n" +
                    "var osc;\n" +
                    "if (sharp > 0) osc = sm + (tr - sm) * sharp;\n" +
                    "else { var expo = 1 / (1 + Math.abs(sharp)); var shaped = (sig < 0 ? -1 : 1) * Math.pow(Math.abs(sig), expo); osc = 0.5 + 0.5 * shaped; }\n" +
                    "var eased = 0.5 + (osc - 0.5) * Math.exp(-decay * t);\n";
            } else {
                var lit = "[";
                for (i = 0; i < pts.length; i++) {
                    lit += "[" + pts[i].x.toFixed(5) + "," + pts[i].y.toFixed(5) + "," +
                        pts[i].cx1.toFixed(5) + "," + pts[i].cy1.toFixed(5) + "," +
                        pts[i].cx2.toFixed(5) + "," + pts[i].cy2.toFixed(5) + "]";
                    if (i < pts.length - 1) lit += ",";
                }
                lit += "]";
                mid = "var pts = " + lit + ";\n" +
                    "var seg = 0;\n" +
                    "while (seg < pts.length - 2 && t > pts[seg + 1][0]) seg++;\n" +
                    "var p0 = pts[seg], p3 = pts[seg + 1];\n" +
                    "var dx = p3[0] - p0[0];\n" +
                    "var eased;\n" +
                    "if (dx <= 1e-6) eased = p3[1];\n" +
                    "else {\n" +
                    "var lx = (t - p0[0]) / dx;\n" +
                    "var nx1 = (p0[4] - p0[0]) / dx, nx2 = (p3[2] - p0[0]) / dx;\n" +
                    "var lo = 0, hi = 1, bt = lx;\n" +
                    "for (var jj = 0; jj < 14; jj++) {\n" +
                    "var mt = 1 - bt;\n" +
                    "var bx = 3 * mt * mt * bt * nx1 + 3 * mt * bt * bt * nx2 + bt * bt * bt;\n" +
                    "if (Math.abs(bx - lx) < 0.0005) break;\n" +
                    "if (bx < lx) lo = bt; else hi = bt;\n" +
                    "bt = (lo + hi) / 2;\n" +
                    "}\n" +
                    "var bmt = 1 - bt;\n" +
                    "eased = bmt * bmt * bmt * p0[1] + 3 * bmt * bmt * bt * p0[5] + 3 * bmt * bt * bt * p3[3] + bt * bt * bt * p3[1];\n" +
                    "}\n";
            }
            var tail = "if (" + inv + ") eased = 1 - eased;\n" +
                "try {\n" +
                "var v1 = key(i1).value, v2 = key(i2).value;\n" +
                "if (v1 instanceof Array) { var rr = []; for (var ci = 0; ci < v1.length; ci++) rr.push(v1[ci] + (v2[ci] - v1[ci]) * eased); rr; }\n" +
                "else if (typeof v1 === 'object' && v1.points) {\n" +
                "var pA = v1.points(), pB = v2.points();\n" +
                "if (pA.length === pB.length) {\n" +
                "var iA = v1.inTangents(), iB = v2.inTangents();\n" +
                "var oA = v1.outTangents(), oB = v2.outTangents();\n" +
                "var pp = [], it = [], ot = [];\n" +
                "for (var ci = 0; ci < pA.length; ci++) {\n" +
                "pp.push(pA[ci] + (pB[ci] - pA[ci]) * eased);\n" +
                "it.push(iA[ci] + (iB[ci] - iA[ci]) * eased);\n" +
                "ot.push(oA[ci] + (oB[ci] - oA[ci]) * eased);\n" +
                "}\n" +
                "createPath(pp, it, ot, v1.isClosed());\n" +
                "} else { valueAtTime(t1 + (t2 - t1) * eased); }\n" +
                "}\n" +
                "else { v1 + (v2 - v1) * eased; }\n" +
                "} catch (e) { valueAtTime(t1 + (t2 - t1) * eased); }\n" +
                "}\n}";
            return head + mid + tail;
        }

        function applyExpression(prop) {
            var vt = prop.propertyValueType;
            if (vt === PropertyValueType.CUSTOM_VALUE) { unsupported++; return; }
            var range = self.fx20KeyRange(prop);
            if (!range || range.first === range.last) return;
            if (!prop.canSetExpression) return;
            prop.expression = exprBody(range.first, range.last);
            applied++;
            pairApplied++;
        }

        app.beginUndoGroup("CompX Curve 2.0: " + model);
        try {
            for (j = 0; j < props.length; j++) {
                try {
                    if (model === "bezier") applyBezierEase(props[j]);
                    else if (model === "custom" && graphMode === "bake") applyCustomBake(props[j]);
                    else if (model === "custom") applyExpression(props[j]);
                    else if (model === "steps") applySteps(props[j]);
                    else applyExpression(props[j]);
                } catch (propErr) { compxAuditFallback("HOST_APPLYEXPRESSION_001", propErr); }
            }
        } catch (applyErr) {
            app.endUndoGroup();
            return "ERR: " + applyErr.toString();
        }
        app.endUndoGroup();

        if (pairApplied === 0) {
            if (unsupported > 0) return "ERR: That property type only supports the Bezier model.";
            return model === "bezier"
                ? "ERR: Select at least two adjacent keyframes on a property."
                : "ERR: Select two or more keyframes to shape between.";
        }
        if (model === "elastic" || model === "bounce" || model === "wave" || (model === "custom" && graphMode === "expr")) {
            return "SUCCESS: " + model.charAt(0).toUpperCase() + model.slice(1) + " expression driving " + pairApplied + " propert" + (pairApplied === 1 ? "y" : "ies") + ".";
        }
        return "SUCCESS: Curve applied to " + applied + " key" + (applied === 1 ? "" : "s") + ".";
    };

    engine.curve20Read = function () {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "ERR: Open a composition first.";
        var props = this.fx20SelectedProps(comp);
        var prop = null;
        var i, k;
        for (i = 0; i < props.length; i++) {
            if (props[i].numKeys >= 2) { prop = props[i]; break; }
        }
        if (!prop) return "ERR: Select a property with at least two keyframes.";

        var selKeys = [];
        var rawSel = prop.selectedKeys;
        if (rawSel) for (i = 0; i < rawSel.length; i++) selKeys.push(rawSel[i]);
        selKeys.sort(function (a, b) { return a - b; });

        if (selKeys.length === 1) {
            k = selKeys[0];
            if (k > 1 && k < prop.numKeys) selKeys = [k - 1, k, k + 1];
            else if (k === 1) selKeys = [1, 2];
            else selKeys = [k - 1, k];
        }
        if (selKeys.length < 2) {
            selKeys = [];
            for (k = 1; k <= prop.numKeys; k++) selKeys.push(k);
        }

        var kFirst = selKeys[0];
        var kLast = selKeys[selKeys.length - 1];
        var t1 = prop.keyTime(kFirst);
        var t2 = prop.keyTime(kLast);
        var duration = t2 - t1;
        if (duration <= 0) return "ERR: Selected keyframes have no duration.";

        var info = this.fx20DimInfo(prop);
        var vt = prop.propertyValueType;
        var unreadable = (vt === PropertyValueType.CUSTOM_VALUE || vt === PropertyValueType.SHAPE || vt === PropertyValueType.COLOR);
        var stretch = this.fx20Stretch(prop);

        var v1 = null, v2 = null;
        if (!unreadable) {
            try { v1 = prop.keyValue(kFirst); v2 = prop.keyValue(kLast); } catch (readErr) { compxAuditFallback("HOST_APPLYEXPRESSION_002", readErr); }
        }

        function scalarOf(val) {
            if (val === undefined || val === null) return 0;
            if (val.length !== undefined) return val[0];
            return val;
        }
        function projOf(val) {
            // Signed projection of a spatial key onto the start→end direction.
            var dxT = v2[0] - v1[0];
            var dyT = v2[1] - v1[1];
            var dzT = (v1.length === 3) ? (v2[2] - v1[2]) : 0;
            var distT = Math.sqrt(dxT * dxT + dyT * dyT + dzT * dzT);
            if (distT < 0.0001) return 0;
            var dx = val[0] - v1[0];
            var dy = val[1] - v1[1];
            var dz = (v1.length === 3) ? (val[2] - v1[2]) : 0;
            return (dx * dxT + dy * dyT + dz * dzT) / (distT * distT);
        }

        // Normalized Y per selected key.
        var ys = [];
        var yLo = Infinity, yHi = -Infinity;
        for (i = 0; i < selKeys.length; i++) {
            var raw;
            if (unreadable || v1 === null) {
                raw = (prop.keyTime(selKeys[i]) - t1) / duration;
            } else if (info.spatial) {
                raw = projOf(prop.keyValue(selKeys[i]));
            } else {
                raw = scalarOf(prop.keyValue(selKeys[i]));
            }
            ys.push(raw);
            if (raw < yLo) yLo = raw;
            if (raw > yHi) yHi = raw;
        }
        var span = yHi - yLo;
        var first = ys[0], last = ys[ys.length - 1];
        var normDen = (Math.abs(last - first) > 0.0001) ? (last - first) : (span > 0.0001 ? span : 1);
        for (i = 0; i < ys.length; i++) {
            ys[i] = (ys[i] - first) / normDen;
        }
        var globalSpeed = Math.abs(normDen) / duration;
        if (globalSpeed < 0.0001) globalSpeed = 1 / duration;

        var out = [];
        for (i = 0; i < selKeys.length; i++) {
            k = selKeys[i];
            var x = (prop.keyTime(k) - t1) / duration;
            var y = ys[i];
            var cx1 = x, cy1 = y, cx2 = x, cy2 = y;

            if (i > 0) {
                var inInf = 0, inSpeed = 0;
                try {
                    if (prop.keyInInterpolationType(k) !== KeyframeInterpolationType.LINEAR &&
                        prop.keyInInterpolationType(k) !== KeyframeInterpolationType.HOLD) {
                        var easeInK = prop.keyInTemporalEase(k)[0];
                        inInf = easeInK.influence / 100;
                        inSpeed = easeInK.speed / stretch;
                    }
                } catch (inErr) { compxAuditFallback("HOST_PROJOF_001", inErr); }
                var segIn = (prop.keyTime(k) - prop.keyTime(selKeys[i - 1])) / duration;
                var dxIn2 = inInf * segIn;
                cx1 = x - dxIn2;
                if (inSpeed === 0 || dxIn2 === 0) cy1 = y;
                else cy1 = y - (inSpeed / (Math.abs(normDen) / duration)) * (normDen < 0 ? -1 : 1) * dxIn2;
            }
            if (i < selKeys.length - 1) {
                var outInf = 0, outSpeed = 0;
                try {
                    if (prop.keyOutInterpolationType(k) !== KeyframeInterpolationType.LINEAR &&
                        prop.keyOutInterpolationType(k) !== KeyframeInterpolationType.HOLD) {
                        var easeOutK = prop.keyOutTemporalEase(k)[0];
                        outInf = easeOutK.influence / 100;
                        outSpeed = easeOutK.speed / stretch;
                    }
                } catch (outErr) { compxAuditFallback("HOST_PROJOF_002", outErr); }
                var segOut = (prop.keyTime(selKeys[i + 1]) - prop.keyTime(k)) / duration;
                var dxOut2 = outInf * segOut;
                cx2 = x + dxOut2;
                if (outSpeed === 0 || dxOut2 === 0) cy2 = y;
                else cy2 = y + (outSpeed / (Math.abs(normDen) / duration)) * (normDen < 0 ? -1 : 1) * dxOut2;
            }
            out.push(x.toFixed(5) + "," + y.toFixed(5) + "," + cx1.toFixed(5) + "," + cy1.toFixed(5) + "," + cx2.toFixed(5) + "," + cy2.toFixed(5));
        }
        return "OK|" + out.join(";");
    };

    engine.curve20Playhead = function () {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "ERR: no comp";
        var r1 = "", r2 = "";
        try {
            var props = this.fx20SelectedProps(comp);
            for (var i = 0; i < props.length; i++) {
                if (props[i].numKeys >= 2) {
                    var range = this.fx20KeyRange(props[i]);
                    if (range && range.first !== range.last) {
                        r1 = props[i].keyTime(range.first);
                        r2 = props[i].keyTime(range.last);
                    } else {
                        r1 = props[i].keyTime(1);
                        r2 = props[i].keyTime(props[i].numKeys);
                    }
                    break;
                }
            }
        } catch (phErr) { compxAuditFallback("HOST_PROJOF_003", phErr); }
        return "OK|" + comp.time + "|" + r1 + "|" + r2;
    };

    engine.curve20RemoveExpr = function () {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "ERR: Open a composition first.";
        var count = 0;
        var i, j;
        app.beginUndoGroup("CompX Curve: Remove Expressions");
        try {
            var props = comp.selectedProperties;
            if (props && props.length) {
                for (i = 0; i < props.length; i++) {
                    var p = props[i];
                    try {
                        if (p.propertyType === PropertyType.PROPERTY && p.canSetExpression && p.expression !== "") {
                            p.expression = "";
                            count++;
                        }
                    } catch (exprErr) { compxAuditFallback("HOST_PROJOF_004", exprErr); }
                }
            } else {
                var layers = comp.selectedLayers;
                for (i = 0; i < layers.length; i++) {
                    count += this.fx20StripGroup(layers[i]);
                }
            }
        } catch (remErr) {
            app.endUndoGroup();
            return "ERR: " + remErr.toString();
        }
        app.endUndoGroup();
        if (!count) return "ERR: No expressions found on the selection.";
        return "SUCCESS: Removed " + count + " expression" + (count === 1 ? "" : "s") + ".";
    };

    engine.fx20StripGroup = function (group) {
        var count = 0;
        if (!group) return count;
        for (var i = 1; i <= group.numProperties; i++) {
            var p;
            try { p = group.property(i); } catch (childErr) { continue; }
            if (!p) continue;
            if (p.propertyType === PropertyType.PROPERTY) {
                try {
                    if (p.canSetExpression && p.expression !== "" && (p.expression.indexOf("CompX Curve") !== -1 || p.expression.indexOf("CompX Curve 2.0") !== -1)) {
                        p.expression = "";
                        count++;
                    }
                } catch (stripErr) { compxAuditFallback("HOST_PROJOF_005", stripErr); }
            } else if (p.propertyType === PropertyType.INDEXED_GROUP || p.propertyType === PropertyType.NAMED_GROUP) {
                count += this.fx20StripGroup(p);
            }
        }
        return count;
    };
})();



// ================================================================
// COMPX CAMERA 3D — compact rig inspired by supplied Camera3D toolkit
// ================================================================
function compxCameraFind(comp) {
  var camera = null, rig = null;
  for (var i = 1; i <= comp.numLayers; i++) {
    var l = comp.layer(i);
    if (l.name === "CompX Camera") camera = l;
    if (l.name === "CompX Camera Rig") rig = l;
  }
  return { camera: camera, rig: rig };
}
function ae_camera3DSetup() {
  try {
    var comp = getActiveComp(); if (!comp) return toolResult(false, "No active composition.");
    app.beginUndoGroup("Create CompX Camera Rig");
    var found = compxCameraFind(comp), rig = found.rig, camera = found.camera;
    if (!rig) { rig = comp.layers.addNull(); rig.name = "CompX Camera Rig"; rig.threeDLayer = true; rig.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width/2, comp.height/2, 0]); }
    if (!camera) { camera = comp.layers.addCamera("CompX Camera", [comp.width/2, comp.height/2]); camera.name = "CompX Camera"; try { camera.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width/2, comp.height/2, -comp.width]); } catch (e0) { compxAuditFallback("HOST_AE_CAMERA3DSETUP_001", e0); } }
    camera.parent = rig; camera.selected = true;
    app.endUndoGroup(); return toolResult(true, "CompX Camera and 3D rig ready.");
  } catch(e) { try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_CAMERA3DSETUP_002", e2); } return toolResult(false,String(e)); }
}
function ae_camera3DParent() {
  try {
    var comp=getActiveComp(); if(!comp)return toolResult(false,"No active composition.");
    var f=compxCameraFind(comp); if(!f.rig)return toolResult(false,"Create the Camera 3D rig first.");
    var layers=getSelectedLayers(comp), count=0; app.beginUndoGroup("Parent to Camera Rig");
    for(var i=0;i<layers.length;i++){if(layers[i]!==f.rig&&layers[i]!==f.camera){layers[i].threeDLayer=true;layers[i].parent=f.rig;count++;}}
    app.endUndoGroup(); return toolResult(count>0,count+" layer(s) parented to Camera Rig.");
  } catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_CAMERA3DPARENT_001", e2); }return toolResult(false,String(e));}
}
function ae_camera3DMove(action, amount) {
  try {
    var comp=getActiveComp(); if(!comp)return toolResult(false,"No active composition."); var f=compxCameraFind(comp); if(!f.rig)return toolResult(false,"Create the Camera 3D rig first.");
    amount=Number(amount)||100; var tr=f.rig.property("ADBE Transform Group"), pos=tr.property("ADBE Position"), rot=tr.property("ADBE Rotate Z"), ori=tr.property("ADBE Orientation");
    app.beginUndoGroup("Camera 3D Move"); var p=pos.value, o=ori.value;
    if(action==="left")p[0]-=amount; else if(action==="right")p[0]+=amount; else if(action==="up")p[1]-=amount; else if(action==="down")p[1]+=amount; else if(action==="forward")p[2]+=amount; else if(action==="backward")p[2]-=amount;
    else if(action==="panLeft")o[1]-=amount/10; else if(action==="panRight")o[1]+=amount/10; else if(action==="tiltUp")o[0]-=amount/10; else if(action==="tiltDown")o[0]+=amount/10; else if(action==="rollLeft")rot.setValue(rot.value-amount/10); else if(action==="rollRight")rot.setValue(rot.value+amount/10);
    pos.setValue(p); ori.setValue(o); app.endUndoGroup(); return toolResult(true,"Camera rig updated: "+action+".");
  } catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_CAMERA3DMOVE_001", e2); }return toolResult(false,String(e));}
}
function ae_camera3DShake(amp, freq) {
  try { var comp=getActiveComp();if(!comp)return toolResult(false,"No active composition.");var f=compxCameraFind(comp);if(!f.rig)return toolResult(false,"Create the Camera 3D rig first.");amp=Number(amp)||15;freq=Number(freq)||2;app.beginUndoGroup("Camera 3D Shake");var tr=f.rig.property("ADBE Transform Group");tr.property("ADBE Position").expression="// COMPX_CAMERA_SHAKE\\nwiggle("+freq+","+amp+");";tr.property("ADBE Orientation").expression="// COMPX_CAMERA_SHAKE\\nwiggle("+freq+","+(amp*.15)+");";app.endUndoGroup();return toolResult(true,"Camera shake applied."); } catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_CAMERA3DSHAKE_001", e2); }return toolResult(false,String(e));}
}
function ae_camera3DRemoveShake() {
  try {var comp=getActiveComp();if(!comp)return toolResult(false,"No active composition.");var f=compxCameraFind(comp);if(!f.rig)return toolResult(false,"Camera rig not found.");var tr=f.rig.property("ADBE Transform Group"), props=[tr.property("ADBE Position"),tr.property("ADBE Orientation")],n=0;app.beginUndoGroup("Remove Camera Shake");for(var i=0;i<props.length;i++){if(props[i].expression.indexOf("COMPX_CAMERA_SHAKE")>=0){props[i].expression="";n++;}}app.endUndoGroup();return toolResult(true,"Camera shake cleared.");}catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_CAMERA3DREMOVESHAKE_001", e2); }return toolResult(false,String(e));}
}
function ae_camera3DFocus() {
  try {var comp=getActiveComp();if(!comp)return toolResult(false,"No active composition.");var f=compxCameraFind(comp);if(!f.camera)return toolResult(false,"Create the Camera 3D rig first.");var sel=getSelectedLayers(comp),target=null;for(var i=0;i<sel.length;i++){if(sel[i]!==f.camera&&sel[i]!==f.rig){target=sel[i];break;}}if(!target)return toolResult(false,"Select a target layer first.");var poi=f.camera.property("ADBE Transform Group").property("ADBE Point of Interest");if(!poi)return toolResult(false,"This camera has no Point of Interest property.");var safe=target.name.replace(/\\/g,"\\\\").replace(/\"/g,'\\\"');poi.expression='// COMPX_CAMERA_FOCUS\\nthisComp.layer("'+safe+'").toWorld(thisComp.layer("'+safe+'").anchorPoint);';return toolResult(true,'Camera focused on "'+target.name+'".');}catch(e){return toolResult(false,String(e));}
}
function ae_camera3DReset() {
  try {var comp=getActiveComp();if(!comp)return toolResult(false,"No active composition.");var f=compxCameraFind(comp);if(!f.rig)return toolResult(false,"Camera rig not found.");app.beginUndoGroup("Reset Camera Rig");var tr=f.rig.property("ADBE Transform Group");try{tr.property("ADBE Position").expression="";}catch (e0) { compxAuditFallback("HOST_AE_CAMERA3DRESET_001", e0); }try{tr.property("ADBE Orientation").expression="";}catch (e1) { compxAuditFallback("HOST_AE_CAMERA3DRESET_002", e1); }tr.property("ADBE Position").setValue([comp.width/2,comp.height/2,0]);tr.property("ADBE Orientation").setValue([0,0,0]);tr.property("ADBE Rotate Z").setValue(0);if(f.camera){try{f.camera.property("ADBE Transform Group").property("ADBE Point of Interest").expression="";}catch (e2) { compxAuditFallback("HOST_AE_CAMERA3DRESET_003", e2); }}app.endUndoGroup();return toolResult(true,"Camera rig reset.");}catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_CAMERA3DRESET_004", e2); }return toolResult(false,String(e));}
}

// CompX bridges for supplied Paste Feature and Curve Lab.
function ae_getPastaTargetPath() {
  try { return $.global.CompX_getPasteImagePath(); } catch(e) { return "ERR:" + String(e); }
}
function ae_importPastaFile(filePath, toShapes) {
  try {
    var result=$.global.CompX_pasteImageFromFile(filePath,"AEFT",!!toShapes);
    if(String(result).indexOf("ERR:")===0)return toolResult(false,String(result).slice(4));
    if(String(result)!=="SUCCESS")return toolResult(false,String(result));
    return toolResult(true,toShapes?"Clipboard SVG pasted as a Shape Layer.":"Clipboard artwork pasted at the playhead.");
  } catch(e) { return toolResult(false,String(e)); }
}
function ae_pasteFeature(toShapes) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "No active composition.");
    var targetPath = $.global.CompX_getPasteImagePath();
    if (String(targetPath).indexOf("ERR:") === 0) return toolResult(false, String(targetPath).slice(4));
    if (!compxCopyPasta_pasteClipboardToFile(targetPath)) return toolResult(false, "Clipboard does not contain a supported image.");
    var result = $.global.CompX_pasteImageFromFile(targetPath, "AEFT", !!toShapes);
    if (String(result).indexOf("ERR:") === 0) return toolResult(false, String(result).slice(4));
    return toolResult(true, toShapes ? "Clipboard artwork pasted as a Shape Layer." : "Clipboard image pasted into the composition.");
  } catch (e) { return toolResult(false, String(e)); }
}
function ae_graph20Apply(payload) {
  try { return ($.global.CompXCurveEngine && $.global.CompXCurveEngine.curve20Apply) ? $.global.CompXCurveEngine.curve20Apply(payload) : "ERR: Graph engine unavailable."; }
  catch (e) { return "ERR: " + e.toString(); }
}
function ae_graph20Read() {
  try { return ($.global.CompXCurveEngine && $.global.CompXCurveEngine.curve20Read) ? $.global.CompXCurveEngine.curve20Read() : "ERR: Graph engine unavailable."; }
  catch (e) { return "ERR: " + e.toString(); }
}
function ae_graph20Remove() {
  try { return ($.global.CompXCurveEngine && $.global.CompXCurveEngine.curve20RemoveExpr) ? $.global.CompXCurveEngine.curve20RemoveExpr() : "ERR: Graph engine unavailable."; }
  catch (e) { return "ERR: " + e.toString(); }
}


// ================================================================
// COMPX: Keylight background removal, shake and expression presets
// ================================================================
function ae_removeBackground(hex, softEdge) {
  try {
    var comp=getActiveComp(); if(!comp)return toolResult(false,"Open a composition first.");
    var layers=getSelectedLayers(comp); if(!layers.length)return toolResult(false,"Select footage layer(s) first.");
    var rgb=hexToUnitRgb(hex), applied=0; app.beginUndoGroup("CompX Remove Background");
    for(var i=0;i<layers.length;i++){
      var fx=null; try{fx=layers[i].property("ADBE Effect Parade").addProperty("ADBE Keylight 906");}catch(e){fx=null;}
      if(!fx) continue;
      try{var p=fx.property("Screen Colour")||fx.property(1); if(p)p.setValue(rgb);}catch (e1) { compxAuditFallback("HOST_AE_REMOVEBACKGROUND_001", e1); }
      try{var gain=fx.property("Screen Gain"); if(gain)gain.setValue(softEdge?75:100);}catch (e2) { compxAuditFallback("HOST_AE_REMOVEBACKGROUND_002", e2); }
      try{var clip=fx.property("Screen Matte"); if(softEdge&&clip){} }catch (e3) { compxAuditFallback("HOST_AE_REMOVEBACKGROUND_003", e3); }
      applied++;
    }
    app.endUndoGroup(); return toolResult(applied>0,applied?"Keylight added to "+applied+" selected layer(s).":"Could not add Keylight. Use footage layers in After Effects.");
  }catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_REMOVEBACKGROUND_004", e2); }return toolResult(false,String(e));}
}
function ae_applyShakePreset(preset) {
  try {
    var comp=getActiveComp();if(!comp)return toolResult(false,"Open a composition first.");var layers=getSelectedLayers(comp);if(!layers.length)return toolResult(false,"Select one or more layers first.");
    var M={BasicShake:["pos",3,12],QuickShake:["pos",8,10],WaveShakeV1:["wave",2,18],WaveShakeV2:["wave",2.5,24],BounceShakeV1:["pos",4,20],BounceShakeV2:["pos",5,28],SqueezeV1Shake:["scale",3,8],SqueezeV2Shake:["scale",4,14],WarpShake:["pos",6,30],LensShake:["scale",3,10],InvertShake:["pos",7,16],InvertPixleShake:["pos",10,14],DarkFlickerShake:["flick",12,0],WhiteFlickerShake:["flick",12,0]};
    var cfg=M[preset]||M.BasicShake,ch=cfg[0],freq=cfg[1],amp=cfg[2],n=0;app.beginUndoGroup("CompX Shake "+preset);
    for(var i=0;i<layers.length;i++){var L=layers[i],tg=L.property("ADBE Transform Group"),p=null,expr="";
      if(ch==="scale"){p=tg.property("ADBE Scale");expr="seedRandom(index,true);\\ns=wiggle("+freq+","+amp+");\\n[s[0],s[1]];";}
      else if(ch==="flick"){p=tg.property("ADBE Opacity");expr="seedRandom(index,true);\\nrandom()<0.35?"+(preset==="WhiteFlickerShake"?"100":"12")+":value;";}
      else if(ch==="wave"){p=tg.property("ADBE Position");expr="w="+amp+"*Math.sin(time*"+freq+"*2*Math.PI);\\nvalue+[w,w*0.4];";}
      else{p=tg.property("ADBE Position");expr="seedRandom(index,true);\\nwiggle("+freq+","+amp+");";}
      if(!p||!p.canSetExpression)continue;p.expression="// COMPX_SHAKE_"+preset+"\\n"+expr;p.expressionEnabled=true;n++;}
    app.endUndoGroup();return toolResult(n>0,n>0?(n+" layer(s) received the "+preset+" shake."):"Could not apply shake to selection.");
  }catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_APPLYSHAKEPRESET_001", e2); }return toolResult(false,String(e));}
}
function ae_applyExpressionPreset(preset) {
  try {
    var comp=getActiveComp();if(!comp)return toolResult(false,"Open a composition first.");var layers=getSelectedLayers(comp);if(!layers.length)return toolResult(false,"Select a layer and Timeline property first.");
    var exprs={loop:'loopOut("cycle")',pingpong:'loopOut("pingpong")',wiggle:'wiggle(3,20)',posterize:'posterizeTime(12); value',hold:'posterizeTime(4); value',bounce:'var n=0;if(numKeys>0){n=nearestKey(time).index;if(key(n).time>time)n--;} if(n>0){var t=time-key(n).time;var v=velocityAtTime(key(n).time-thisComp.frameDuration/10);value+v*.08*Math.sin(7*t*2*Math.PI)/Math.exp(5*t)}else value'};
    var expr=exprs[preset]||exprs.loop,n=0;app.beginUndoGroup("CompX Expression "+preset);
    for(var i=0;i<layers.length;i++){var ps=layers[i].selectedProperties;for(var j=0;j<ps.length;j++){try{if(ps[j].canSetExpression){ps[j].expression="// COMPX_EXPR_"+preset+"\n"+expr;ps[j].expressionEnabled=true;n++;}}catch (e1) { compxAuditFallback("HOST_AE_APPLYEXPRESSIONPRESET_001", e1); }}}
    app.endUndoGroup();
    return toolResult(n>0, n>0 ? ("Applied " + preset + " to " + n + " selected propert" + (n===1 ? "y." : "ies.")) : "Select one or more expression-capable Timeline properties first.");
  }catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_APPLYEXPRESSIONPRESET_002", e2); }return toolResult(false,String(e));}
}


function ae_applyExpressionCode(enc) {
  try {
    var code=decodeURIComponent(enc);
    var comp=getActiveComp();if(!comp)return toolResult(false,"Open a composition first.");var layers=getSelectedLayers(comp);if(!layers.length)return toolResult(false,"Select a layer and a Timeline property first.");
    var n=0;app.beginUndoGroup("CompX Expression");
    for(var i=0;i<layers.length;i++){var ps=layers[i].selectedProperties;for(var j=0;j<ps.length;j++){try{if(ps[j].canSetExpression){ps[j].expression=code;ps[j].expressionEnabled=true;n++;}}catch (e1) { compxAuditFallback("HOST_AE_APPLYEXPRESSIONCODE_001", e1); }}}
    app.endUndoGroup();
    return toolResult(n>0,n>0?("Applied expression to "+n+" propert"+(n===1?"y.":"ies.")):"Select one or more expression-capable Timeline properties first.");
  }catch(e){try{app.endUndoGroup();}catch (e2) { compxAuditFallback("HOST_AE_APPLYEXPRESSIONCODE_002", e2); }return toolResult(false,String(e));}
}

// APPLY 4-COLOR GRADIENT — adds AE's 4-Color Gradient effect (ADBE 4ColorGradient)
// to selected layers using four hex colors (CompX gradient-collection parity).
function ae_applyGradient4(h0, h1, h2, h3) {
  try {
    function hexRGB(h) { if (!h) return [1, 0, 0]; h = String(h).replace('#', ''); if (h.length < 6) h = h + h + h; return [parseInt(h.substr(0,2),16)/255, parseInt(h.substr(2,2),16)/255, parseInt(h.substr(4,2),16)/255]; }
    var comp = getActiveComp(); if (!comp) return toolResult(false, "No active composition.");
    var layers = getSelectedLayers(comp); if (layers.length === 0) return toolResult(false, "No layers selected.");
    var cols = [hexRGB(h0), hexRGB(h1), hexRGB(h2), hexRGB(h3)];
    var w = comp.width, h = comp.height;
    var pts = [[w*0.25, h*0.25], [w*0.75, h*0.25], [w*0.25, h*0.75], [w*0.75, h*0.75]];

    app.beginUndoGroup("Apply 4-Color Gradient");
    var applied = 0;
    for (var i = 0; i < layers.length; i++) {
      try {
        var fx = layers[i].property("ADBE Effect Parade"); if (!fx) continue;
        // Remove existing 4-Color Gradient effects to prevent stacking
        try {
          for (var ri = fx.numProperties; ri >= 1; ri--) {
            var ep = fx.property(ri);
            if (ep && ep.matchName === "ADBE 4ColorGradient") { ep.remove(); }
          }
        } catch (re) { compxAuditFallback("HOST_HEXRGB_001", re); }
        var ef = fx.addProperty("ADBE 4ColorGradient"); if (!ef) continue;

        // Try using Flex-style display names first (very safe across AE CC versions)
        // With indices as solid fallback
        for (var j = 0; j < 4; j++) {
          var num = j + 1;
          var pName = "Point " + num;
          var cName = "Color " + num;
          
          var pProp = ef.property(pName);
          if (pProp) { pProp.setValue(pts[j]); } 
          else { try { ef.property((j * 2) + 1).setValue(pts[j]); } catch (e1) { compxAuditFallback("HOST_HEXRGB_002", e1); } }
          
          var cProp = ef.property(cName);
          if (cProp) { cProp.setValue(cols[j]); } 
          else { try { ef.property((j * 2) + 2).setValue(cols[j]); } catch (e2) { compxAuditFallback("HOST_HEXRGB_003", e2); } }
        }
        applied++;
      } catch (le) { compxAuditFallback("HOST_HEXRGB_004", le); }
    }
    app.endUndoGroup();
    return toolResult(applied > 0, applied > 0 ? "4-color gradient applied." : "Could not apply gradient.");
  } catch (e) { try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_HEXRGB_005", e2); } return toolResult(false, String(e)); }
}

// ---------- CROPPING ENGINE & BRIDGES ----------

/**
 * Recursively searches a group for any stroke and returns the maximum stroke width found.
 */
function getStrokeBufferFromGroup(group) {
  var maxStroke = 0;
  for (var i = 1; i <= group.numProperties; i++) {
    var prop = group.property(i);
    if (prop.matchName === "ADBE Vector Graphic - Stroke") {
      var sw = prop.property("Stroke Width").value;
      if (sw > maxStroke) {
        maxStroke = sw;
      }
    } else if (prop.matchName === "ADBE Vector Group" || (prop instanceof PropertyGroup)) {
      var subStroke = getStrokeBufferFromGroup(prop);
      if (subStroke > maxStroke) {
        maxStroke = subStroke;
      }
    }
  }
  return maxStroke;
}

/**
 * Returns the maximum stroke width detected in a vector layer.
 * Multiplies the value by a factor (1.2 in this case) to ensure sufficient padding.
 */
function getStrokeBuffer(layer) {
  try {
    var contents = layer.property("Contents");
    if (contents) {
      var detected = getStrokeBufferFromGroup(contents);
      if (detected > 0) {
        return detected * 1.2;
      }
    }
  } catch (e) {
    return 20; // Fallback value
  }
  return 0;
}

/**
 * Fallback function to convert a local point to comp space.
 * If layer.toComp() exists, it is used; otherwise, a custom 2D matrix calculation is performed.
 */
function myLayerToComp(layer, localPoint, t) {
  if (typeof layer.toComp === "function") {
    return layer.toComp(localPoint);
  } else {
    var matrix = getLayerMatrix(layer, t);
    var point = [localPoint[0], localPoint[1], 1];
    var worldPoint = multiplyMatrixAndPoint(matrix, point);
    return [worldPoint[0], worldPoint[1]];
  }
}

/**
 * Computes the 3x3 transformation matrix for a given layer at time t (2D only).
 * This includes the layer’s own transform and recursively its parent transforms.
 */
function getLayerMatrix(layer, t) {
  var pos = layer.property("Position").valueAtTime(t, false);
  var scale = layer.property("Scale").valueAtTime(t, false);
  var anchor = layer.property("Anchor Point").valueAtTime(t, false);
  var rotation = 0;
  if (layer.property("Rotation") !== null) {
    rotation = layer.property("Rotation").valueAtTime(t, false) * Math.PI / 180;
  }
  var T = [
    [1, 0, pos[0]],
    [0, 1, pos[1]],
    [0, 0, 1]
  ];
  var R = [
    [Math.cos(rotation), -Math.sin(rotation), 0],
    [Math.sin(rotation), Math.cos(rotation), 0],
    [0, 0, 1]
  ];
  var S = [
    [scale[0] / 100, 0, 0],
    [0, scale[1] / 100, 0],
    [0, 0, 1]
  ];
  var A = [
    [1, 0, -anchor[0]],
    [0, 1, -anchor[1]],
    [0, 0, 1]
  ];
  var matrix = multiplyMatrices(T, multiplyMatrices(R, multiplyMatrices(S, A)));
  if (layer.parent !== null) {
    var parentMatrix = getLayerMatrix(layer.parent, t);
    matrix = multiplyMatrices(parentMatrix, matrix);
  }
  return matrix;
}

/**
 * Multiplies two 3x3 matrices.
 */
function multiplyMatrices(a, b) {
  var result = [];
  for (var i = 0; i < 3; i++) {
    result[i] = [];
    for (var j = 0; j < 3; j++) {
      result[i][j] = 0;
      for (var k = 0; k < 3; k++) {
        result[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return result;
}

/**
 * Multiplies a 3x3 matrix with a 3x1 point vector.
 */
function multiplyMatrixAndPoint(matrix, point) {
  var result = [];
  for (var i = 0; i < 3; i++) {
    var sum = 0;
    for (var j = 0; j < 3; j++) {
      sum += matrix[i][j] * point[j];
    }
    result[i] = sum;
  }
  return result;
}

/**
 * Crops the comp to the bounding box and adjusts internal layers.
 */
function cropComp(comp, bounds) {
  var newWidth = Math.max(1, Math.ceil(bounds.width));
  var newHeight = Math.max(1, Math.ceil(bounds.height));
  var offsetX = bounds.x, offsetY = bounds.y;
  var origWidth = comp.width, origHeight = comp.height;
  var centerShiftX = (origWidth - newWidth) / 2;
  var centerShiftY = (origHeight - newHeight) / 2;
  comp.width = newWidth;
  comp.height = newHeight;
  for (var i = 1; i <= comp.layers.length; i++) {
    var layer = comp.layers[i];
    if (!layer) continue;
    if (layer.parent !== null) continue;
    var posProp = layer.property("Position");
    if (!posProp) continue;
    var numKeys = posProp.numKeys;
    if (numKeys > 0) {
      for (var k = 1; k <= numKeys; k++) {
        var oldVal = posProp.keyValue(k);
        var keyT = posProp.keyTime(k);
        var newX = oldVal[0] - offsetX;
        var newY = oldVal[1] - offsetY;
        if (layer.threeDLayer) {
          newX += centerShiftX;
          newY += centerShiftY;
        }
        if (oldVal.length > 2) {
          posProp.setValueAtTime(keyT, [newX, newY, oldVal[2]]);
        } else {
          posProp.setValueAtTime(keyT, [newX, newY]);
        }
      }
    } else {
      var currentVal = posProp.value;
      var newX = currentVal[0] - offsetX;
      var newY = currentVal[1] - offsetY;
      if (layer.threeDLayer) {
        newX += centerShiftX;
        newY += centerShiftY;
      }
      if (currentVal.length > 2) {
        posProp.setValue([newX, newY, currentVal[2]]);
      } else {
        posProp.setValue([newX, newY]);
      }
    }
  }
  return { x: offsetX, y: offsetY };
}

/**
 * Returns a bounding box for all layers at time t.
 */
function getCompBoundsAtTime(layers, t) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var i = 1; i <= layers.length; i++) {
    var layer = layers[i];
    if (!layer || !layer.enabled) continue;
    if (t < layer.inPoint || t > layer.outPoint) continue;
    var rect = null;
    try {
      rect = layer.sourceRectAtTime(t, false);
    } catch (e) {
      continue;
    }
    if (!rect || rect.width === 0 || rect.height === 0) continue;
    var extraBuffer = 0;
    if (layer.matchName === "ADBE Vector Layer") {
      extraBuffer = getStrokeBuffer(layer);
    }
    var corners = [
      [rect.left, rect.top],
      [rect.left + rect.width, rect.top],
      [rect.left, rect.top + rect.height],
      [rect.left + rect.width, rect.top + rect.height]
    ];
    for (var c = 0; c < corners.length; c++) {
      var localPoint = corners[c];
      var worldPos = myLayerToComp(layer, localPoint, t);
      var x1 = worldPos[0] - extraBuffer;
      var x2 = worldPos[0] + extraBuffer;
      var y1 = worldPos[1] - extraBuffer;
      var y2 = worldPos[1] + extraBuffer;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
  }
  if (minX === Infinity) return null;
  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY)
  };
}

/**
 * Calculates a bounding box over time for the precomp by sampling frames.
 */
function getCompBoundsOverTime(comp, layers) {
  var earliest = +Infinity, latest = -Infinity;
  for (var i = 1; i <= layers.length; i++) {
    var layer = layers[i];
    if (!layer) continue;
    if (layer.inPoint < earliest) earliest = layer.inPoint;
    if (layer.outPoint > latest) latest = layer.outPoint;
  }
  if (earliest === Infinity || latest === -Infinity) return null;
  var maxSamples = 20;
  var duration = latest - earliest;
  var frameDuration = 1 / comp.frameRate;
  var sampleStep = duration / (maxSamples - 1);
  if (sampleStep < frameDuration) sampleStep = frameDuration;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (var t = earliest; t <= latest + 0.0001; t += sampleStep) {
    var boundsAtT = getCompBoundsAtTime(layers, t);
    if (!boundsAtT) continue;
    var left = boundsAtT.x, top = boundsAtT.y,
        right = boundsAtT.x + boundsAtT.width, bottom = boundsAtT.y + boundsAtT.height;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  // Ensure the very last frame is sampled
  var finalBounds = getCompBoundsAtTime(layers, latest);
  if (finalBounds) {
    var left = finalBounds.x, top = finalBounds.y,
        right = finalBounds.x + finalBounds.width, bottom = finalBounds.y + finalBounds.height;
    if (left < minX) minX = left;
    if (top < minY) minY = top;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  if (minX === Infinity) return null;
  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.ceil(maxX - minX),
    height: Math.ceil(maxY - minY)
  };
}

/**
 * Unified AE Bridge functions returning standard JSON toolResult
 */
function ae_processXCrop() {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "Please select an active composition.");
    
    var targetComp = comp;
    if (comp.selectedLayers.length > 0) {
      var sel = comp.selectedLayers[0];
      if (sel.source && sel.source instanceof CompItem) {
        targetComp = sel.source;
      }
    }
    
    var layersInTarget = targetComp.layers;
    if (layersInTarget.length === 0) return toolResult(false, "Target comp has no layers.");
    
    app.beginUndoGroup("X Crop");
    
    var t = targetComp.time;
    var bounds = getCompBoundsAtTime(layersInTarget, t);
    if (!bounds) {
      app.endUndoGroup();
      return toolResult(false, "Could not determine bounding box.");
    }
    
    var origWidth = targetComp.width, origHeight = targetComp.height;
    var offset = cropComp(targetComp, bounds);
    
    if (targetComp !== comp) {
      var precompLayer = null;
      for (var i = 1; i <= comp.layers.length; i++) {
        var lyr = comp.layer(i);
        if (lyr.source === targetComp) {
          precompLayer = lyr;
          break;
        }
      }
      if (precompLayer) {
        var newCenterX = targetComp.width / 2;
        var newCenterY = targetComp.height / 2;
        var oldCenterX = origWidth / 2;
        var oldCenterY = origHeight / 2;
        var compensationX = offset.x + (newCenterX - oldCenterX);
        var compensationY = offset.y + (newCenterY - oldCenterY);
        var posProp = precompLayer.property("Position");
        if (posProp) {
          if (posProp.numKeys > 0) {
            for (var k = 1; k <= posProp.numKeys; k++) {
              var oldVal = posProp.keyValue(k);
              var keyT = posProp.keyTime(k);
              var newX = oldVal[0] + compensationX;
              var newY = oldVal[1] + compensationY;
              if (oldVal.length > 2) {
                posProp.setValueAtTime(keyT, [newX, newY, oldVal[2]]);
              } else {
                posProp.setValueAtTime(keyT, [newX, newY]);
              }
            }
          } else {
            var currentVal = posProp.value;
            if (currentVal.length > 2) {
              posProp.setValue([currentVal[0] + compensationX, currentVal[1] + compensationY, currentVal[2]]);
            } else {
              posProp.setValue([currentVal[0] + compensationX, currentVal[1] + compensationY]);
            }
          }
        }
      }
    }
    
    app.endUndoGroup();
    return toolResult(true, "Current frame cropped successfully.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_PROCESSXCROP_001", e2); }
    return toolResult(false, String(e));
  }
}

function ae_processBoltCrop(precompFirst) {
  try {
    var comp = getActiveComp();
    if (!comp) return toolResult(false, "Please select an active composition.");
    
    var selectedLayers = getSelectedLayers(comp);
    if (selectedLayers.length === 0) return toolResult(false, "Please select at least one layer.");
    
    app.beginUndoGroup(precompFirst ? "Xpert Crop" : "Xact Crop");
    
    if (precompFirst) {
      var indices = [];
      for (var i = 0; i < selectedLayers.length; i++) {
        indices.push(selectedLayers[i].index);
      }
      var newComp = comp.layers.precompose(indices, "Precomp", true);
      if (!newComp) {
        app.endUndoGroup();
        return toolResult(false, "Precomposition failed.");
      }
      var newLayer = null;
      for (var j = 1; j <= comp.layers.length; j++) {
        var tempLayer = comp.layer(j);
        if (tempLayer.source === newComp) {
          newLayer = tempLayer;
          break;
        }
      }
      if (!newLayer) {
        app.endUndoGroup();
        return toolResult(false, "Could not locate the new precomp layer.");
      }
      selectedLayers = [newLayer];
    }
    
    for (var i = 0; i < selectedLayers.length; i++) {
      var layer = selectedLayers[i];
      if (!layer.source || !(layer.source instanceof CompItem)) {
        continue;
      }
      var precompItem = layer.source;
      var layersInPrecomp = precompItem.layers;
      if (layersInPrecomp.length === 0) {
        continue;
      }
      
      var bounds = getCompBoundsOverTime(precompItem, layersInPrecomp);
      if (!bounds) continue;
      
      var origWidth = precompItem.width;
      var origHeight = precompItem.height;
      var offset = cropComp(precompItem, bounds);
      var newCenterX = precompItem.width / 2;
      var newCenterY = precompItem.height / 2;
      var oldCenterX = origWidth / 2;
      var oldCenterY = origHeight / 2;
      var compensationX = offset.x + (newCenterX - oldCenterX);
      var compensationY = offset.y + (newCenterY - oldCenterY);
      var posProp = layer.property("Position");
      if (posProp) {
        if (posProp.numKeys > 0) {
          for (var k = 1; k <= posProp.numKeys; k++) {
            var oldVal = posProp.keyValue(k);
            var keyT = posProp.keyTime(k);
            var newX = oldVal[0] + compensationX;
            var newY = oldVal[1] + compensationY;
            if (oldVal.length > 2) {
              posProp.setValueAtTime(keyT, [newX, newY, oldVal[2]]);
            } else {
              posProp.setValueAtTime(keyT, [newX, newY]);
            }
          }
        } else {
          var currentVal = posProp.value;
          if (currentVal.length > 2) {
            posProp.setValue([currentVal[0] + compensationX, currentVal[1] + compensationY, currentVal[2]]);
          } else {
            posProp.setValue([currentVal[0] + compensationX, currentVal[1] + compensationY]);
          }
        }
      }
    }
    
    app.endUndoGroup();
    return toolResult(true, precompFirst ? "Precomposed and cropped over time." : "Precomp cropped over time.");
  } catch (e) {
    try { app.endUndoGroup(); } catch (e2) { compxAuditFallback("HOST_AE_PROCESSBOLTCROP_001", e2); }
    return toolResult(false, String(e));
  }
}


// ================================================================
// COMPX MOTION SHOWCASE 3D — builds native AE 3D card scenes from
// selected footage/precomp layers. Images remain 2D sources; only
// their card layers are placed in 3D camera space.
// ================================================================
function compxShowcaseFind(comp) {
  if (comp && String(comp.comment).indexOf("COMPX_SHOWCASE|") === 0) return comp;
  for (var i = 1; i <= app.project.numItems; i++) {
    var item = app.project.item(i);
    try { if (item instanceof CompItem && String(item.comment).indexOf("COMPX_SHOWCASE|") === 0) return item; } catch (e) {}
  }
  return null;
}
function compxShowcaseSlider(layer, name, value) {
  var effect = layer.property("ADBE Effect Parade").addProperty("ADBE Slider Control");
  effect.name = name; effect.property("ADBE Slider Control-0001").setValue(value); return effect;
}
function ae_motionShowcaseBuild(template, radius, depth, duration, faceCamera, motionBlur) {
  try {
    var sourceComp = getActiveComp();
    if (!sourceComp) return toolResult(false, "Open a composition and select at least two image/video or precomp layers.");
    var selected = getSelectedLayers(sourceComp), sources = [];
    for (var i = 0; i < selected.length && sources.length < 20; i++) {
      var layer = selected[i], item = null;
      try { item = layer.source; } catch (eSource) {}
      try { if (item && item.width > 0 && item.height > 0 && !(layer instanceof CameraLayer) && !(layer instanceof LightLayer)) sources.push({ item: item, name: layer.name }); } catch (eLayer) {}
    }
    if (sources.length < 2) return toolResult(false, "Select at least two footage, image, video, or precomp layers first.");
    template = String(template || "orbit").toLowerCase();
    if (template !== "helix" && template !== "depth") template = "orbit";
    radius = Math.max(200, Math.min(3000, Number(radius) || 900));
    depth = Math.max(100, Math.min(3000, Number(depth) || 700));
    duration = Math.max(3, Math.min(60, Number(duration) || 12));
    faceCamera = String(faceCamera) !== "false" && faceCamera !== false;
    motionBlur = String(motionBlur) !== "false" && motionBlur !== false;
    var name = "CompX 3D Showcase • " + (template === "helix" ? "Helix" : template === "depth" ? "Depth Stack" : "Orbit Ring");
    app.beginUndoGroup("Build CompX 3D Motion Showcase");
    var folder = app.project.items.addFolder(name + " Assets");
    var show = app.project.items.addComp(name, sourceComp.width, sourceComp.height, sourceComp.pixelAspect, duration, sourceComp.frameRate || 30);
    show.parentFolder = folder; show.comment = "COMPX_SHOWCASE|" + template; show.motionBlur = motionBlur;
    try { show.shutterAngle = 180; } catch (eShutter) {}
    var controller = show.layers.addNull(duration); controller.name = "CompX Showcase • Controller"; controller.comment = "COMPX_SHOWCASE_CONTROLLER"; controller.threeDLayer = true;
    controller.property("ADBE Transform Group").property("ADBE Position").setValue([show.width / 2, show.height / 2, 0]);
    compxShowcaseSlider(controller, "Radius", radius); compxShowcaseSlider(controller, "Depth", depth); compxShowcaseSlider(controller, "Loop Duration", duration); compxShowcaseSlider(controller, "Card Count", sources.length);
    var rY = controller.property("ADBE Transform Group").property("ADBE Rotate Y");
    if (template !== "depth") rY.expression = 'd=Math.max(effect("Loop Duration")("Slider"),.1);(time%d)/d*360';
    var minSide = Math.min(show.width, show.height), cardW = Math.round(minSide * .42), cardH = Math.round(cardW * .63);
    for (var s = 0; s < sources.length; s++) {
      var card = show.layers.add(sources[s].item); card.name = "CompX Card " + (s + 1) + " • " + sources[s].name; card.comment = "COMPX_SHOWCASE_CARD|" + s; card.threeDLayer = true; card.motionBlur = motionBlur; card.parent = controller;
      var scale = Math.max(cardW / sources[s].item.width, cardH / sources[s].item.height) * 100;
      card.property("ADBE Transform Group").property("ADBE Scale").setValue([scale, scale, scale]);
      var p = card.property("ADBE Transform Group").property("ADBE Position");
      var common = 'c=thisComp.layer("CompX Showcase • Controller");n=Math.max(c.effect("Card Count")("Slider"),1);r=c.effect("Radius")("Slider");z=c.effect("Depth")("Slider");i=' + s + ';';
      if (template === "helix") p.expression = common + 'a=(i/n)*Math.PI*4;[Math.sin(a)*r*.75,(i/Math.max(n-1,1)-.5)*z*.8,Math.cos(a)*r*.75]';
      else if (template === "depth") p.expression = common + 'd=Math.max(c.effect("Loop Duration")("Slider"),.1);ph=((i/n)+(time/d))%1;[Math.sin(ph*Math.PI*2)*r*.35,Math.cos(ph*Math.PI*2)*r*.2,(ph-.5)*z*2]';
      else p.expression = common + 'a=(i/n)*Math.PI*2;[Math.sin(a)*r,Math.sin(a*2)*z*.16,Math.cos(a)*r]';
      if (faceCamera) card.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
      else if (template !== "depth") card.property("ADBE Transform Group").property("ADBE Orientation").setValue([0, (s / sources.length) * 360 + 180, 0]);
    }
    var camera = show.layers.addCamera("CompX Showcase • Camera", [show.width / 2, show.height / 2]); camera.comment = "COMPX_SHOWCASE_CAMERA";
    var ct = camera.property("ADBE Transform Group"); ct.property("ADBE Position").setValue([show.width / 2, show.height / 2, -show.width * 1.15]);
    try { ct.property("ADBE Point of Interest").setValue([show.width / 2, show.height / 2, 0]); } catch (ePoi) {}
    controller.moveToBeginning(); camera.moveToBeginning(); show.openInViewer(); app.endUndoGroup();
    return toolResult(true, "Created " + (template === "helix" ? "Helix Stream" : template === "depth" ? "Depth Stack" : "Orbit Ring") + " with " + sources.length + " image/video cards.");
  } catch (e) { try { app.endUndoGroup(); } catch (eEnd) {} return toolResult(false, String(e)); }
}
function ae_motionShowcaseUpdate(radius, depth, duration, faceCamera, motionBlur) {
  try {
    var show = compxShowcaseFind(getActiveComp()); if (!show) return toolResult(false, "Open a CompX 3D Showcase composition first.");
    var controller = null;
    for (var i = 1; i <= show.numLayers; i++) if (show.layer(i).name === "CompX Showcase • Controller") controller = show.layer(i);
    if (!controller) return toolResult(false, "Showcase controller is missing.");
    function set(name, value) { var fx = controller.property("ADBE Effect Parade").property(name); if (fx) fx.property("ADBE Slider Control-0001").setValue(value); }
    radius = Math.max(200, Math.min(3000, Number(radius) || 900)); depth = Math.max(100, Math.min(3000, Number(depth) || 700)); duration = Math.max(3, Math.min(60, Number(duration) || 12));
    app.beginUndoGroup("Update CompX 3D Showcase"); set("Radius", radius); set("Depth", depth); set("Loop Duration", duration); show.duration = duration; show.motionBlur = motionBlur !== false && String(motionBlur) !== "false";
    for (var l = 1; l <= show.numLayers; l++) { var layer = show.layer(l); try { layer.outPoint = duration; } catch (eOut) {} if (String(layer.comment).indexOf("COMPX_SHOWCASE_CARD|") === 0) { layer.motionBlur = show.motionBlur; layer.autoOrient = (faceCamera !== false && String(faceCamera) !== "false") ? AutoOrientType.CAMERA_OR_POINT_OF_INTEREST : AutoOrientType.NO_AUTO_ORIENT; } }
    app.endUndoGroup(); return toolResult(true, "Showcase controls updated.");
  } catch (e) { try { app.endUndoGroup(); } catch (eEnd) {} return toolResult(false, String(e)); }
}
function ae_motionShowcaseRender() {
  try { var show = compxShowcaseFind(getActiveComp()); if (!show) return toolResult(false, "Open a CompX 3D Showcase composition first."); app.project.renderQueue.items.add(show); return toolResult(true, "Showcase added to Render Queue."); } catch (e) { return toolResult(false, String(e)); }
}


// ================================================================
// COMPX ORBIT STUDIO – PREMIERE EDITION (Stable MVP)
// Documented Premiere APIs first; optional operations fail safely.
// ================================================================
function pproRequireSequence() {
  if (!isPremiere() || !app.project) return null;
  return app.project.activeSequence;
}
function pproSelectedClips(seq) {
  var out = [];
  if (!seq) return out;
  try {
    var selected = seq.getSelection();
    if (selected && selected.length) for (var i = 0; i < selected.length; i++) out.push(selected[i]);
  } catch (e) { compxAuditFallback("PPRO_SELECTION_001", e); }
  return out;
}
function ppro_getWorkspaceState() {
  try {
    if (!isPremiere() || !app.project) return dataResult(false, "Open a Premiere Pro project first.");
    var seq = app.project.activeSequence;
    if (!seq) return dataResult(true, "No active sequence.", '{"hasSequence":false,"selection":0}');
    var sel = pproSelectedClips(seq), pos = seq.getPlayerPosition();
    var json = '{"hasSequence":true,"name":"' + escapeJson(seq.name) + '","selection":' + sel.length +
      ',"playhead":' + Number(pos.seconds || 0) + ',"videoTracks":' + seq.videoTracks.numTracks +
      ',"audioTracks":' + seq.audioTracks.numTracks + '}';
    return dataResult(true, null, json);
  } catch (e) { return dataResult(false, String(e)); }
}
function ppro_getActivitySignature() {
  try {
    var seq = pproRequireSequence();
    if (!seq) return '{"hasComp":false}';
    var pos = seq.getPlayerPosition(), sel = pproSelectedClips(seq);
    var sig = String(seq.sequenceID || seq.name) + "|" + String(pos.ticks || pos.seconds) + "|" + sel.length;
    return '{"hasComp":true,"compName":"' + escapeJson(seq.name) + '","signature":"' + escapeJson(sig) + '"}';
  } catch (e) { return '{"hasComp":false}'; }
}
function ppro_removeSelected(ripple) {
  try {
    var seq = pproRequireSequence(); if (!seq) return toolResult(false, "Open a sequence first.");
    var clips = pproSelectedClips(seq); if (!clips.length) return toolResult(false, "Select one or more timeline clips.");
    var done = 0;
    for (var i = clips.length - 1; i >= 0; i--) { try { clips[i].remove(!!ripple, true); done++; } catch (e) { compxAuditFallback("PPRO_REMOVE_001", e); } }
    return toolResult(done > 0, done + " clip(s) " + (ripple ? "ripple deleted." : "removed."));
  } catch (e) { return toolResult(false, String(e)); }
}
function ppro_setSelectedEnabled(enabled) {
  try {
    var seq = pproRequireSequence(); if (!seq) return toolResult(false, "Open a sequence first.");
    var clips = pproSelectedClips(seq); if (!clips.length) return toolResult(false, "Select timeline clips first.");
    var done = 0;
    for (var i = 0; i < clips.length; i++) { try { clips[i].disabled = !enabled; done++; } catch (e) { compxAuditFallback("PPRO_ENABLE_001", e); } }
    return toolResult(done > 0, done + " clip(s) " + (enabled ? "enabled." : "disabled."));
  } catch (e) { return toolResult(false, String(e)); }
}
function ppro_setToFrameSize() {
  try {
    var seq = pproRequireSequence(); if (!seq) return toolResult(false, "Open a sequence first.");
    var clips = pproSelectedClips(seq); if (!clips.length) return toolResult(false, "Select timeline clips first.");
    var done = 0;
    for (var i = 0; i < clips.length; i++) { try { if (clips[i].projectItem && clips[i].projectItem.setScaleToFrameSize) { clips[i].projectItem.setScaleToFrameSize(); done++; } } catch (e) { compxAuditFallback("PPRO_FRAME_SIZE_001", e); } }
    return toolResult(done > 0, done + " source item(s) set to frame size.");
  } catch (e) { return toolResult(false, String(e)); }
}
function ppro_findComponent(clip, name) {
  try { for (var i = 0; i < clip.components.numItems; i++) { var c = clip.components[i]; if (String(c.displayName).toLowerCase() === String(name).toLowerCase()) return c; } } catch (e) { compxAuditFallback("PPRO_COMPONENT_001", e); }
  return null;
}
function ppro_findProperty(component, names) {
  if (!component) return null;
  try { for (var i = 0; i < component.properties.numItems; i++) { var p = component.properties[i], dn = String(p.displayName).toLowerCase(); for (var n = 0; n < names.length; n++) if (dn === String(names[n]).toLowerCase()) return p; } } catch (e) { compxAuditFallback("PPRO_PROPERTY_001", e); }
  return null;
}
function ppro_applyMotionPreset(kind) {
  try {
    var seq = pproRequireSequence(); if (!seq) return toolResult(false, "Open a sequence first.");
    var clips = pproSelectedClips(seq); if (!clips.length) return toolResult(false, "Select timeline clips first.");
    var done = 0;
    for (var i = 0; i < clips.length; i++) {
      try {
        var motion = ppro_findComponent(clips[i], "Motion"); if (!motion) continue;
        var scale = ppro_findProperty(motion, ["Scale"]), rotation = ppro_findProperty(motion, ["Rotation"]), position = ppro_findProperty(motion, ["Position"]);
        if (kind === "reset") { if (position) position.setValue([0.5,0.5], true); if (scale) scale.setValue(100, true); if (rotation) rotation.setValue(0, true); }
        else if (kind === "center" && position) position.setValue([0.5,0.5], true);
        else if (kind === "scale90" && scale) scale.setValue(90, true);
        else if (kind === "scale110" && scale) scale.setValue(110, true);
        else if (kind === "rotateLeft" && rotation) rotation.setValue(-90, true);
        else if (kind === "rotateRight" && rotation) rotation.setValue(90, true);
        done++;
      } catch (ce) { compxAuditFallback("PPRO_MOTION_001", ce); }
    }
    return toolResult(done > 0, "Motion preset applied to " + done + " clip(s).");
  } catch (e) { return toolResult(false, String(e)); }
}
function ppro_addMarker(name, comment, colorIndex) {
  try {
    var seq = pproRequireSequence(); if (!seq) return toolResult(false, "Open a sequence first.");
    var pos = seq.getPlayerPosition(), marker = seq.markers.createMarker(Number(pos.seconds));
    marker.name = name || "CompX Marker"; marker.comments = comment || "";
    try { if (marker.setColorByIndex) marker.setColorByIndex(Number(colorIndex) || 0); } catch (ce) { compxAuditFallback("PPRO_MARKER_COLOR_001", ce); }
    return toolResult(true, "Marker added at playhead.");
  } catch (e) { return toolResult(false, String(e)); }
}
function ppro_createBin(name) {
  try { if (!isPremiere() || !app.project) return toolResult(false, "Open a project first."); var n = String(name || "CompX Bin"); app.project.rootItem.createBin(n); return toolResult(true, "Bin created: " + n); } catch (e) { return toolResult(false, String(e)); }
}
function ppro_importMediaDialog() {
  try {
    if (!isPremiere() || !app.project) return toolResult(false, "Open a project first.");
    var files = File.openDialog("Import media", "All files:*.*", true); if (!files || !files.length) return toolResult(false, "Import cancelled.");
    var paths = []; for (var i = 0; i < files.length; i++) paths.push(files[i].fsName);
    app.project.importFiles(paths, true, app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem, false);
    return toolResult(true, paths.length + " file(s) imported.");
  } catch (e) { return toolResult(false, String(e)); }
}
function ppro_getOrCreateBin(root, name) {
  try { for (var i = 0; i < root.children.numItems; i++) { var it = root.children[i]; if (it.type === ProjectItemType.BIN && it.name === name) return it; } } catch (e) { compxAuditFallback("PPRO_BIN_FIND_001", e); }
  try { return root.createBin(name); } catch (e2) { return null; }
}
function ppro_autoOrganizeProject() {
  try {
    if (!isPremiere() || !app.project) return toolResult(false, "Open a project first.");
    var root = app.project.rootItem, bins = {Video:ppro_getOrCreateBin(root,"Video"),Audio:ppro_getOrCreateBin(root,"Audio"),Images:ppro_getOrCreateBin(root,"Images"),Sequences:ppro_getOrCreateBin(root,"Sequences")};
    var items = [], i; for (i = 0; i < root.children.numItems; i++) items.push(root.children[i]); var moved = 0;
    for (i = 0; i < items.length; i++) {
      var it = items[i]; try { if (it.type === ProjectItemType.BIN) continue; var target = null, path = it.getMediaPath ? String(it.getMediaPath() || "").toLowerCase() : "";
        if (it.type === ProjectItemType.SEQUENCE) target = bins.Sequences;
        else if (/\.(wav|mp3|aif|aiff|m4a|aac)$/.test(path)) target = bins.Audio;
        else if (/\.(png|jpg|jpeg|gif|tif|tiff|psd|ai)$/.test(path)) target = bins.Images;
        else target = bins.Video;
        if (target && it.moveBin) { it.moveBin(target); moved++; }
      } catch (ie) { compxAuditFallback("PPRO_ORGANIZE_001", ie); }
    }
    return toolResult(true, moved + " project item(s) organized.");
  } catch (e) { return toolResult(false, String(e)); }
}
function ppro_listSequences() {
  try {
    if (!isPremiere() || !app.project) return dataResult(false, "Open a project first.");
    var seqs = app.project.sequences, out = [];
    for (var i = 0; i < seqs.numSequences; i++) { var s = seqs[i]; out.push('{"id":"' + escapeJson(String(s.sequenceID)) + '","name":"' + escapeJson(s.name) + '","active":' + (app.project.activeSequence && app.project.activeSequence.sequenceID === s.sequenceID ? 'true':'false') + '}'); }
    return dataResult(true, out.length + " sequence(s).", "[" + out.join(",") + "]");
  } catch (e) { return dataResult(false, String(e)); }
}
function ppro_duplicateActiveSequence(restoreOriginal) {
  try {
    var seq = pproRequireSequence();
    if (!seq) return toolResult(false, "Open a sequence first.");
    if (!seq.clone) return toolResult(false, "Sequence clone is unavailable in this Premiere version.");
    var id = String(seq.sequenceID || "");
    var selected = [];
    try {
      var sel = seq.getSelection();
      if (sel) for (var i = 0; i < sel.length; i++) selected.push(sel[i]);
    } catch (_) {}
    var ticks = "0";
    try { ticks = String(seq.getPlayerPosition().ticks); } catch (_) {}
    seq.clone();
    if (restoreOriginal !== false && id && app.project && app.project.openSequence) {
      try {
        var reopened = app.project.openSequence(id);
        if (reopened === false) return toolResult(false, "Safety copy created but the original sequence could not be reopened.");
        var original = app.project.activeSequence;
        if (!original || String(original.sequenceID) !== id) return toolResult(false, "Safety copy created but focus did not return to the original sequence.");
        try {
          var pos = new Time();
          pos.ticks = ticks;
          original.setPlayerPosition(pos);
        } catch (_) {
          try { original.setPlayerPosition(ticks); } catch (_2) {}
        }
        for (var j = 0; j < selected.length; j++) {
          try { selected[j].setSelected(true, true); } catch (_) {}
        }
      } catch (e2) {
        return toolResult(false, String(e2));
      }
    }
    return toolResult(true, "Sequence duplicated.");
  } catch (e) { return toolResult(false, String(e)); }
}
function ppro_renameActiveSequence(name) {
  try { var seq = pproRequireSequence(); if (!seq) return toolResult(false, "Open a sequence first."); var n = String(name || ""); if (!n) return toolResult(false, "Enter a sequence name."); seq.name = n; return toolResult(true, "Sequence renamed."); } catch (e) { return toolResult(false, String(e)); }
}
function ppro_openSequence(sequenceId) {
  try { if (!isPremiere() || !app.project) return toolResult(false, "Open a project first."); app.project.openSequence(String(sequenceId)); return toolResult(true, "Sequence opened."); } catch (e) { return toolResult(false, String(e)); }
}
function ppro_createSequenceFromSelection(name) {
  try {
    var seq = pproRequireSequence(); if (!seq) return toolResult(false, "Open a sequence and select clips first.");
    var clips = pproSelectedClips(seq); if (!clips.length) return toolResult(false, "Select timeline clips first.");
    var items = []; for (var i = 0; i < clips.length; i++) if (clips[i].projectItem) items.push(clips[i].projectItem);
    if (!items.length || !app.project.createNewSequenceFromClips) return toolResult(false, "No usable source clips selected.");
    app.project.createNewSequenceFromClips(String(name || "CompX Sequence"), items, app.project.rootItem);
    return toolResult(true, "Sequence created from " + items.length + " clip(s).");
  } catch (e) { return toolResult(false, String(e)); }
}


// =========================================================================
// MachiCut Features ExtendScript Port
// =========================================================================
/**
 * MachiCut — ExtendScript host (index.jsx)
 * Runs inside Premiere Pro's scripting engine.
 */

// ── JSON polyfill (ExtendScript / ES3 — JSON may not be built-in) ────────────
(function () {
    if (typeof JSON !== 'undefined' && JSON.stringify && JSON.parse) return;
    if (typeof JSON === 'undefined') JSON = {};

    function quote(s) {
        return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                       .replace(/\n/g, '\\n').replace(/\r/g, '\\r')
                       .replace(/\t/g, '\\t') + '"';
    }
    function str(val) {
        if (val === null || val === undefined) return 'null';
        var t = typeof val;
        if (t === 'boolean') return val ? 'true' : 'false';
        if (t === 'number')  return isFinite(val) ? String(val) : 'null';
        if (t === 'string')  return quote(val);
        if (t === 'object') {
            var i, out;
            // Array
            if (val.constructor === Array) {
                out = [];
                for (i = 0; i < val.length; i++) out.push(str(val[i]));
                return '[' + out.join(',') + ']';
            }
            // Plain object
            out = [];
            for (var k in val) {
                if (val.hasOwnProperty(k)) out.push(quote(k) + ':' + str(val[k]));
            }
            return '{' + out.join(',') + '}';
        }
        return 'null';
    }

    if (!JSON.stringify) JSON.stringify = str;
    // JSON.parse is required for our host functions - throw clear error if not available
    if (!JSON.parse) {
        function missingJSONError() {
            throw new Error('JSON.parse is not available in this environment. This extension requires a modern ExtendScript environment with JSON support.');
        }
        JSON.parse = missingJSONError;
    }
}());

// ── Utilities ────────────────────────────────────────────────────────────────

// Locale-independent Motion-component lookup. The Premiere component
// `displayName` is localized — "Trajectoire" (FR), "Bewegung" (DE),
// "Movimiento" (ES) — so a literal === 'Motion' check fails and we
// silently leave the clip's Position at Premiere's default of (0.5, 0.5),
// stacking every caption at the centre of the frame.
//
// `matchName` is Adobe's never-localized internal identifier. We try it
// first, fall back to the English displayName for older builds that
// might not expose matchName, then to clip.components[0] which is
// reliably Motion on default video clips per Adobe's clip layout.
function _findMotionComp(clip) {
    if (!clip || !clip.components) return null;
    var n = clip.components.numItems;
    for (var i = 0; i < n; i++) {
        try {
            var mn = String(clip.components[i].matchName || '');
            if (mn === 'AE.ADBE Motion' || mn === 'Motion') return clip.components[i];
        } catch (_) {}
    }
    for (var j = 0; j < n; j++) {
        try { if (clip.components[j].displayName === 'Motion') return clip.components[j]; } catch (_) {}
    }
    try { return clip.components[0]; } catch (_) { return null; }
}

// Locale-independent Motion-property lookup. The Position / Scale /
// Rotation property names are also localized in non-English Premiere.
// Try matchName, then displayName, then a known fixed index — Motion's
// property layout is documented as [0]=Position, [1]=Scale, [2]=ScaleWidth,
// [4]=Rotation, [5]=Anchor, so `fallbackIdx` rescues us when both
// name lookups fail.
function _findMotionProp(motComp, name, fallbackIdx) {
    if (!motComp || !motComp.properties) return null;
    var n = motComp.properties.numItems;
    for (var i = 0; i < n; i++) {
        try {
            var p = motComp.properties[i];
            if (p.matchName === name || p.displayName === name) return p;
        } catch (_) {}
    }
    if (typeof fallbackIdx === 'number' && fallbackIdx >= 0 && fallbackIdx < n) {
        try { return motComp.properties[fallbackIdx]; } catch (_) {}
    }
    return null;
}

function getActiveSequence() {
    if (!app.project || !app.project.activeSequence) {
        throw new Error("No active sequence found. Please open a sequence first.");
    }
    return app.project.activeSequence;
}

function getActiveSeqId() {
    var seq = getActiveSequence();
    return JSON.stringify({ id: seq.sequenceID, name: seq.name });
}

function _getSeqById(seqId) {
    if (!seqId) return getActiveSequence();
    try {
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            try { if (String(seqs[i].sequenceID) === String(seqId)) return seqs[i]; } catch (_) {}
        }
    } catch (_) {}
    return getActiveSequence();
}

function ticksToSeconds(ticks) {
    // Premiere stores time in ticks; 254016000000 ticks = 1 second
    return parseInt(ticks, 10) / 254016000000;
}

function secondsToTicks(seconds) {
    return Math.round(seconds * 254016000000).toString();
}

// ── Media Path ───────────────────────────────────────────────────────────────

/**
 * Returns the file path of the first media clip found in the active sequence.
 * Checks video tracks first, then audio tracks.
 * FFmpeg can read video files directly — no export step needed.
 */
function getSequenceMediaPath() {
    var seq = getActiveSequence();

    // Video tracks first (most clips with audio live here)
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (clip.projectItem) {
                var mediaPath = clip.projectItem.getMediaPath();
                if (mediaPath) return mediaPath;
            }
        }
    }

    // Audio-only tracks fallback
    for (var at = 0; at < seq.audioTracks.numTracks; at++) {
        var atrack = seq.audioTracks[at];
        for (var ac = 0; ac < atrack.clips.numItems; ac++) {
            var aclip = atrack.clips[ac];
            if (aclip.projectItem) {
                var amediaPath = aclip.projectItem.getMediaPath();
                if (amediaPath) return amediaPath;
            }
        }
    }

    throw new Error("No media files found in the active sequence. Please add clips to the timeline first.");
}

/**
 * Returns { mediaPath, sequenceOffset } for a specific track.
 * sequenceOffset = clip.start (seq seconds) − clip.inPoint (source seconds)
 * The client adds this offset to every FFmpeg timestamp so that source-file
 * silence positions map correctly onto sequence time.
 * trackTypeStr: 'video' | 'audio' | 'all'
 * trackIndexNum: 0-based index, or -1 for 'all'
 */
function getTrackMediaInfo(trackTypeStr, trackIndexNum) {
    var seq = getActiveSequence();
    var clip = null;

    if (trackTypeStr === 'all' || trackIndexNum < 0) {
        // Fall back to first available clip (same logic as getSequenceMediaPath)
        outer:
        for (var tv = 0; tv < seq.videoTracks.numTracks; tv++) {
            for (var cv = 0; cv < seq.videoTracks[tv].clips.numItems; cv++) {
                var cand = seq.videoTracks[tv].clips[cv];
                if (cand.projectItem && cand.projectItem.getMediaPath()) { clip = cand; break outer; }
            }
        }
        if (!clip) {
            outer2:
            for (var ta = 0; ta < seq.audioTracks.numTracks; ta++) {
                for (var ca = 0; ca < seq.audioTracks[ta].clips.numItems; ca++) {
                    var candA = seq.audioTracks[ta].clips[ca];
                    if (candA.projectItem && candA.projectItem.getMediaPath()) { clip = candA; break outer2; }
                }
            }
        }
    } else if (trackTypeStr === 'video') {
        var vt = seq.videoTracks[trackIndexNum];
        if (vt) {
            for (var vc = 0; vc < vt.clips.numItems; vc++) {
                var vc2 = vt.clips[vc];
                if (vc2.projectItem && vc2.projectItem.getMediaPath()) { clip = vc2; break; }
            }
        }
    } else { // audio
        var at2 = seq.audioTracks[trackIndexNum];
        if (at2) {
            for (var ac2 = 0; ac2 < at2.clips.numItems; ac2++) {
                var ac3 = at2.clips[ac2];
                if (ac3.projectItem && ac3.projectItem.getMediaPath()) { clip = ac3; break; }
            }
        }
    }

    if (!clip) throw new Error("No media found on selected track.");

    var seqStartSec = ticksToSeconds(clip.start.ticks);
    var srcStartSec = ticksToSeconds(clip.inPoint.ticks);

    return JSON.stringify({
        mediaPath:      clip.projectItem.getMediaPath(),
        sequenceOffset: seqStartSec - srcStartSec
    });
}

/**
 * Returns a list of tracks that have clips, for the UI track selector.
 */
function getTrackList() {
    try {
        var seq = getActiveSequence();
        var tracks = [];
        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            if (seq.videoTracks[v].clips.numItems > 0) {
                tracks.push({ type: 'video', index: v, name: 'V' + (v + 1) });
            }
        }
        for (var a = 0; a < seq.audioTracks.numTracks; a++) {
            if (seq.audioTracks[a].clips.numItems > 0) {
                tracks.push({ type: 'audio', index: a, name: 'A' + (a + 1) });
            }
        }
        return JSON.stringify(tracks);
    } catch (e) {
        return JSON.stringify([]);
    }
}

/**
 * Returns the temp directory path.
 */
function getTempDir() {
    var tmp = Folder.temp;
    return tmp.fsName;
}

/**
 * Returns the active sequence's file path (the project file location).
 */
function getProjectPath() {
    return app.project.path;
}

function exportCaptionsJson(jsonStr) {
    var f = File.saveDialog('Export Captions', 'JSON files:*.json,All files:*');
    if (!f) return 'cancelled';
    if (!/\.json$/i.test(f.fsName)) f = new File(f.fsName + '.json');
    f.encoding = 'UTF-8';
    f.open('w');
    f.write(jsonStr);
    f.close();
    return 'ok';
}

function createCaptionChapterMarkers(markersJson) {
    try {
        var seq = getActiveSequence();
        var items = JSON.parse(markersJson || '[]');
        var created = 0;
        for (var i = 0; i < items.length; i++) {
            var time = Number(items[i].time);
            if (!isFinite(time) || time < 0) continue;
            var marker = seq.markers.createMarker(time);
            marker.name = String(items[i].name || ('Chapter ' + (i + 1)));
            marker.comments = String(items[i].comment || '');
            try { if (marker.setColorByIndex) marker.setColorByIndex(3); } catch (_) {}
            created++;
        }
        return JSON.stringify({ created: created });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

function importCaptionsJson() {
    var f = File.openDialog('Import Captions', 'JSON files:*.json,All files:*', false);
    if (!f) return '';
    f.encoding = 'UTF-8';
    f.open('r');
    var content = f.read();
    f.close();
    return content;
}



/**
 * Saves the current project and returns its path.
 * Called before reading the .prproj for XML manipulation.
 */
function saveAndGetProjectPath() {
    try { app.project.save(); } catch (_) {}
    return app.project.path;
}

/**
 * importModel4Prproj(tempPrprojPath, binPath)
 *
 * Imports a temp .prproj file that contains MC_m4_* nested sequences.
 * importFiles() does NOT open sequences as timeline tabs.
 * Returns JSON { imported: N, errors: [] }
 */
/**
 * importModel4Pngs(pngPathsJson)
 * Imports PNG files into the MachiCut/Captions bin so they appear in the
 * .prproj XML. Must be called (and project saved) before reading the prproj
 * to find MasterClip ObjectURefs for nested sequence generation.
 */
function importModel4Pngs(pngPathsJson, runBinName) {
    try {
        var paths       = JSON.parse(pngPathsJson);
        var machiCutBin = _getOrCreateBin(app.project.rootItem, 'MachiCut');
        var m4Bin       = _getOrCreateBin(machiCutBin, 'Captions');
        // Each run gets its own sub-bin named after the sequence (MC_YYYY-MM-DD_...)
        var runBin = runBinName ? _getOrCreateBin(m4Bin, runBinName) : m4Bin;
        _importIntoBin(runBin, paths, true); // noDedup: each run uses a fresh timestamped dir
        return JSON.stringify({ ok: true });
    } catch (e) {
        return JSON.stringify({ error: 'importModel4Pngs: ' + e.message });
    }
}

/**
 * importModel4Prproj(tempPrprojPath)
 * Imports a temp .prproj that contains MC_m4_* nested sequences into the
 * MachiCut/Captions/Nested bin. importFiles() does NOT open sequences as tabs.
 */
function importModel4Prproj(tempPrprojPath) {
    try {
        var machiCutBin = _getOrCreateBin(app.project.rootItem, 'MachiCut');
        var m4Bin       = _getOrCreateBin(machiCutBin, 'Captions');
        var m4NestBin   = _getOrCreateBin(m4Bin, 'Nested');
        app.project.importFiles([tempPrprojPath], true, m4NestBin, false);
        return JSON.stringify({ imported: true });
    } catch (e) {
        return JSON.stringify({ error: 'importModel4Prproj: ' + e.message });
    }
}

/**
 * placeModel4CaptionsSequence(seqName, mainTrackStr, seqId)
 *
 * After importModel4Prproj(), ONE "MachiCut_Captions" sequence is in the project
 * with ALL clips pre-placed on 3 internal tracks. This function places it on the
 * main timeline with a single overwriteClip call at T=0.
 */
function placeModel4CaptionsSequence(seqName, mainTrackStr, pinnedSeqId) {
    var _dbg = 'init';
    try {
        var seq            = _getSeqById(pinnedSeqId || '');
        var baseTrackIndex = parseInt(mainTrackStr || '2', 10) - 1;

        // ── Find the MachiCut_Captions sequence project item ──────────────────
        // Search app.project.sequences (reliable) rather than scanning the panel tree.
        _dbg = 'find-seq';
        var captionsItem = null;
        var seqs = app.project.sequences;
        var allSeqNames = [];
        for (var si = 0; si < seqs.numSequences; si++) {
            try {
                var sname = String(seqs[si].name || '');
                allSeqNames.push(sname);
                if (sname === seqName || sname.indexOf(seqName) === 0) {
                    captionsItem = seqs[si].projectItem;
                    break;
                }
            } catch (_) {}
        }
        if (!captionsItem) {
            // Fallback: scan project panel tree
            var scanForItem = function (b) {
                if (!b || !b.children) return;
                for (var i = 0; i < b.children.numItems; i++) {
                    var item = b.children[i];
                    try { if (item.type === 2) { scanForItem(item); } } catch (_) {}
                    try { if (item.name === seqName) { captionsItem = item; } } catch (_) {}
                    if (captionsItem) return;
                }
            };
            scanForItem(app.project.rootItem);
        }
        if (!captionsItem) {
            return JSON.stringify({
                error: 'Captions sequence not found: ' + seqName,
                allSeqs: allSeqNames.join(' | ')
            });
        }

        // ── Ensure target track exists ────────────────────────────────────────
        _dbg = 'tracks';
        while (seq.videoTracks.numTracks <= baseTrackIndex) {
            try { seq.videoTracks.add(); } catch (_) { break; }
        }

        // ── Clear any previous MachiCut_Captions clip from this track ─────────
        _dbg = 'clear';
        var trk = seq.videoTracks[baseTrackIndex];
        for (var di = trk.clips.numItems - 1; di >= 0; di--) {
            try {
                var cn = trk.clips[di].projectItem ? trk.clips[di].projectItem.name : '';
                if (cn === seqName || cn.indexOf('MachiCut_Captions') === 0) {
                    trk.clips[di].remove(false, false);
                }
            } catch (_) {}
        }

        // ── ONE overwriteClip at T=0 ──────────────────────────────────────────
        _dbg = 'place';
        var startTime = new Time(); startTime.ticks = '0';
        trk.overwriteClip(captionsItem, startTime);

        // ── Remove any audio companion spawned by overwriteClip ───────────────
        _dbg = 'audio';
        try {
            for (var asi = 0; asi < seq.audioTracks.numTracks; asi++) {
                var atrk = seq.audioTracks[asi];
                for (var aci = atrk.clips.numItems - 1; aci >= 0; aci--) {
                    try {
                        var acn = atrk.clips[aci].projectItem ? atrk.clips[aci].projectItem.name : '';
                        if (acn === seqName) atrk.clips[aci].remove(false, false);
                    } catch (_) {}
                }
            }
        } catch (_) {}

        return JSON.stringify({ placed: 1 });
    } catch (e) {
        return JSON.stringify({ error: 'placeModel4CaptionsSequence[' + _dbg + ']: ' + e.message });
    }
}

/**
 * Writes a standalone ScaleBounce.prfpset to filePath.
 * Scale keyframes (29.97fps bezier): 75% → 115% → 100% over first 3 frames.
 * Premiere remaps keyframe times relative to AnchorInPoint when applying to any clip,
 * so the same file works regardless of where the clip sits in the sequence.
 */
function _writeScaleBouncePreset(filePath) {
    var A  = '914456685542400';   // AnchorInPoint (arbitrary reference frame)
    var A1 = '914465161209600';   // A + 1 frame at 29.97 fps
    var A2 = '914473636876800';   // A + 2 frames
    var AO = '915719559955200';   // AnchorOutPoint (~5 s after A)
    // Bezier tangents captured from Premiere's auto-smooth computation for 75→115→100
    var kf = A  + ',75.,0,0,0,0.16666666666666666,1198.8011988053117,0.16666666666666666;' +
             A1 + ',115.,0,0,1198.8011988053117,0.16666666666666666,-449.55044954586504,0.16666666666666666;' +
             A2 + ',100.,0,0,-449.55044954586504,0.16666666666666666,0,0.16666666666666666;';
    var ps  = '-91445760000000000,0.5:0.5,0,0,0,0,0,0,5,4,0,0,0,0'; // Position default
    var ss  = '-91445760000000000,100.,0,0,0,0,0,0';                  // Scale default
    var rs  = '-91445760000000000,0.,0,0,0,0,0,0';                    // Rotation/crop default
    var bs  = '-91445760000000000,true,0,0,0,0,0,0';                  // Bool default
    var as  = '-91445760000000000,0.,0,0,0,0,0,0';                    // Anti-flicker default
    function _p(id, cls, ver, ctrl, pid, name, kfs, isTV, sk, cv, lo, hi, hiUI, extra) {
        var s = '\t<VideoComponentParam ObjectID="' + id + '" ClassID="' + cls + '" Version="' + ver + '">\n';
        s += '\t\t<Keyframes>' + (kfs || '') + '</Keyframes>\n';
        s += '\t\t<IsTimeVarying>' + (isTV ? 'true' : 'false') + '</IsTimeVarying>\n';
        s += '\t\t<IsLocked>false</IsLocked>\n\t\t<DiscontinuousInterpolate>false</DiscontinuousInterpolate>\n';
        s += '\t\t<ParameterControlType>' + ctrl + '</ParameterControlType>\n';
        s += '\t\t<StartKeyframe>' + sk + '</StartKeyframe>\n';
        s += '\t\t<CurrentValue>' + cv + '</CurrentValue>\n';
        if (lo !== undefined) s += '\t\t<LowerBound>' + lo + '</LowerBound>\n\t\t<UpperBound>' + hi + '</UpperBound>\n';
        if (hiUI !== undefined) s += '\t\t<UpperUIBound>' + hiUI + '</UpperUIBound>\n';
        s += '\t\t<ParameterID>' + pid + '</ParameterID>\n\t\t<UnitsString></UnitsString>\n';
        s += '\t\t<Node Version="1">\n\t\t</Node>\n\t\t<Name>' + name + '</Name>\n\t</VideoComponentParam>\n';
        return s + (extra || '');
    }
    var xml =
'<?xml version="1.0" encoding="UTF-8"?>\n' +
'<PremiereData Version="3">\n' +
'\t<FilterPreset ObjectRef="1"/>\n' +
'\t<FilterPreset ObjectID="1" ClassID="ee52a7d2-069e-47f7-aa30-e3e3286b65a3" Version="3">\n' +
'\t\t<Description></Description>\n\t\t<FilterMatchName>AE.ADBE Motion</FilterMatchName>\n' +
'\t\t<Component ObjectRef="2"/>\n' +
'\t\t<MediaType>228cda18-3625-4d2d-951e-348879e4ed93</MediaType>\n' +
'\t\t<AnchorInPoint>' + A + '</AnchorInPoint>\n' +
'\t\t<AnchorOutPoint>' + AO + '</AnchorOutPoint>\n' +
'\t\t<Speed>1.</Speed>\n\t\t<TransitionDuration>0</TransitionDuration>\n' +
'\t\t<Node Version="1">\n\t\t</Node>\n\t\t<Type>0</Type>\n\t</FilterPreset>\n' +
'\t<VideoFilterComponent ObjectID="2" ClassID="d10da199-beea-4dd1-b941-ed3a78766d50" Version="9">\n' +
'\t\t<Component Version="7">\n\t\t\t<Bypass>false</Bypass>\n\t\t\t<DisplayName>Motion</DisplayName>\n' +
'\t\t\t<Params Version="1">\n' +
'\t\t\t\t<Param Index="0" ObjectRef="3"/>\n\t\t\t\t<Param Index="1" ObjectRef="4"/>\n' +
'\t\t\t\t<Param Index="2" ObjectRef="5"/>\n\t\t\t\t<Param Index="3" ObjectRef="6"/>\n' +
'\t\t\t\t<Param Index="4" ObjectRef="7"/>\n\t\t\t\t<Param Index="5" ObjectRef="8"/>\n' +
'\t\t\t\t<Param Index="6" ObjectRef="9"/>\n\t\t\t\t<Param Index="7" ObjectRef="10"/>\n' +
'\t\t\t\t<Param Index="8" ObjectRef="11"/>\n\t\t\t\t<Param Index="9" ObjectRef="12"/>\n' +
'\t\t\t\t<Param Index="10" ObjectRef="13"/>\n\t\t\t</Params>\n' +
'\t\t\t<Intrinsic>true</Intrinsic>\n\t\t\t<InstanceName></InstanceName>\n' +
'\t\t\t<ArchivedType>0</ArchivedType>\n\t\t\t<Node Version="1">\n\t\t\t</Node>\n\t\t\t<ID>0</ID>\n\t\t</Component>\n' +
'\t\t<MatchName>AE.ADBE Motion</MatchName>\n\t\t<VideoFilterType>2</VideoFilterType>\n' +
'\t\t<PremiereFilterPrivateData Encoding="base64" Checksum="4294908813">AQA=</PremiereFilterPrivateData>\n' +
'\t</VideoFilterComponent>\n' +
// Position (no KF)
'\t<PointComponentParam ObjectID="3" ClassID="ca81d347-309b-44d2-acc7-1c572efb973c" Version="4">\n' +
'\t\t<Keyframes></Keyframes>\n\t\t<IsTimeVarying>false</IsTimeVarying>\n\t\t<IsLocked>false</IsLocked>\n' +
'\t\t<DiscontinuousInterpolate>false</DiscontinuousInterpolate>\n\t\t<ParameterControlType>6</ParameterControlType>\n' +
'\t\t<StartKeyframe>' + ps + '</StartKeyframe>\n\t\t<CurrentValue>0,0</CurrentValue>\n' +
'\t\t<ParameterID>1</ParameterID>\n\t\t<UnitsString></UnitsString>\n' +
'\t\t<Node Version="1">\n\t\t</Node>\n\t\t<Name>Position</Name>\n\t</PointComponentParam>\n' +
// Scale (WITH KF)
_p('4','fe47129e-6c94-4fc0-95d5-c056a517aaf3','10','2','2','Scale',kf,true,ss,'100.','0.','10000.','200.') +
// Scale Width
_p('5','fe47129e-6c94-4fc0-95d5-c056a517aaf3','10','2','3','Scale Width','',false,ss,'0.','0.','10000.','200.') +
// Uniform Scale (bool)
'\t<VideoComponentParam ObjectID="6" ClassID="cc12343e-f113-4d3b-ae05-b287db77d461" Version="10">\n' +
'\t\t<Keyframes></Keyframes>\n\t\t<IsTimeVarying>false</IsTimeVarying>\n\t\t<IsLocked>false</IsLocked>\n' +
'\t\t<DiscontinuousInterpolate>false</DiscontinuousInterpolate>\n\t\t<ParameterControlType>4</ParameterControlType>\n' +
'\t\t<StartKeyframe>' + bs + '</StartKeyframe>\n\t\t<CurrentValue>false</CurrentValue>\n' +
'\t\t<LowerBound>false</LowerBound>\n\t\t<UpperBound>true</UpperBound>\n' +
'\t\t<ParameterID>4</ParameterID>\n\t\t<UnitsString></UnitsString>\n' +
'\t\t<Node Version="1">\n\t\t</Node>\n\t\t<Name> </Name>\n\t</VideoComponentParam>\n' +
// Rotation
_p('7','fe47129e-6c94-4fc0-95d5-c056a517aaf3','10','3','5','Rotation','',false,rs,'0.','-32768.','32767.',undefined) +
// Anchor Point
'\t<PointComponentParam ObjectID="8" ClassID="ca81d347-309b-44d2-acc7-1c572efb973c" Version="4">\n' +
'\t\t<Keyframes></Keyframes>\n\t\t<IsTimeVarying>false</IsTimeVarying>\n\t\t<IsLocked>false</IsLocked>\n' +
'\t\t<DiscontinuousInterpolate>false</DiscontinuousInterpolate>\n\t\t<ParameterControlType>6</ParameterControlType>\n' +
'\t\t<StartKeyframe>' + ps + '</StartKeyframe>\n\t\t<CurrentValue>0,0</CurrentValue>\n' +
'\t\t<ParameterID>6</ParameterID>\n\t\t<UnitsString></UnitsString>\n' +
'\t\t<Node Version="1">\n\t\t</Node>\n\t\t<Name>Anchor Point</Name>\n\t</PointComponentParam>\n' +
// Anti-flicker
'\t<VideoComponentParam ObjectID="9" ClassID="a4ff2d6e-7ac2-44f8-9d52-17d9ca50e542" Version="10">\n' +
'\t\t<Keyframes></Keyframes>\n\t\t<IsTimeVarying>false</IsTimeVarying>\n\t\t<IsLocked>false</IsLocked>\n' +
'\t\t<DiscontinuousInterpolate>false</DiscontinuousInterpolate>\n\t\t<ParameterControlType>8</ParameterControlType>\n' +
'\t\t<StartKeyframe>' + as + '</StartKeyframe>\n\t\t<CurrentValue>0.</CurrentValue>\n' +
'\t\t<LowerBound>0.</LowerBound>\n\t\t<UpperBound>1.</UpperBound>\n' +
'\t\t<ParameterID>7</ParameterID>\n\t\t<UnitsString></UnitsString>\n' +
'\t\t<Node Version="1">\n\t\t</Node>\n\t\t<Name>Anti-flicker Filter</Name>\n\t</VideoComponentParam>\n' +
// Crop L/T/R/B
_p('10','fe47129e-6c94-4fc0-95d5-c056a517aaf3','10','2','8','Crop Left','',false,rs,'0.','0.','100.',undefined) +
_p('11','fe47129e-6c94-4fc0-95d5-c056a517aaf3','10','2','9','Crop Top','',false,rs,'0.','0.','100.',undefined) +
_p('12','fe47129e-6c94-4fc0-95d5-c056a517aaf3','10','2','10','Crop Right','',false,rs,'0.','0.','100.',undefined) +
_p('13','fe47129e-6c94-4fc0-95d5-c056a517aaf3','10','2','11','Crop Bottom','',false,rs,'0.','0.','100.',undefined) +
'</PremiereData>';
    try {
        var dir = new Folder(new File(filePath).parent.fsName);
        if (!dir.exists) dir.create();
        var f = new File(filePath);
        f.open('w'); f.encoding = 'UTF-8'; f.write(xml); f.close();
        return true;
    } catch (_) { return false; }
}

/**
 * buildAndPlaceModel4Captions(clipsJsonStr, seqName, mainTrackStr, pinnedSeqId, animateStr)
 *
 * Builds ONE timestamped nested sequence, places all PNG clips across 3 tracks
 * (V1=post, V2=cur, V3=pre), then places the nested seq on the main timeline.
 * If animate=true, applies the selected Impact/Orbit transition to active text and box clips
 * by temporarily making the nested sequence the active sequence.
 */
function buildAndPlaceModel4Captions(clipsJsonStr, seqName, mainTrackStr, pinnedSeqId, animateStr, numCurTracksStr, animTypeStr, animBoxTypeStr) {
    var numCurTracks = Math.max(1, parseInt(numCurTracksStr || '2', 10) || 2);
    var _animMatchNames = {
        'pop':          'AE.AE_Impact_Pop',
        'push':         'AE.AE_Impact_Push',
        'dissolve':     'AE.AE_Impact_Dissolve',
        'slide':        'AE.AE_Impact_Slide',
        'zoom-blur':    'AE.AE_Impact_ZoomBlur',
        'spin-3d':      'AE.AE_Impact_3DSpin',
        'blur-dissolve':'AE.AE_Impact_BlurDissolve',
        'linear-wipe':  'AE.AE_Impact_LinearWipe'
    };
    // Premiere renamed the Film Impact family across releases. Try both
    // matchNames and visible names, then fall back to a compatible transition
    // so selecting a new preset never silently produces a static caption.
    var _animAlternates = {
        'AE.AE_Impact_Slide':        ['Slide Impacts', 'FI: Impacts Slide', 'Slide', 'AE.AE_Impact_Push'],
        'AE.AE_Impact_ZoomBlur':     ['Zoom Blur Impacts', 'FI: Impacts Zoom Blur', 'Cross Zoom', 'AE.AE_Impact_Pop'],
        'AE.AE_Impact_3DSpin':       ['3D Spin Impacts', 'FI: Impacts 3D Spin', 'Spin Motion Impacts', 'AE.AE_Impact_Pop'],
        'AE.AE_Impact_BlurDissolve': ['Blur Dissolve Impacts', 'FI: Impacts Blur Dissolve', 'Cross Dissolve', 'AE.AE_Impact_Dissolve'],
        'AE.AE_Impact_LinearWipe':   ['Linear Wipe Impacts', 'FI: Impacts Linear Wipe', 'Wipe', 'AE.AE_Impact_Dissolve']
    };
    var _animMatchName    = _animMatchNames[animTypeStr    || ''] || null; // null = no animation
    var _animBoxMatchName = _animMatchNames[animBoxTypeStr || ''] || null; // null = no animation
    var animate      = (animateStr === 'true') && (!!_animMatchName || !!_animBoxMatchName);
    var _dbg = 'init';
    try {
        _dbg = 'parse';
        var _clipsRaw = clipsJsonStr;
        // If argument looks like a file path, read from disk (avoids CEP bridge size limit)
        if (clipsJsonStr && clipsJsonStr.charAt(0) !== '[' && clipsJsonStr.charAt(0) !== '{') {
            try {
                var _f = new File(clipsJsonStr);
                _f.open('r');
                _clipsRaw = _f.read();
                _f.close();
                try { _f.remove(); } catch (_) {} // clean up temp file
            } catch (fe) { _clipsRaw = clipsJsonStr; } // fallback: treat as inline
        }
        var clips = JSON.parse(_clipsRaw);

        _dbg = 'main-seq';
        var mainSeq        = _getSeqById(pinnedSeqId || '');
        var baseTrackIndex = parseInt(mainTrackStr || '2', 10) - 1;

        // ── Build PNG filename → project item map (scan only the run bin) ─────
        // PNGs were imported into MachiCut/Captions/<seqName> — no need to walk the
        // entire project tree.
        _dbg = 'scan-pngs';
        var itemByName = {};
        var _scanBin = function (b) {
            for (var si = 0; si < b.children.numItems; si++) {
                var sc = b.children[si];
                try { if (sc.type === 2) { _scanBin(sc); continue; } } catch (_) {}
                try {
                    var mp = sc.getMediaPath();
                    if (mp) itemByName[mp.replace(/\\/g, '/').split('/').pop()] = sc;
                } catch (_) {}
                try { itemByName[String(sc.name)] = sc; } catch (_) {}
            }
        };
        try {
            var _scanRoot = _getOrCreateBin(
                _getOrCreateBin(_getOrCreateBin(app.project.rootItem, 'MachiCut'), 'Captions'),
                seqName
            );
            _scanBin(_scanRoot);
        } catch (_) {
            _scanBin(app.project.rootItem); // fallback to full scan
        }

        // ── Snap ticks + overlap removal (global, before bucketing) ──────────
        var _tpf = 0;
        try { _tpf = parseInt(mainSeq.timebase, 10) || 0; } catch(_) {}

        function _snapFrame(ticks) {
            var t = parseInt(ticks, 10);
            if (!_tpf) return t;
            return Math.round(t / _tpf) * _tpf;
        }

        for (var pi = 0; pi < clips.length; pi++) {
            clips[pi]._snappedStart = _snapFrame(clips[pi].startTicks);
            clips[pi]._snappedEnd   = _snapFrame(clips[pi].endTicks);
            // 0-frame after snap → mark for skip rather than forcing +1 frame
            // (forcing would re-introduce overlap and destroy adjacent clips).
            if (clips[pi]._snappedEnd <= clips[pi]._snappedStart) clips[pi]._skip = true;
        }

        // ── Group clips into 3-minute buckets ────────────────────────────────
        var BUCKET_TICKS = 3 * 60 * 254016000000; // 3 min in Premiere ticks
        var bucketMap = {};
        for (var bi = 0; bi < clips.length; bi++) {
            var bIdx = Math.floor(clips[bi]._snappedStart / BUCKET_TICKS);
            if (!bucketMap[bIdx]) bucketMap[bIdx] = [];
            bucketMap[bIdx].push(clips[bi]);
        }
        var bucketKeys = [];
        for (var _bk in bucketMap) {
            if (bucketMap.hasOwnProperty(_bk)) bucketKeys.push(parseInt(_bk, 10));
        }
        bucketKeys.sort(function(a, b) { return a - b; });

        // ── Trim overlaps per (bucket, actual-track) ─────────────────────────
        // Track alternation resets per bucket. Match the placement loop's
        // logic: walk bucketClips in array order, assign each clip its
        // physical track via the same counters, group by track, sort and
        // trim same-track overlaps.
        var _overlapsFixed = 0, _droppedZero = 0;
        var _trimDbg = []; // collect dropped clip names for diagnosis
        function _trimSameTrack(list, trackName) {
            list.sort(function(a, b) { return a._snappedStart - b._snappedStart; });
            for (var i = 0; i < list.length - 1; i++) {
                if (list[i]._snappedEnd > list[i+1]._snappedStart) {
                    list[i]._snappedEnd = list[i+1]._snappedStart;
                    if (list[i]._snappedEnd <= list[i]._snappedStart) {
                        list[i]._skip = true;
                        _droppedZero++;
                        var _fn = (list[i].pngPath || '').split('/').pop().split('\\').pop();
                        _trimDbg.push('drop:' + trackName + ':' + _fn);
                    }
                    _overlapsFixed++;
                }
            }
        }
        for (var _ovBki = 0; _ovBki < bucketKeys.length; _ovBki++) {
            var _bClips = bucketMap[bucketKeys[_ovBki]];
            // Buckets of physical tracks
            var trackBuckets = {};
            var _ovCurIdx = 0, _ovWbIdx = 0;
            for (var _ovi = 0; _ovi < _bClips.length; _ovi++) {
                var _ovc = _bClips[_ovi];
                var _trk;
                if (_ovc.isCurrent)    { _trk = numCurTracks + 1 + (_ovCurIdx % numCurTracks); _ovCurIdx++; }
                else if (_ovc.isCurBg) { _trk = _ovWbIdx % numCurTracks;                       _ovWbIdx++; }
                else                   { _trk = numCurTracks; }
                if (!trackBuckets[_trk]) trackBuckets[_trk] = [];
                trackBuckets[_trk].push(_ovc);
            }
            for (var _trkKey in trackBuckets) {
                if (trackBuckets.hasOwnProperty(_trkKey)) _trimSameTrack(trackBuckets[_trkKey], 't' + _trkKey);
            }
        }

        // ── Prepare main track — clear previous captions ─────────────────────
        _dbg = 'place-main-prep';
        while (mainSeq.videoTracks.numTracks <= baseTrackIndex) {
            try { mainSeq.videoTracks.add(); } catch (_) { break; }
        }
        var mainTrk = mainSeq.videoTracks[baseTrackIndex];
        for (var di2 = mainTrk.clips.numItems - 1; di2 >= 0; di2--) {
            try {
                var cn = mainTrk.clips[di2].projectItem ? mainTrk.clips[di2].projectItem.name : '';
                if (cn.indexOf(seqName) === 0 || cn.indexOf('Custom_') === 0 || cn === 'MachiCut_Captions') {
                    mainTrk.clips[di2].remove(false, false);
                }
            } catch (_) {}
        }

        var placed = 0, errors = [];
        var seqW = mainSeq.frameSizeHorizontal || 1920;
        var seqH = mainSeq.frameSizeVertical   || 1080;
        var _preset = _findAnyPreset();
        var totalTracksNeeded = numCurTracks * 2 + 1;

        errors.push('tpf:' + _tpf + ' buckets:' + bucketKeys.length + ' clips:' + clips.length + ' overlapsFixed:' + _overlapsFixed + ' droppedZero:' + _droppedZero);
        for (var _tdi = 0; _tdi < Math.min(_trimDbg.length, 10); _tdi++) errors.push(_trimDbg[_tdi]);

        // ── Animation helper (defined once, used per bucket) ─────────────────
        function _applyAnimToTracks(qeSeqRef, matchName, trackFrom, trackTo) {
            if (!matchName || !qeSeqRef) return;
            var tx = null;
            var candidates = [matchName];
            var alternates = _animAlternates[matchName] || [];
            for (var _aci = 0; _aci < alternates.length; _aci++) candidates.push(alternates[_aci]);
            for (var _cti = 0; _cti < candidates.length && !tx; _cti++) {
                try { tx = qe.project.getVideoTransitionByName(candidates[_cti], true); } catch(_) {}
                if (!tx) { try { tx = qe.project.getVideoTransitionByName(candidates[_cti], false); } catch(_) {} }
            }
            if (!tx) return;
            for (var _ti = trackFrom; _ti <= trackTo; _ti++) {
                var _qeTrk = qeSeqRef.getVideoTrackAt(_ti);
                if (!_qeTrk) continue;
                for (var _ci2 = 0; _ci2 < _qeTrk.numItems; _ci2++) {
                    try {
                        var _itm = _qeTrk.getItemAt(_ci2);
                        if (_itm && String(_itm.type) === 'Clip') {
                            _itm.addTransition(tx, true, '00:00:00:05');
                            try { _itm.addTransition(null, false, '00:00:00:00'); } catch(_) {}
                        }
                    } catch(_) {}
                }
            }
        }

        // ── Process each bucket ───────────────────────────────────────────────
        for (var bki = 0; bki < bucketKeys.length; bki++) {
            var bucketIdx    = bucketKeys[bki];
            var bucketClips  = bucketMap[bucketIdx];
            var bucketOffset = bucketIdx * BUCKET_TICKS;
            var partName     = seqName + '_p' + bucketIdx;
            _dbg             = 'bucket-' + bucketIdx;

            // Create nested sequence for this bucket
            var nestedSeq = null;
            try {
                app.enableQE();
                if (_preset) {
                    qe.project.newSequence(partName, _preset);
                } else {
                    app.project.createNewSequence(partName, partName);
                }
            } catch (_) {}
            var _seqsB = app.project.sequences;
            for (var _sib = 0; _sib < _seqsB.numSequences; _sib++) {
                try { if (String(_seqsB[_sib].name) === partName) { nestedSeq = _seqsB[_sib]; break; } } catch (_) {}
            }
            if (!nestedSeq) { errors.push('no-seq:' + partName); continue; }

            // Move into run bin
            try {
                var _runBin = _getOrCreateBin(_getOrCreateBin(_getOrCreateBin(
                    app.project.rootItem, 'MachiCut'), 'Captions'), seqName);
                nestedSeq.projectItem.moveBin(_runBin);
            } catch (_) {}

            // Copy settings + add tracks via QE
            try { nestedSeq.setSettings(mainSeq.getSettings()); } catch (_) {}
            try {
                app.enableQE();
                app.project.activeSequence = nestedSeq;
                nestedSeq = app.project.activeSequence;
                var _qeNested = qe.project.getActiveSequence();
                var _tracksToAdd = totalTracksNeeded - nestedSeq.videoTracks.numTracks;
                if (_qeNested && _tracksToAdd > 0) {
                    _qeNested.addTracks(_tracksToAdd, nestedSeq.videoTracks.numTracks - 1, 0);
                }
            } catch (_) {}

            // Restore main seq as active
            try {
                var _seqsR = app.project.sequences;
                for (var _sir = 0; _sir < _seqsR.numSequences; _sir++) {
                    try {
                        if (String(_seqsR[_sir].sequenceID) === String(pinnedSeqId)) {
                            app.project.activeSequence = _seqsR[_sir];
                            mainSeq = _seqsR[_sir];
                            break;
                        }
                    } catch (_) {}
                }
            } catch (_) {}

            // Refresh tpf from nested seq if not yet set
            if (!_tpf) { try { _tpf = parseInt(nestedSeq.timebase, 10) || 0; } catch(_) {} }

            // Place clips (relative timestamps = absolute - bucketOffset)
            var _curClipIdx = 0, _wbClipIdx = 0;
            var _motIdx = -1, _posIdx = -1;

            for (var ci = 0; ci < bucketClips.length; ci++) {
                var clip    = bucketClips[ci];

                // Counters must advance even for skipped clips so subsequent
                // alternation matches overlap-detection's track assignment.
                var trackIdx;
                if (clip.isCurrent) {
                    trackIdx = numCurTracks + 1 + (_curClipIdx % numCurTracks);
                    _curClipIdx++;
                } else if (clip.isCurBg) {
                    trackIdx = _wbClipIdx % numCurTracks;
                    _wbClipIdx++;
                } else {
                    trackIdx = numCurTracks;
                }
                if (clip._skip) continue; // dropped by overlap fix — skip placement

                var fname   = (clip.pngPath || '').replace(/\\/g, '/').split('/').pop();
                var pngItem = itemByName[fname];
                if (!pngItem) { errors.push('no-png:' + fname); continue; }

                var _isCtx = !clip.isCurrent && !clip.isCurBg;
                var _isFirstWord = (fname.indexOf('_w0_') !== -1);
                if (_isCtx && _isFirstWord) {
                    errors.push('place-ctx:' + fname + ' s=' + clip._snappedStart + ' e=' + clip._snappedEnd + ' trk=' + trackIdx);
                }

                while (nestedSeq.videoTracks.numTracks <= trackIdx) {
                    try { nestedSeq.videoTracks.add(); } catch (_) { break; }
                }
                var ntrk2 = nestedSeq.videoTracks[trackIdx];
                if (!ntrk2) { errors.push('no-trk:' + trackIdx); continue; }

                var relStart = clip._snappedStart - bucketOffset;
                var relEnd   = clip._snappedEnd   - bucketOffset;
                if (relStart < 0) relStart = 0;
                if (relEnd <= relStart) relEnd = relStart + (_tpf || 8467200000);

                var startTime = new Time(); startTime.ticks = String(relStart);
                var endTime   = new Time(); endTime.ticks   = String(relEnd);

                try {
                    ntrk2.overwriteClip(pngItem, startTime);
                    var numC = ntrk2.clips.numItems;
                    if (numC === 0) { errors.push('not-placed:' + ci); continue; }
                    var placedClip = ntrk2.clips[numC - 1];
                    try { placedClip.end = endTime; } catch (_) {}

                    // Position via Motion effect — locale-independent lookup
                    var motComp = _findMotionComp(placedClip);
                    var posProp = _findMotionProp(motComp, 'Position', 0);

                    var posXNorm = (clip.posXFraction || 0.5) + (clip.wordOffsetFromCenter || 0) / seqW;
                    var posYNorm = (clip.posYFraction || 0.85) + (clip.wordLineYOffset || 0) / seqH;
                    try { if (posProp) posProp.setValue([posXNorm, posYNorm]); } catch (_) {}

                    placed++;
                } catch (pe) {
                    errors.push('pe:' + ci + ':' + pe.message);
                }
            }

            // Animation pass for this bucket
            if (animate && (_animMatchName || _animBoxMatchName)) {
                try {
                    app.enableQE();
                    app.project.activeSequence = nestedSeq;
                    var _qeSeqB = qe.project.getActiveSequence();
                    _applyAnimToTracks(_qeSeqB, _animMatchName,    numCurTracks + 1, numCurTracks * 2);
                    _applyAnimToTracks(_qeSeqB, _animBoxMatchName, 0, numCurTracks - 1);
                    app.project.activeSequence = mainSeq;
                } catch (aE) { errors.push('anim-err:' + aE.message); }
            }

            // Place this bucket's nested seq on main timeline at bucket offset
            var bucketTime = new Time(); bucketTime.ticks = String(bucketOffset);
            try { mainTrk.overwriteClip(nestedSeq.projectItem, bucketTime); } catch (pe2) {
                errors.push('place-main:' + pe2.message);
            }

            // Remove audio companions spawned by this nested seq
            try {
                for (var asi = 0; asi < mainSeq.audioTracks.numTracks; asi++) {
                    var atrk = mainSeq.audioTracks[asi];
                    for (var aci = atrk.clips.numItems - 1; aci >= 0; aci--) {
                        try {
                            var acn = atrk.clips[aci].projectItem ? atrk.clips[aci].projectItem.name : '';
                            if (acn === partName) atrk.clips[aci].remove(false, false);
                        } catch (_) {}
                    }
                }
            } catch (_) {}

            try { nestedSeq.close(); } catch (_) {}
        } // end bucket loop

        // Restore main seq as active tab
        _dbg = 'restore-main';
        try { mainSeq.open(); } catch (_) {}

        return JSON.stringify({ placed: placed, errors: errors });
    } catch (e) {
        return JSON.stringify({ error: 'buildAndPlaceModel4Captions[' + _dbg + ']: ' + e.message });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Converts seconds to "HH;MM;SS;FF" timecode string for QE DOM razor.
 * Uses semicolons (accepted by QE DOM for both drop-frame and non-drop-frame).
 */
function secondsToTimecode(secs, fps, rounding) {
    // rounding 'ceil'/'floor' lets cut boundaries round INWARD into the
    // silence — nearest-frame rounding could land the razor up to half a
    // frame inside speech and audibly clip word onsets. The 1e-6 epsilon
    // keeps values already on a frame boundary from jumping a full frame.
    var exact = secs * fps;
    var totalFrames = rounding === 'ceil'  ? Math.ceil(exact - 1e-6)
                    : rounding === 'floor' ? Math.floor(exact + 1e-6)
                    :                        Math.round(exact);
    var f = totalFrames % fps;
    var s = Math.floor(totalFrames / fps) % 60;
    var m = Math.floor(totalFrames / (fps * 60)) % 60;
    var h = Math.floor(totalFrames / (fps * 3600));
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return pad(h) + ';' + pad(m) + ';' + pad(s) + ';' + pad(f);
}

// ── Silence Cutter ───────────────────────────────────────────────────────────

/**
 * Removes silence ranges from the active sequence.
 * Uses the QE DOM for razor cuts (official seq.razor() is unreliable).
 * silenceRanges: JSON string of [{start: seconds, end: seconds}, ...]
 *
 * All-tracks mode   : ripple delete (moves every track together).
 * Single-track mode : delete WITHOUT ripple so other tracks are never touched,
 *                     then close gaps by repositioning clips on the target track.
 */
function removeSilenceRanges(silenceRangesJSON, cutTracksJSON, applyModeStr) {
    var ranges    = JSON.parse(silenceRangesJSON);
    var cutTracks = cutTracksJSON ? JSON.parse(cutTracksJSON) : [];
    var seq       = getActiveSequence();
    var applyMode = applyModeStr === 'razor' ? 'razor' : 'ripple';

    if (!ranges || ranges.length === 0) {
        return JSON.stringify({ removed: 0, total: 0 });
    }

    var fps = Math.round(254016000000 / parseInt(seq.timebase, 10));

    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) throw new Error("QE DOM could not get active sequence.");

    // Build lookup of selected tracks. Empty array = all tracks.
    var selectedSet = {};
    var allSelected = (cutTracks.length === 0);
    for (var s = 0; s < cutTracks.length; s++) {
        selectedSet[cutTracks[s].type + ':' + cutTracks[s].index] = true;
    }

    // Lock non-selected tracks, save previous states.
    var lockStates = { video: [], audio: [] };
    var v, a;
    for (v = 0; v < seq.videoTracks.numTracks; v++) {
        var qeV = qeSeq.getVideoTrackAt(v);
        lockStates.video.push(qeV ? qeV.isLocked() : false);
        if (!allSelected && !selectedSet['video:' + v] && qeV) qeV.setLock(true);
    }
    for (a = 0; a < seq.audioTracks.numTracks; a++) {
        var qeA = qeSeq.getAudioTrackAt(a);
        lockStates.audio.push(qeA ? qeA.isLocked() : false);
        if (!allSelected && !selectedSet['audio:' + a] && qeA) qeA.setLock(true);
    }

    // Process largest-start-time first to keep indices valid during ripple.
    ranges.sort(function (a, b) { return b.start - a.start; });

    var removed = 0;
    var errors  = [];

    try {
        for (var i = 0; i < ranges.length; i++) {
            var r = ranges[i];
            try {
                // Round both edges INWARD (start up, end down) so the
                // razor can only land in silence, never inside speech. A
                // range shorter than a frame collapses after rounding —
                // nothing removable at frame granularity, skip it.
                var startF = Math.ceil(r.start * fps - 1e-6);
                var endF   = Math.floor(r.end  * fps + 1e-6);
                if (endF <= startF) continue;

                var startTC = secondsToTimecode(r.start, fps, 'ceil');
                var endTC   = secondsToTimecode(r.end,   fps, 'floor');
                qeSeq.razor(startTC);
                qeSeq.razor(endTC);
                if (applyMode === 'razor') { removed++; continue; }

                // Midpoint tests must use the same frame-snapped bounds as
                // the razors, or a sliver clip can survive/vanish wrongly.
                var rsInt = parseInt(secondsToTicks(startF / fps), 10);
                var reInt = parseInt(secondsToTicks(endF   / fps), 10);

                for (v = 0; v < seq.videoTracks.numTracks; v++) {
                    var vt = seq.videoTracks[v];
                    for (var vc = vt.clips.numItems - 1; vc >= 0; vc--) {
                        var vClip = vt.clips[vc];
                        var vMid  = parseInt(vClip.start.ticks, 10) +
                                    Math.floor((parseInt(vClip.end.ticks, 10) - parseInt(vClip.start.ticks, 10)) / 2);
                        if (vMid > rsInt && vMid < reInt) { vClip.remove(true, true); removed++; }
                    }
                }
                for (a = 0; a < seq.audioTracks.numTracks; a++) {
                    var at = seq.audioTracks[a];
                    for (var ac = at.clips.numItems - 1; ac >= 0; ac--) {
                        var aClip = at.clips[ac];
                        var aMid  = parseInt(aClip.start.ticks, 10) +
                                    Math.floor((parseInt(aClip.end.ticks, 10) - parseInt(aClip.start.ticks, 10)) / 2);
                        if (aMid > rsInt && aMid < reInt) { aClip.remove(true, true); removed++; }
                    }
                }
            } catch (e) {
                errors.push(r.start.toFixed(2) + '-' + r.end.toFixed(2) + ': ' + e.message);
                $.writeln("MachiCut error: " + e.message);
            }
        }
    } finally {
        for (v = 0; v < seq.videoTracks.numTracks; v++) {
            var qeVr = qeSeq.getVideoTrackAt(v);
            if (qeVr) qeVr.setLock(lockStates.video[v]);
        }
        for (a = 0; a < seq.audioTracks.numTracks; a++) {
            var qeAr = qeSeq.getAudioTrackAt(a);
            if (qeAr) qeAr.setLock(lockStates.audio[a]);
        }
    }

    return JSON.stringify({ removed: removed, total: ranges.length, errors: errors, mode: applyMode });
}

// ── Auto Captions ────────────────────────────────────────────────────────────

/**
 * Creates text (caption) clips on a new video track.
 * captionsJSON: JSON string of [{text, start, end}, ...]
 */
/**
 * Returns all clips on a track with their source in/out points and timeline positions.
 * Used by the caption generator to build an accurate concatenated audio for Whisper.
 */
function getAudioTrackClips(trackTypeStr, trackIndexNum) {
    var seq   = getActiveSequence();
    var track = (trackTypeStr === 'audio')
        ? seq.audioTracks[trackIndexNum]
        : seq.videoTracks[trackIndexNum];

    if (!track) throw new Error('Track not found: ' + trackTypeStr + ' ' + trackIndexNum);

    var clips = [];
    for (var i = 0; i < track.clips.numItems; i++) {
        var clip = track.clips[i];
        if (clip.projectItem && clip.projectItem.getMediaPath()) {
            clips.push({
                sourceFile:    clip.projectItem.getMediaPath(),
                srcIn:         ticksToSeconds(clip.inPoint.ticks),
                srcOut:        ticksToSeconds(clip.outPoint.ticks),
                timelineStart: ticksToSeconds(clip.start.ticks)
            });
        }
    }
    return JSON.stringify(clips);
}

function createCaptionClips(captionsJSON, seqStartStr) {
    var captions  = JSON.parse(captionsJSON);
    // seqStart = timeline position (seconds) of the first clip on the selected track.
    // SRT timestamps will be written relative to this, so the file can be placed
    // (or auto-inserted) at seqStart and everything lines up frame-accurately.
    var seqStart  = parseFloat(seqStartStr || '0') || 0;

    if (!captions || captions.length === 0) {
        return JSON.stringify({ error: "No captions to create." });
    }

    // ── Build SRT content ────────────────────────────────────────────────────
    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : String(n)); }

    function toSrtTime(secs) {
        var h   = Math.floor(secs / 3600);
        var m   = Math.floor((secs % 3600) / 60);
        var s   = Math.floor(secs % 60);
        var ms  = Math.round((secs - Math.floor(secs)) * 1000);
        return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + ',' + pad3(ms);
    }

    var srtLines = [];
    for (var i = 0; i < captions.length; i++) {
        var cap = captions[i];
        // Timestamps are relative to seqStart so the SRT aligns when placed at seqStart
        var relStart = Math.max(0, cap.start - seqStart);
        var relEnd   = Math.max(relStart + 0.04, cap.end - seqStart);
        srtLines.push(String(i + 1));
        srtLines.push(toSrtTime(relStart) + ' --> ' + toSrtTime(relEnd));
        srtLines.push(cap.text);
        srtLines.push('');
    }
    var srtContent = srtLines.join('\n');

    // ── Write SRT to temp folder ─────────────────────────────────────────────
    var tmpDir  = Folder.temp.fsName;
    var srtPath = tmpDir + '/machicut_captions.srt';
    var srtFile = new File(srtPath);
    srtFile.encoding = 'UTF-8';
    srtFile.open('w');
    srtFile.write(srtContent);
    srtFile.close();

    // ── Import SRT into project ──────────────────────────────────────────────
    var importResult = app.project.importFiles(
        [srtPath],
        true,   // suppressUI
        app.project.rootItem,
        false   // importAsNumberedStills
    );

    if (!importResult) {
        return JSON.stringify({ error: "Failed to import SRT file.", srtPath: srtPath });
    }

    // ── Find the imported caption item ───────────────────────────────────────
    var captionItem = null;
    var rootItems   = app.project.rootItem.children;
    for (var j = 0; j < rootItems.numItems; j++) {
        if (rootItems[j].name === 'machicut_captions.srt') {
            captionItem = rootItems[j];
            break;
        }
    }

    if (!captionItem) {
        return JSON.stringify({
            srtPath: srtPath,
            created: captions.length,
            total:   captions.length,
            note:    "SRT saved but not found in bin — import it manually: " + srtPath
        });
    }

    // ── Add to timeline as caption track ─────────────────────────────────────
    var seq = getActiveSequence();
    var addedToTimeline = false;
    var placeError = '';

    // seqStart in ticks as integer (some APIs reject string form)
    var seqStartTicksInt = parseInt(secondsToTicks(seqStart), 10);

    // Method 1: createCaptionTrack — correct Premiere 2022+ API for SRT items
    try {
        if (seq.createCaptionTrack) {
            seq.createCaptionTrack(captionItem, seqStartTicksInt);
            addedToTimeline = true;
        }
    } catch (e1) { placeError = 'createCaptionTrack: ' + e1.message; }

    // Method 2: importCaptions (older naming variant)
    if (!addedToTimeline) {
        try {
            if (seq.importCaptions) {
                seq.importCaptions(captionItem, seqStartTicksInt);
                addedToTimeline = true;
            }
        } catch (e2) { placeError += ' | importCaptions: ' + e2.message; }
    }

    // Method 3: insert on a new video track (last resort, may not render as captions)
    if (!addedToTimeline) {
        try {
            seq.videoTracks.add();
            var captionTrack = seq.videoTracks[seq.videoTracks.numTracks - 1];
            captionTrack.insertClip(captionItem, seqStartTicksInt);
            addedToTimeline = true;
        } catch (e3) { placeError += ' | insertClip: ' + e3.message; }
    }

    var note = addedToTimeline ? '' :
        'Auto-place failed (' + placeError + '). ' +
        'Drag "machicut_captions.srt" from Project bin to timeline at ' +
        seqStart.toFixed(2) + 's.';
    return JSON.stringify({ created: captions.length, total: captions.length, srtPath: srtPath, note: note });
}

/**
 * Returns sequence info useful for the UI and caption image rendering.
 */
function getSequenceInfo() {
    try {
        // Prefer the active sequence, but skip plugin-created nested sequences (MC_m4_*)
        var seq = getActiveSequence();
        if (seq.name && /^MC_m4_/.test(seq.name)) {
            // Active sequence is a plugin nested seq — find the first non-plugin sequence
            var fallback = null;
            for (var si = 0; si < app.project.sequences.numSequences; si++) {
                try {
                    var s = app.project.sequences[si];
                    if (s && s.name && !/^MC_m4_/.test(s.name)) { fallback = s; break; }
                } catch (_) {}
            }
            if (fallback) seq = fallback;
        }
        var w = 1920, h = 1080, fps = 30, dur = 0, timebase = 0, inPoint = 0, outPoint = 0;
        try { w = seq.frameSizeHorizontal || 1920; } catch (_) {}
        try { h = seq.frameSizeVertical   || 1080; } catch (_) {}
        try { timebase = parseInt(seq.timebase, 10) || 0; } catch (_) {}
        try { fps = timebase ? Math.round(254016000000 / timebase) : 30; } catch (_) {}
        try { dur = seq.end ? (seq.end.seconds || ticksToSeconds(String(seq.end))) : 0; } catch (_) {}
        try {
            var ip = seq.getInPoint ? seq.getInPoint() : 0;
            inPoint = (ip && ip.seconds !== undefined) ? Number(ip.seconds) : Number(ip || 0);
        } catch (_) { inPoint = 0; }
        try {
            var op = seq.getOutPoint ? seq.getOutPoint() : 0;
            outPoint = (op && op.seconds !== undefined) ? Number(op.seconds) : Number(op || 0);
        } catch (_) { outPoint = 0; }
        if (!isFinite(inPoint) || inPoint < 0) inPoint = 0;
        if (!isFinite(outPoint) || outPoint <= inPoint) outPoint = 0;
        return JSON.stringify({
            name:     seq.name || '',
            duration: dur,
            inPoint:  inPoint,
            outPoint: outPoint,
            fps:      fps,
            timebase: timebase,
            width:    w,
            height:   h
        });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

/**
 * Places PNG caption images on a video track.
 * captionsJsonStr — [{start, end, text}, ...]  (start/end in seconds)
 * pngPathsJsonStr — [absolute path, ...] parallel to captions array
 * trackIndexStr   — 1-based video track number ("2" = V2)
 */
/**
 * Builds an FCP XML referencing the PNG files, imports it into Premiere as a
 * nested sequence, then places that sequence on the chosen video track.
 * This matches FireCut's "Nested sequence" approach — one unified clip on the
 * timeline, each PNG clipped to its exact caption window inside.
 */
// ── Caption-bin cleanup ──────────────────────────────────────────────────────
//
// Scan + clean MachiCut/Captions/ — flags caption-related projectItems
// (top-level MachiCut_Captions sequences, nested MC_m4_* sequences, and the
// timestamped PNG bins) as USED if a transitive walk from any user sequence
// reaches them, or UNUSED otherwise. The user reviews the list and triggers
// a soft clean (remove from project bin only) or a hard clean (also delete
// the temp PNG folder on disk).

// Locate MachiCut/Captions if it exists. Returns the bin projectItem or null.
function _findCaptionsBin() {
    var root = app.project.rootItem;
    var machiCut = null;
    for (var i = 0; i < root.children.numItems; i++) {
        var c = root.children[i];
        try { if (c.type === 2 && c.name === 'MachiCut') { machiCut = c; break; } } catch (_) {}
    }
    if (!machiCut) return null;
    for (var j = 0; j < machiCut.children.numItems; j++) {
        var c2 = machiCut.children[j];
        try { if (c2.type === 2 && c2.name === 'Captions') return c2; } catch (_) {}
    }
    return null;
}

// scanMachiCutCaptions()
// Returns { items: [...] } where each item is:
//   { kind:'sequence'|'clip'|'bin', name, parentPath, nodeId, used,
//     childCount?, diskFolder?, mediaPath? }
// Transitive-closure logic: a caption item is USED only if the chain
//   user_sequence → MachiCut_Captions → nested → PNG
// reaches it. Captions referenced only by OTHER caption items (e.g. a
// nested seq that nothing on a user timeline touches) stay UNUSED.
function scanMachiCutCaptions() {
    try {
        var captionsBin = _findCaptionsBin();
        if (!captionsBin) {
            return JSON.stringify({ items: [], message: 'No MachiCut/Captions bin in this project.' });
        }

        // nodeId → Sequence object for every sequence in the project. Used
        // both to detect "this projectItem IS a sequence" and to walk into
        // it when collecting transitive usage.
        var seqByNodeId = {};
        var seqs = app.project.sequences;
        for (var si = 0; si < seqs.numSequences; si++) {
            try { seqByNodeId[seqs[si].projectItem.nodeId] = seqs[si]; } catch (_) {}
        }

        // Every projectItem nodeId living under MachiCut/Captions (any
        // depth). Used to skip caption-chain sequences as STARTING points
        // — usage must originate from a "user" sequence.
        var captionItemSet = {};
        function _walkCollect(bin) {
            for (var i = 0; i < bin.children.numItems; i++) {
                var c = bin.children[i];
                try { captionItemSet[c.nodeId] = true; } catch (_) {}
                try { if (c.type === 2) _walkCollect(c); } catch (_) {}
            }
        }
        _walkCollect(captionsBin);

        // BFS transitive closure starting from non-caption sequences.
        var used = {};
        var visited = {};
        var queue = [];
        for (var ts = 0; ts < seqs.numSequences; ts++) {
            try {
                var pi = seqs[ts].projectItem;
                if (!captionItemSet[pi.nodeId]) queue.push(seqs[ts]);
            } catch (_) {}
        }
        while (queue.length) {
            var s = queue.shift();
            var sNid = '';
            try { sNid = s.projectItem.nodeId; } catch (_) { continue; }
            if (visited[sNid]) continue;
            visited[sNid] = true;

            var tracks = [];
            try { for (var tv = 0; tv < s.videoTracks.numTracks; tv++) tracks.push(s.videoTracks[tv]); } catch (_) {}
            try { for (var ta = 0; ta < s.audioTracks.numTracks; ta++) tracks.push(s.audioTracks[ta]); } catch (_) {}
            for (var tt = 0; tt < tracks.length; tt++) {
                var clips = tracks[tt].clips;
                for (var cc = 0; cc < clips.numItems; cc++) {
                    var cpi = clips[cc].projectItem;
                    if (!cpi) continue;
                    var nid = '';
                    try { nid = cpi.nodeId; } catch (_) { continue; }
                    if (used[nid]) continue;
                    used[nid] = true;
                    // If this clip references a sequence (e.g. a nested
                    // MC_m4_* clipped into MachiCut_Captions), recurse so
                    // the chain's children also light up as USED.
                    if (seqByNodeId[nid]) queue.push(seqByNodeId[nid]);
                }
            }
        }

        // Now classify every direct child of MachiCut/Captions. For PNG
        // bins (timestamped MC_*) we don't enumerate every grandchild —
        // we just summarize the bin and derive its disk folder from the
        // first child's media path. For the "Nested" sub-bin we recurse
        // so each nested sequence shows individually.
        var items = [];
        function classify(bin, parentPath) {
            for (var i = 0; i < bin.children.numItems; i++) {
                var c = bin.children[i];
                var nid = '', name = '', isBin = false, mediaPath = '';
                try { nid = c.nodeId; } catch (_) {}
                try { name = c.name; } catch (_) {}
                try { isBin = (c.type === 2); } catch (_) {}
                try { mediaPath = c.getMediaPath() || ''; } catch (_) {}

                if (isBin) {
                    var childCount = 0, anyUsed = false, firstChildPath = '';
                    try { childCount = c.children.numItems; } catch (_) {}
                    for (var bc = 0; bc < childCount; bc++) {
                        try {
                            var bch = c.children[bc];
                            if (used[bch.nodeId]) anyUsed = true;
                            if (!firstChildPath) {
                                try { firstChildPath = bch.getMediaPath() || ''; } catch (_) {}
                            }
                        } catch (_) {}
                    }
                    var diskFolder = '';
                    if (firstChildPath) {
                        var d = firstChildPath.replace(/\\/g, '/');
                        var ls = d.lastIndexOf('/');
                        if (ls > 0) diskFolder = d.substring(0, ls);
                    }
                    items.push({
                        kind: 'bin',
                        name: name,
                        parentPath: parentPath,
                        nodeId: nid,
                        childCount: childCount,
                        used: anyUsed,
                        diskFolder: diskFolder
                    });
                    // Recurse only into Nested — PNG bins are intentionally
                    // opaque at this layer (potentially hundreds of items).
                    if (name === 'Nested') classify(c, parentPath + '/' + name);
                } else {
                    items.push({
                        kind: seqByNodeId[nid] ? 'sequence' : 'clip',
                        name: name,
                        parentPath: parentPath,
                        nodeId: nid,
                        used: !!used[nid],
                        mediaPath: mediaPath
                    });
                }
            }
        }
        classify(captionsBin, 'MachiCut/Captions');

        return JSON.stringify({ items: items });
    } catch (e) {
        return JSON.stringify({ error: 'scanMachiCutCaptions: ' + e.message });
    }
}

// Try every ProjectItem-remove API surface in order until one works.
// Premiere's ExtendScript bindings are inconsistent across versions and
// item types (sequence vs bin vs media). Reports the variant that
// actually succeeded so we can debug from the cleanup result.
function _tryRemoveProjectItem(item) {
    // 1) The most common modern signature.
    try {
        if (typeof item.remove === 'function') {
            item.remove(false, false);
            return 'remove(false,false)';
        }
    } catch (e1) {}
    // 2) Integer-arg variant — some PPro versions expect 0/1 not booleans.
    try {
        if (typeof item.remove === 'function') {
            item.remove(0, 0);
            return 'remove(0,0)';
        }
    } catch (e2) {}
    // 3) Zero-arg variant.
    try {
        if (typeof item.remove === 'function') {
            item.remove();
            return 'remove()';
        }
    } catch (e3) {}
    // 4) Project-level deleteItem.
    try {
        if (app.project && typeof app.project.deleteItem === 'function') {
            app.project.deleteItem(item);
            return 'project.deleteItem';
        }
    } catch (e4) {}
    // 5) Last resort — Bin.deleteBin() for bin items.
    try {
        if (typeof item.deleteBin === 'function') {
            item.deleteBin();
            return 'deleteBin';
        }
    } catch (e5) {}
    return null;
}

// cleanMachiCutCaptions(nodeIdsJson)
// Removes every projectItem under MachiCut/Captions whose nodeId is in the
// passed list. Always SOFT — never touches the disk. Returns the list of
// disk folders that were ASSOCIATED with the removed PNG bins, so the
// caller can pass them to the Node server's /files/delete-folders endpoint
// for a separate hard-clean step.
function cleanMachiCutCaptions(nodeIdsJson) {
    try {
        var nodeIds = JSON.parse(nodeIdsJson);
        if (!nodeIds || !nodeIds.length) {
            return JSON.stringify({ ok: true, removed: 0, diskFolders: [], log: [] });
        }
        var idSet = {};
        for (var i = 0; i < nodeIds.length; i++) idSet[nodeIds[i]] = true;

        var captionsBin = _findCaptionsBin();
        if (!captionsBin) return JSON.stringify({ ok: true, removed: 0, diskFolders: [], log: [] });

        var diskFolders = [];
        var removed = 0;
        var skipped  = [];   // items we tried to remove but couldn't
        var attempts = [];   // per-item outcome for debugging
        function _zap(bin) {
            // Back-to-front so removals don't shift the indices we
            // haven't visited yet.
            for (var i = bin.children.numItems - 1; i >= 0; i--) {
                var c = bin.children[i];
                var nid = '', name = '', isBin = false;
                try { nid = c.nodeId; } catch (_) {}
                try { name = c.name;   } catch (_) {}
                try { isBin = (c.type === 2); } catch (_) {}

                if (idSet[nid]) {
                    if (isBin) {
                        // Stash the on-disk folder BEFORE the bin is
                        // gone. Walk all PNG children so we get the
                        // exact parent dir even if the first child has
                        // no mediaPath for some reason.
                        try {
                            var n = c.children.numItems;
                            for (var bc = 0; bc < n; bc++) {
                                var bch = c.children[bc];
                                var mp = '';
                                try { mp = bch.getMediaPath() || ''; } catch (_) {}
                                if (mp) {
                                    var d = mp.replace(/\\/g, '/');
                                    var ls = d.lastIndexOf('/');
                                    if (ls > 0) {
                                        diskFolders.push(d.substring(0, ls));
                                        break;
                                    }
                                }
                            }
                        } catch (_) {}
                    }
                    var method = _tryRemoveProjectItem(c);
                    if (method) {
                        removed++;
                        attempts.push({ name: name, ok: true, via: method });
                    } else {
                        skipped.push(name);
                        attempts.push({ name: name, ok: false });
                    }
                } else if (isBin) {
                    _zap(c);
                }
            }
        }
        _zap(captionsBin);

        // Persist immediately so a panel reload doesn't show stale items.
        try { app.project.save(); } catch (_) {}

        return JSON.stringify({
            ok: true,
            removed: removed,
            diskFolders: diskFolders,
            skipped: skipped,
            log: attempts
        });
    } catch (e) {
        return JSON.stringify({ error: 'cleanMachiCutCaptions: ' + e.message });
    }
}

// ── Project-bin helpers (shared by caption import functions) ─────────────────

// Get or create a direct child bin by name inside parentBin.
function _getOrCreateBin(parentBin, name) {
    for (var i = 0; i < parentBin.children.numItems; i++) {
        var c = parentBin.children[i];
        if (c.name === name) {
            // ProjectItemType.BIN === 2 in Premiere's ExtendScript API
            try { if (c.type === 2) return c; } catch (_) {}
        }
    }
    try { return parentBin.createBin(name); } catch (_) { return parentBin; }
}

// Remove every project item whose name matches the given name, anywhere in the project.
function _removeProjectItemsByName(name, bin) {
    bin = bin || app.project.rootItem;
    for (var i = bin.children.numItems - 1; i >= 0; i--) {
        var c = bin.children[i];
        // Recurse into sub-bins first
        try { if (c.children && c.children.numItems >= 0) _removeProjectItemsByName(name, c); } catch (_) {}
        if (c.name === name) { try { c.remove(false, true); } catch (_) {} }
    }
}

// Import paths into a bin.
// noDedup=true skips the project-wide scan (use when all paths are guaranteed unique,
// e.g. Model 4 PNGs which go into a fresh timestamped directory every run).
function _importIntoBin(bin, paths, noDedup) {
    var toImport = paths;
    if (!noDedup) {
        // Collect all media paths already in the project to deduplicate.
        var known = {};
        function _scan(b) {
            for (var i = 0; i < b.children.numItems; i++) {
                var c = b.children[i];
                try {
                    var mp = c.getMediaPath();
                    if (mp) known[mp.replace(/\\/g, '/')] = true;
                } catch (_) {}
                try { if (c.type === 2) _scan(c); } catch (_) {}
            }
        }
        try { _scan(app.project.rootItem); } catch (_) {}
        toImport = [];
        for (var j = 0; j < paths.length; j++) {
            if (!paths[j]) continue;
            var norm = paths[j].replace(/\\/g, '/');
            if (!known[norm]) toImport.push(paths[j]);
        }
    }
    if (toImport.length > 0) {
        try { app.project.importFiles(toImport, true, bin, false); } catch (_) {}
    }
}

// Zero-pad a number to 2 digits (ExtendScript has no padStart).
function _pad2(n) { return n < 10 ? '0' + n : '' + n; }

// Create a human-readable session name: "2026-04-10 14:30".
function _sessionName() {
    var d = new Date();
    return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate()) +
           ' ' + _pad2(d.getHours()) + ':' + _pad2(d.getMinutes());
}

function buildAndImportCaptionXML(captionsJsonStr, pngPathsJsonStr, trackIndexStr) {
    try {
        var captions   = JSON.parse(captionsJsonStr);
        var pngPaths   = JSON.parse(pngPathsJsonStr);
        var trackIndex = parseInt(trackIndexStr || '2', 10) - 1;
        var seq        = getActiveSequence();

        var fps = 30;
        try { fps = Math.round(254016000000 / parseInt(seq.timebase, 10)); } catch (_) {}
        if (!fps || fps < 1 || fps > 240) fps = 30;

        if (captions.length === 0) return JSON.stringify({ error: 'No captions to place' });

        var TICKS = 254016000000;

        // ── Bin organisation ─────────────────────────────────────────────────
        var machiCutBin = _getOrCreateBin(app.project.rootItem, 'MachiCut');
        var captionsBin = _getOrCreateBin(machiCutBin, 'Captions');

        // ── Import PNGs directly into the project bin (deduplicates) ─────────
        _importIntoBin(captionsBin, pngPaths);

        // ── Build filename → projectItem lookup ───────────────────────────────
        var itemByName = {};
        var _scanForItems = function (b) {
            for (var si = 0; si < b.children.numItems; si++) {
                var sc = b.children[si];
                try { if (sc.type === 2) { _scanForItems(sc); continue; } } catch (_) {}
                try {
                    var smp = sc.getMediaPath();
                    if (smp) itemByName[smp.replace(/\\/g, '/').split('/').pop()] = sc;
                } catch (_) {}
            }
        };
        _scanForItems(machiCutBin);

        // ── Ensure target video track exists ──────────────────────────────────
        while (seq.videoTracks.numTracks <= trackIndex) {
            try { seq.videoTracks.add(); } catch (_) { break; }
        }
        var track = seq.videoTracks[trackIndex];

        // ── Clear previous MachiCut image clips from the track ────────────────
        for (var di = track.clips.numItems - 1; di >= 0; di--) {
            try {
                var dcn = track.clips[di].projectItem ? track.clips[di].projectItem.name : '';
                if (dcn.indexOf('text_') === 0 || dcn.indexOf('box_') === 0 ||
                    dcn === 'MachiCut Captions' || dcn === 'MachiCut Box Pop') {
                    track.clips[di].remove(false, false);
                }
            } catch (_) {}
        }

        // ── Place each PNG directly on the track ──────────────────────────────
        var placed = 0, errors = [];
        for (var i = 0; i < captions.length; i++) {
            var cap  = captions[i];
            var path = pngPaths[i];
            if (!path) { errors.push('cap' + i + ': no path'); continue; }

            var fname = path.replace(/\\/g, '/').split('/').pop();
            var item  = itemByName[fname];
            if (!item) { errors.push('cap' + i + ': item not found: ' + fname); continue; }

            var startTicks = Math.round(cap.start * TICKS);
            var endTicks   = Math.round(cap.end   * TICKS);

            try {
                var startTime = new Time();
                startTime.ticks = String(startTicks);
                track.overwriteClip(item, startTime);

                // Find the placed clip by its start tick and trim to caption end
                for (var ci = track.clips.numItems - 1; ci >= 0; ci--) {
                    var tc = track.clips[ci];
                    if (Math.abs(parseInt(tc.start.ticks, 10) - startTicks) < 1000) {
                        try {
                            var endTime = new Time();
                            endTime.ticks = String(endTicks);
                            tc.end = endTime;
                        } catch (_) {
                            try { tc.end.ticks = String(endTicks); } catch (_2) {}
                        }
                        break;
                    }
                }
                placed++;
            } catch (e) {
                errors.push('cap' + i + ': ' + e.message);
            }
        }

        return JSON.stringify({ placed: placed, total: captions.length, errors: errors });

    } catch (e) {
        return JSON.stringify({ error: 'buildAndImportCaptionXML: ' + e.message });
    }
}

// ── Box Pop: direct two-track placement (box + text PNGs, optional scale keyframes) ──
function buildAndImportBoxPopXML(textCapsStr, textPathsStr, boxCapsStr, boxPathsStr, trackIndexStr, popStr) {
    try {
        var textCaps   = JSON.parse(textCapsStr);
        var textPaths  = JSON.parse(textPathsStr);
        var boxCaps    = JSON.parse(boxCapsStr);
        var boxPaths   = JSON.parse(boxPathsStr);
        var trackIndex = parseInt(trackIndexStr || '2', 10) - 1;
        var addPop     = (popStr === '1');
        var seq        = getActiveSequence();

        var fps = 30;
        try { fps = Math.round(254016000000 / parseInt(seq.timebase, 10)); } catch (_) {}
        if (!fps || fps < 1 || fps > 240) fps = 30;

        var TICKS        = 254016000000;
        var tickPerFrame = Math.round(TICKS / fps);

        // ── Bin organisation ─────────────────────────────────────────────────
        var machiCutBin = _getOrCreateBin(app.project.rootItem, 'MachiCut');
        var captionsBin = _getOrCreateBin(machiCutBin, 'Captions');

        // ── Import all PNGs directly into the project bin ─────────────────────
        _importIntoBin(captionsBin, boxPaths.concat(textPaths));

        // ── Build filename → projectItem lookup ───────────────────────────────
        var itemByName2 = {};
        var _scanForItems2 = function (b) {
            for (var si = 0; si < b.children.numItems; si++) {
                var sc = b.children[si];
                try { if (sc.type === 2) { _scanForItems2(sc); continue; } } catch (_) {}
                try {
                    var smp = sc.getMediaPath();
                    if (smp) itemByName2[smp.replace(/\\/g, '/').split('/').pop()] = sc;
                } catch (_) {}
            }
        };
        _scanForItems2(machiCutBin);

        // Box PNGs go on trackIndex, text PNGs on trackIndex+1
        var boxTrackIdx  = trackIndex;
        var textTrackIdx = trackIndex + 1;

        // ── Ensure both tracks exist ──────────────────────────────────────────
        while (seq.videoTracks.numTracks <= textTrackIdx) {
            try { seq.videoTracks.add(); } catch (_) { break; }
        }
        var boxTrack  = seq.videoTracks[boxTrackIdx];
        var textTrack = seq.videoTracks[textTrackIdx];

        // ── Clear previous MachiCut clips from both tracks ────────────────────
        var _clearMachiCutClips = function (t) {
            for (var di = t.clips.numItems - 1; di >= 0; di--) {
                try {
                    var dcn = t.clips[di].projectItem ? t.clips[di].projectItem.name : '';
                    if (dcn.indexOf('text_') === 0 || dcn.indexOf('box_') === 0 ||
                        dcn === 'MachiCut Captions' || dcn === 'MachiCut Box Pop') {
                        t.clips[di].remove(false, false);
                    }
                } catch (_) {}
            }
        };
        _clearMachiCutClips(boxTrack);
        _clearMachiCutClips(textTrack);

        var placed = 0, errors = [];

        // ── Inner: place one array of caps/paths onto a track ─────────────────
        var _placeOnTrack = function (track, caps, paths, withKeyframes) {
            for (var i = 0; i < caps.length; i++) {
                var cap  = caps[i];
                var path = paths[i];
                if (!path) { errors.push('cap' + i + ': no path'); continue; }

                var fname = path.replace(/\\/g, '/').split('/').pop();
                var item  = itemByName2[fname];
                if (!item) { errors.push('cap' + i + ': item not found: ' + fname); continue; }

                var startTicks = Math.round(cap.start * TICKS);
                var endTicks   = Math.round(cap.end   * TICKS);

                try {
                    var startTime = new Time();
                    startTime.ticks = String(startTicks);
                    track.overwriteClip(item, startTime);

                    // Find the placed clip and trim/keyframe it
                    var foundClip = null;
                    for (var ci = track.clips.numItems - 1; ci >= 0; ci--) {
                        if (Math.abs(parseInt(track.clips[ci].start.ticks, 10) - startTicks) < 1000) {
                            foundClip = track.clips[ci]; break;
                        }
                    }

                    if (foundClip) {
                        // Trim to caption end
                        try {
                            var endTime = new Time();
                            endTime.ticks = String(endTicks);
                            foundClip.end = endTime;
                        } catch (_) {
                            try { foundClip.end.ticks = String(endTicks); } catch (_2) {}
                        }

                        // Scale keyframes: 80 → 105 → 100 over first 3 frames
                        if (withKeyframes) {
                            try {
                                var motComp = _findMotionComp(foundClip);
                                var sp      = _findMotionProp(motComp, 'Scale', 1);
                                if (sp) {
                                    var t0 = new Time(); t0.ticks = String(startTicks);
                                    var t1 = new Time(); t1.ticks = String(startTicks + tickPerFrame);
                                    var t2 = new Time(); t2.ticks = String(startTicks + 2 * tickPerFrame);
                                    sp.addKeyframe(t0); sp.setValueAtKey(t0, 80);
                                    sp.addKeyframe(t1); sp.setValueAtKey(t1, 105);
                                    sp.addKeyframe(t2); sp.setValueAtKey(t2, 100);
                                }
                            } catch (_) {}
                        }
                    }
                    placed++;
                } catch (e) {
                    errors.push('cap' + i + ': ' + e.message);
                }
            }
        };

        _placeOnTrack(boxTrack,  boxCaps,  boxPaths,  addPop);
        _placeOnTrack(textTrack, textCaps, textPaths, false);

        return JSON.stringify({ placed: placed, total: textCaps.length + boxCaps.length, errors: errors });

    } catch (e) {
        return JSON.stringify({ error: 'buildAndImportBoxPopXML: ' + e.message });
    }
}

// ── Model 4: Place Pre/Current/Post PNG clips in a nested sequence ────────────
/**
 * clipsJsonStr  — JSON array of { pngPath, startTicks, endTicks, track }
 *                 track: 3=Pre, 2=Current, 1=Post (1-based video track numbers)
 * seqName       — name for the nested sequence (created if not found)
 * mainTrackStr  — 1-based video track in main sequence where nested seq is placed
 */
// Search Premiere's SequencePresets folder for any .sqpreset file.
// app.project.newSequence(name, presetPath) needs a real preset path to create
// a sequence silently (no dialog). We search once and reuse the result.
function _findAnyPreset() {
    var search = function (f) {
        try {
            var files = f.getFiles('*.sqpreset');
            if (files && files.length) return files[0].fsName;
            var subs = f.getFiles(function (x) { return x instanceof Folder; });
            if (subs) {
                for (var i = 0; i < subs.length; i++) {
                    var r = search(subs[i]);
                    if (r) return r;
                }
            }
        } catch (_) {}
        return null;
    };
    // Different roots on Mac vs Windows. On Mac the presets sit inside the
    // .app bundle's Contents/ folder; on Windows they're directly under the
    // install folder. Try both — first match wins.
    var roots = [
        Folder.appPackage + '/Contents/Settings/SequencePresets', // macOS
        Folder.appPackage + '/Settings/SequencePresets'           // Windows
    ];
    for (var ri = 0; ri < roots.length; ri++) {
        try {
            var folder = new Folder(roots[ri]);
            if (folder.exists) {
                var hit = search(folder);
                if (hit) return hit;
            }
        } catch (_) {}
    }
    return null;
}

function placeNestedPngBatch(clipsJsonStr, _seqName, mainTrackStr) {
    var _dbg = 'init';
    try {
        _dbg = 'parse';
        var clips          = JSON.parse(clipsJsonStr);
        _dbg = 'seq';
        var baseTrackIndex = parseInt(mainTrackStr || '2', 10) - 1;
        var seq            = getActiveSequence();

        // Find a preset path once — used by all nested-sequence creation calls.
        // newSequence(name, presetPath) runs silently; createNewSequence opens a dialog.
        _dbg = 'preset';
        var _anyPresetPath = _findAnyPreset();

        if (!clips || clips.length === 0) {
            return JSON.stringify({ error: 'No clips to place' });
        }

        _dbg = 'bins';
        var machiCutBin = _getOrCreateBin(app.project.rootItem, 'MachiCut');
        var m4Bin       = _getOrCreateBin(machiCutBin, 'Captions');
        var m4NestBin   = _getOrCreateBin(m4Bin, 'Nested'); // holds all MC_* sequences

        _dbg = 'import';
        var allPaths = [], seen = {};
        for (var pi = 0; pi < clips.length; pi++) {
            var p = clips[pi].pngPath;
            if (p && !seen[p]) { seen[p] = true; allPaths.push(p); }
        }
        _importIntoBin(m4Bin, allPaths);

        _dbg = 'scan';
        var itemByName = {};
        var scanBin = function (b) {
            for (var si = 0; si < b.children.numItems; si++) {
                var sc = b.children[si];
                try { if (sc.type === 2) { scanBin(sc); continue; } } catch (_) {}
                try {
                    var mp = sc.getMediaPath();
                    if (mp) itemByName[mp.replace(/\\/g, '/').split('/').pop()] = sc;
                } catch (_) {}
            }
        };
        scanBin(machiCutBin);

        _dbg = 'tracks';
        var neededTracks = baseTrackIndex + 3;
        while (seq.videoTracks.numTracks < neededTracks) {
            try { seq.videoTracks.add(); } catch (_) { break; }
        }

        _dbg = 'clear';
        for (var ti = 0; ti < 3; ti++) {
            var trk = seq.videoTracks[baseTrackIndex + ti];
            if (!trk) continue;
            for (var di = trk.clips.numItems - 1; di >= 0; di--) {
                try {
                    var cn = trk.clips[di].projectItem ? trk.clips[di].projectItem.name : '';
                    if (cn.indexOf('cap') === 0) trk.clips[di].remove(false, false);
                } catch (_) {}
            }
        }

        _dbg = 'place';

        // ── Sequence dimensions for position calculation ──────────────────────
        var seqW = seq.frameSizeHorizontal || 1920;
        var seqH = seq.frameSizeVertical   || 1080;

        // ── Place each clip ───────────────────────────────────────────────────
        var placed = 0;
        var errors = ['seq:' + seqW + 'x' + seqH];
        for (var ci = 0; ci < clips.length; ci++) {
            var clip   = clips[ci];
            var fname  = (clip.pngPath || '').replace(/\\/g, '/').split('/').pop();
            var item   = itemByName[fname];
            if (!item) { errors.push('not found: ' + fname); continue; }

            // clip.track is 1-based (1=Post, 2=Current, 3=Pre); map onto seq tracks
            var trackIdx = baseTrackIndex + (clip.track || 2) - 1;
            var track    = seq.videoTracks[trackIdx];
            if (!track) { errors.push('no track ' + trackIdx); continue; }

            try {
                // ── For current-word clips: wrap PNG in a nested sequence ──────
                // addKey() silently fails on PNG stills. Wrapping in a nested seq
                // makes the outer clip a video clip → addKey works for Scale bounce.
                var pItem = item;
                if (clip.isCurrent) {
                    var nestedSeqName = 'MC_m4_' + ci;
                    var nestedSeq = null;

                    // Find existing nested seq (re-runs are idempotent)
                    for (var nsi = 0; nsi < app.project.sequences.numSequences; nsi++) {
                        try {
                            if (app.project.sequences[nsi].name === nestedSeqName) {
                                nestedSeq = app.project.sequences[nsi]; break;
                            }
                        } catch (_) {}
                    }
                    // Create if not found.
                    // qe.project.newSequence() creates the sequence WITHOUT opening it as
                    // a timeline tab. app.project.newSequence() opens it automatically.
                    if (!nestedSeq) {
                        try {
                            app.enableQE();
                            if (_anyPresetPath) {
                                qe.project.newSequence(nestedSeqName, _anyPresetPath);
                            } else {
                                app.project.createNewSequence(nestedSeqName, 'AEM4_' + ci);
                            }
                        } catch (cse) { errors.push('createSeq:' + cse.message); }
                        for (var nsi2 = 0; nsi2 < app.project.sequences.numSequences; nsi2++) {
                            try {
                                if (app.project.sequences[nsi2].name === nestedSeqName) {
                                    nestedSeq = app.project.sequences[nsi2]; break;
                                }
                            } catch (_) {}
                        }
                    }

                    if (nestedSeq) {
                        // Place the PNG on V1 of the nested seq at t=0
                        try {
                            while (nestedSeq.videoTracks.numTracks < 1) {
                                try { nestedSeq.videoTracks.add(); } catch (_) { break; }
                            }
                            var nt0 = new Time(); nt0.ticks = '0';
                            nestedSeq.videoTracks[0].overwriteClip(item, nt0);
                        } catch (npe) { errors.push('nestPng:' + npe.message); }

                        // Delete all audio tracks from the nested sequence so that
                        // Premiere does not spawn silent audio clips on the main timeline.
                        // QE approach: open the nested seq temporarily, get it via QE,
                        // delete its audio tracks, then restore the main sequence.
                        try {
                            app.enableQE();
                            nestedSeq.open(); // make nested seq the active timeline
                            var qeNested = qe.project.getActiveSequence();
                            if (qeNested) {
                                var numAT = nestedSeq.audioTracks.numTracks;
                                for (var atd = numAT - 1; atd >= 0; atd--) {
                                    try { qeNested.deleteTrack(false, atd); } catch (_) {}
                                }
                            }
                            seq.open(); // restore main sequence
                        } catch (_) { try { seq.open(); } catch (_) {} }

                        // Find nested seq as a project item (scan full project tree)
                        var scanForName = function (b, nm) {
                            for (var sni = 0; sni < b.children.numItems; sni++) {
                                var ssc = b.children[sni];
                                try { if (ssc.type === 2) { var rr = scanForName(ssc, nm); if (rr) return rr; continue; } } catch (_) {}
                                try { if (ssc.name === nm) return ssc; } catch (_) {}
                            }
                            return null;
                        };
                        var nestedProjItem = scanForName(app.project.rootItem, nestedSeqName);
                        if (nestedProjItem) {
                            // Organize: move into MachiCut/Captions/Nested bin
                            try { nestedProjItem.moveBin(m4NestBin); } catch (_) {}
                            pItem = nestedProjItem;
                        } else { errors.push('no proj item: ' + nestedSeqName); }
                    } else {
                        errors.push('createSeq failed: ' + nestedSeqName);
                    }
                }

                // ── Place on main timeline ────────────────────────────────────
                var startTime = new Time();
                startTime.ticks = String(clip.startTicks);
                var placedClip = track.overwriteClip(pItem, startTime);

                // Trim to word end
                var endTime = new Time();
                endTime.ticks = String(clip.endTicks);
                if (placedClip && placedClip.end !== undefined) {
                    try { placedClip.end = endTime; } catch (_) {}
                } else {
                    for (var tci = track.clips.numItems - 1; tci >= 0; tci--) {
                        var tc = track.clips[tci];
                        if (Math.abs(parseInt(tc.start.ticks, 10) - clip.startTicks) < 10000000000) {
                            try { tc.end = endTime; placedClip = tc; } catch (_) {}
                            break;
                        }
                    }
                }

                // ── Remove audio clips spawned on main timeline by nested seq ─
                // Fallback for if QE audio-track deletion above didn't work.
                // Nested seq audio tracks map to the same-index audio track in the
                // parent sequence. Scan trackIdx + adjacent tracks, match by start
                // time only (name check is unreliable for nested-seq audio items).
                if (clip.isCurrent) {
                    var aRefTicks = parseInt(clip.startTicks, 10);
                    var aMinIdx = Math.max(1, trackIdx - 1); // skip A1 (main video audio)
                    var aMaxIdx = Math.min(seq.audioTracks.numTracks - 1, trackIdx + 2);
                    for (var ati = aMinIdx; ati <= aMaxIdx; ati++) {
                        var aTrack = seq.audioTracks[ati];
                        if (!aTrack) continue;
                        for (var aci = aTrack.clips.numItems - 1; aci >= 0; aci--) {
                            try {
                                var ac = aTrack.clips[aci];
                                if (Math.abs(parseInt(ac.start.ticks, 10) - aRefTicks) < 50000000) {
                                    ac.remove(false, false);
                                }
                            } catch (_) {}
                        }
                    }
                }

                // ── Set position + scale via Motion effect ────────────────────
                try {
                    if (!placedClip) throw new Error('no clip ref');
                    var motion = _findMotionComp(placedClip);
                    if (motion && motion.properties) {
                        // Position is normalized [0,1] — NOT pixels.
                        var posXNorm = (clip.posXFraction || 0.5) + (clip.wordOffsetFromCenter || 0) / seqW;
                        var posYNorm = (clip.posYFraction || 0.85) + (clip.wordLineYOffset || 0) / seqH;

                        // Static position + scale (works for all clip types)
                        var posPropStatic   = _findMotionProp(motion, 'Position', 0);
                        var scalePropStatic = _findMotionProp(motion, 'Scale',    1);
                        try { if (posPropStatic)   posPropStatic.setValue([posXNorm, posYNorm]); } catch (_) {}
                        try { if (scalePropStatic) scalePropStatic.setValue(100); } catch (_) {}

                        if (clip.isCurrent) {
                            // Bounce animation — placedClip is now a nested-seq clip (video),
                            // so addKey() works correctly.
                            var frameTicks  = parseInt(seq.timebase, 10) || 8467200;
                            var snapFrame   = function (t) { return Math.round(t / frameTicks) * frameTicks; };
                            var tClipStart  = snapFrame(parseInt(placedClip.start.ticks, 10));
                            var tClipEnd2   = snapFrame(parseInt(placedClip.end.ticks,   10));
                            var tClipDur    = tClipEnd2 - tClipStart;
                            var tClipPeak   = snapFrame(tClipStart + Math.round(tClipDur * 0.40));
                            var tClipSettle = snapFrame(tClipStart + Math.round(tClipDur * 0.75));

                            var scalePropAnim = _findMotionProp(motion, 'Scale',    1);
                            var posPropAnim   = _findMotionProp(motion, 'Position', 0);

                            if (scalePropAnim) {
                                try {
                                    scalePropAnim.setTimeVarying(true);

                                    var s0 = new Time(); s0.ticks = String(tClipStart);
                                    scalePropAnim.addKey(s0);
                                    scalePropAnim.setValueAtKey(s0, 75, true);

                                    var s1 = new Time(); s1.ticks = String(tClipPeak);
                                    scalePropAnim.addKey(s1);
                                    scalePropAnim.setValueAtKey(s1, 115, true);

                                    var s2 = new Time(); s2.ticks = String(tClipSettle);
                                    scalePropAnim.addKey(s2);
                                    scalePropAnim.setValueAtKey(s2, 100, true);

                                    var s3 = new Time(); s3.ticks = String(tClipEnd2);
                                    scalePropAnim.addKey(s3);
                                    scalePropAnim.setValueAtKey(s3, 100, true);
                                } catch (ke) { errors.push('scaleAnim:' + ke.message); }
                            }

                            // Remove any Position keyframes auto-created by Scale.addKey
                            // then restore static position
                            if (posPropAnim) {
                                try {
                                    for (var pki = posPropAnim.numKeys - 1; pki >= 0; pki--) {
                                        posPropAnim.removeKeyAtTime(posPropAnim.getKeyTime(pki));
                                    }
                                    posPropAnim.setValue([posXNorm, posYNorm]);
                                } catch (_) {}
                            }
                        }
                    }
                } catch (pe) {
                    errors.push('pos' + ci + ':' + pe.message);
                }

                placed++;
            } catch (e) {
                errors.push('clip' + ci + ': ' + e.message);
            }
        }

        // Restore timeline focus to the main sequence.
        // qe.project.newSequence() may still activate the new seq; seq.open() brings back the main one.
        try { seq.open(); } catch (_) {}

        return JSON.stringify({ placed: placed, errors: errors });
    } catch (e) {
        return JSON.stringify({ error: 'placeNestedPngBatch[' + _dbg + ']: ' + e.message });
    }
}

// ── Track utilities ──────────────────────────────────────────────────────────

// Returns JSON { empty: true/false } — checks if video track at 1-based index has any clips
function checkTrackEmpty(trackIndexStr) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: 'No active sequence' });
        var idx = parseInt(trackIndexStr, 10) - 1; // convert to 0-based
        if (idx < 0 || idx >= seq.videoTracks.numTracks) {
            return JSON.stringify({ empty: true }); // track doesn't exist yet → treat as empty
        }
        var track = seq.videoTracks[idx];
        var clipCount = track.clips.numItems;
        return JSON.stringify({ empty: clipCount === 0 });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// Adds a new video track to the active sequence and returns its 1-based index
function addVideoTrack() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: 'No active sequence' });
        var before = seq.videoTracks.numTracks;
        seq.videoTracks.add();
        var after = seq.videoTracks.numTracks;
        if (after <= before) return JSON.stringify({ error: 'Track was not added' });
        return JSON.stringify({ trackIndex: after }); // 1-based index of new track
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// ── Diagnostic: probe transition names via qe.project ───────────────────────
function listVideoTransitions() {
    try {
        // 1. Probe qe.project for transition-related methods
        var methods = [];
        for (var k in qe.project) {
            try { if (k.toLowerCase().indexOf('trans') !== -1) methods.push(k); } catch(_) {}
        }

        // 2. Try known matchNames directly
        var candidates = [
            'AE.AE_Impact_Pop',
            'AE.AE_Impact_Push',
            'AE.AE_Impact_Dissolve',
            'AE.AECrossDissolve',
            'AE.AE_CrossDissolve',
            'VR.VRChromaLeaks',
            'AE.AE_Motion_Pop',
            'Adobe.PopMotion',
            'AE.AE_Pop'
        ];
        var found = [];
        for (var i = 0; i < candidates.length; i++) {
            try {
                var tx = qe.project.getVideoTransitionByName(candidates[i], true);
                if (tx) found.push(candidates[i] + ' → ' + (tx.displayName || 'ok'));
            } catch(_) {}
        }

        return JSON.stringify({ qeMethods: methods, foundTransitions: found });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// ── MachiCut session cleanup ──────────────────────────────────────────────────

/**
 * Finds all AE_ sequences in the project and returns which are unused
 * (not referenced as a clip in any other sequence's video tracks).
 * Returns JSON: { sessions: [{ name, timestamp }], error? }
 */
function findUnusedAeSessions() {
    try {
        var AE_RE = /^MC_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})$/;
        var proj  = app.project;

        // 1 — Collect all MC_ sequences by name
        var aeSessions = {}; // name → { name, timestamp }
        for (var si = 0; si < proj.sequences.numSequences; si++) {
            var seq = proj.sequences[si];
            var m   = AE_RE.exec(seq.name);
            if (m) aeSessions[seq.name] = { name: seq.name, timestamp: m[1] };
        }

        var _aeSessionCount = 0;
        for (var _k in aeSessions) { if (aeSessions.hasOwnProperty(_k)) _aeSessionCount++; }
        if (_aeSessionCount === 0) {
            return JSON.stringify({ sessions: [] });
        }

        // 2 — Scan every sequence's video tracks for clips that reference a MC_ sequence by name
        var usedNames = {};
        for (var si2 = 0; si2 < proj.sequences.numSequences; si2++) {
            var seq2 = proj.sequences[si2];
            // Skip the MC_ sequences themselves
            if (aeSessions[seq2.name]) continue;
            for (var ti = 0; ti < seq2.videoTracks.numTracks; ti++) {
                var track = seq2.videoTracks[ti];
                for (var ci = 0; ci < track.clips.numItems; ci++) {
                    try {
                        var clip = track.clips[ci];
                        var item = clip.projectItem;
                        if (!item) continue;
                        var itemName = item.name;
                        if (itemName && aeSessions[itemName]) usedNames[itemName] = true;
                    } catch (_) {}
                }
            }
        }

        // 3 — Unused sequences
        var unusedNames = {};
        for (var id in aeSessions) {
            if (!usedNames[id]) unusedNames[id] = aeSessions[id];
        }

        // 4 — Also find MC_ bins (orphaned PNG containers from failed/unused apply runs)
        function _scanBins(bin) {
            try {
                for (var bi = 0; bi < bin.children.numItems; bi++) {
                    var child = bin.children[bi];
                    try {
                        var bm = AE_RE.exec(child.name);
                        if (bm && !usedNames[child.name] && !unusedNames[child.name]) {
                            unusedNames[child.name] = { name: child.name, timestamp: bm[1] };
                        }
                        if (child.children && child.children.numItems >= 0) _scanBins(child);
                    } catch (_) {}
                }
            } catch (_) {}
        }
        _scanBins(proj.rootItem);

        var unused = [];
        for (var un in unusedNames) { unused.push(unusedNames[un]); }

        return JSON.stringify({ sessions: unused });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

/**
 * Removes MC_ sequences from the project by name.
 * namesJson: JSON array of sequence names to remove.
 * Returns JSON: { removed, errors }
 */
function removeAeSessions(namesJson) {
    try {
        var names   = JSON.parse(namesJson);
        var removed = 0;
        var errors  = [];

        for (var ni = 0; ni < names.length; ni++) {
            try {
                _removeProjectItemsByName(names[ni], app.project.rootItem);
                removed++;
            } catch (e2) {
                errors.push(names[ni] + ': ' + e2.message);
            }
        }

        return JSON.stringify({ removed: removed, errors: errors });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Library — insert an arsenal item (SFX / overlay / image) at the playhead
// ════════════════════════════════════════════════════════════════════════════

/**
 * Finds a project item by its media path (normalized, case-insensitive) by
 * scanning a bin recursively. Returns the projectItem or null.
 */
function _findItemByPath(bin, normPathLower) {
    for (var i = 0; i < bin.children.numItems; i++) {
        var c = bin.children[i];
        try {
            var mp = c.getMediaPath();
            if (mp && mp.replace(/\\/g, '/').toLowerCase() === normPathLower) return c;
        } catch (_) {}
        try { if (c.type === 2) { var r = _findItemByPath(c, normPathLower); if (r) return r; } } catch (_) {}
    }
    return null;
}

/**
 * True if any clip on `trk` overlaps sequence-time `tSec`.
 */
function _trackBusyAt(trk, tSec) {
    for (var i = 0; i < trk.clips.numItems; i++) {
        try {
            var c = trk.clips[i];
            if (tSec >= c.start.seconds - 0.0005 && tSec < c.end.seconds - 0.0005) return true;
        } catch (_) {}
    }
    return false;
}

/**
 * Picks a track to drop an overlay/SFX onto without overwriting existing
 * content: use the topmost track if it's free at `tSec`, otherwise add a
 * new track on top. `tracks` is seq.videoTracks or seq.audioTracks.
 * Returns the chosen track object.
 */
function _pickFreeTopTrack(tracks, tSec) {
    var idx = tracks.numTracks - 1;
    if (idx < 0 || _trackBusyAt(tracks[idx], tSec)) {
        try { tracks.add(); idx = tracks.numTracks - 1; } catch (_) {}
    }
    return tracks[idx];
}

/**
 * libraryInsertItem(pathStr, kindStr, seqId, cueSec)
 * Imports a media file into the MachiCut/Library bin (deduped) and drops it at
 * the sequence playhead. kindStr: 'audio' → topmost audio track; 'video' |
 * 'image' → topmost video track. Never overwrites: adds a track if the top one
 * is occupied at the playhead.
 * cueSec (optional, audio): the offset of the sound's audible "hit" from the
 * file start — the clip is placed at (playhead − cueSec) so the hit lands ON
 * the playhead instead of the file's silent lead-in.
 * Returns JSON { ok:true } or { error }.
 */
function libraryInsertItem(pathStr, kindStr, seqId, cueSec) {
    try {
        if (!pathStr) return JSON.stringify({ error: 'No file path given.' });
        var f = new File(pathStr);
        if (!f.exists) return JSON.stringify({ error: 'File not found on disk.' });

        var seq = _getSeqById(seqId || '');

        // Playhead (Time) + cue alignment (audio only; 0 for everything else).
        var tSec = 0;
        try { tSec = seq.getPlayerPosition().seconds; } catch (_) { tSec = 0; }
        var cue = parseFloat(cueSec) || 0;
        var placeSec = tSec - cue;
        if (placeSec < 0) placeSec = 0;

        // ── MOGRT: a Motion Graphics Template is placed with importMGT, not the
        //    importFiles + overwriteClip path. It lands on a free top video
        //    track at the playhead; the user then tweaks it in Essential Graphics.
        if (kindStr === 'mogrt') {
            var vtracks = seq.videoTracks;
            var vi = vtracks.numTracks - 1;
            if (vi < 0 || _trackBusyAt(vtracks[vi], placeSec)) {
                try { vtracks.add(); } catch (_) {}
                vi = vtracks.numTracks - 1;
            }
            try {
                seq.importMGT(pathStr, secondsToTicks(placeSec), vi, 0);
            } catch (me) {
                return JSON.stringify({ error: 'Premiere could not import this MOGRT: ' + me.message });
            }
            return JSON.stringify({ ok: true });
        }

        // ── Media (audio / video / image): import into the bin, place at playhead.
        var libBin  = _getOrCreateBin(_getOrCreateBin(app.project.rootItem, 'MachiCut'), 'Library');
        var normLow = pathStr.replace(/\\/g, '/').toLowerCase();
        var item = _findItemByPath(libBin, normLow);
        if (!item) {
            try { app.project.importFiles([pathStr], true, libBin, false); } catch (ie) {}
            item = _findItemByPath(libBin, normLow);
        }
        if (!item) return JSON.stringify({ error: 'Failed to import the file.' });

        var playhead = new Time(); playhead.seconds = placeSec;
        var track = (kindStr === 'audio')
            ? _pickFreeTopTrack(seq.audioTracks, placeSec)
            : _pickFreeTopTrack(seq.videoTracks, placeSec);
        if (!track) return JSON.stringify({ error: 'No track available.' });

        track.overwriteClip(item, playhead);
        return JSON.stringify({ ok: true });
    } catch (e) {
        return JSON.stringify({ error: 'libraryInsertItem: ' + e.message });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Motion 3D tool — media-in from the project, sequence spec, clip placement.
// The panel renders the animation to a ProRes 4444 (alpha) .mov; these
// three functions feed it source media and drop the result on the timeline.
// ═══════════════════════════════════════════════════════════════════════

// Paths of the project items currently selected in the Project panel
// (images + video only). The panel reads the bytes itself (Node fs) so it
// can rebuild them as same-origin Blobs — that keeps the WebGL canvas
// un-tainted, so readPixels/toBlob work at export time.
// Collect the ProjectItems selected in any Project-panel view. Premiere
// exposes selection differently across builds — try each in turn.
function _selected3DItems() {
    var acc = [], i, j;
    // 1) Per-view selection (modern, most reliable). Iterate every project view.
    try {
        if (typeof app.getProjectViewIDs === 'function' && typeof app.getProjectViewSelection === 'function') {
            var ids = app.getProjectViewIDs();
            if (ids && ids.length) {
                for (i = 0; i < ids.length; i++) {
                    var s = null;
                    try { s = app.getProjectViewSelection(ids[i]); } catch (_) {}
                    if (s && s.length) for (j = 0; j < s.length; j++) if (s[j]) acc.push(s[j]);
                }
            }
            if (acc.length) return acc;
        }
    } catch (_) {}
    // 2) Current-view selection (older single-view helper).
    try {
        if (typeof app.getCurrentProjectViewSelection === 'function') {
            var s2 = app.getCurrentProjectViewSelection();
            if (s2 && s2.length) { for (i = 0; i < s2.length; i++) if (s2[i]) acc.push(s2[i]); return acc; }
        }
    } catch (_) {}
    // 3) Project-level helper (Array or collection).
    try {
        if (typeof app.project.getSelectedProjectItems === 'function') {
            var s3 = app.project.getSelectedProjectItems();
            if (s3) { var n = (s3.numItems !== undefined) ? s3.numItems : (s3.length || 0);
                for (i = 0; i < n; i++) if (s3[i]) acc.push(s3[i]); }
        }
    } catch (_) {}
    return acc;
}

function get3DSourceMedia() {
    try {
        var sel = _selected3DItems();
        var out = [];
        var rx = /\.(jpg|jpeg|png|gif|bmp|webp|tif|tiff|mp4|mov|m4v|avi|mkv|webm|mpg|mpeg|wmv)$/i;
        for (var i = 0; i < sel.length; i++) {
            var it = sel[i];
            var p = '';
            try { p = it.getMediaPath(); } catch (_) {}
            // A bin/sequence has no media path — skip; only real footage/stills qualify.
            if (!p || !rx.test(p)) continue;
            out.push({ name: String(it.name || ''), path: p });
        }
        return JSON.stringify({ items: out, selected: sel.length });
    } catch (e) {
        return JSON.stringify({ error: 'get3DSourceMedia: ' + e.message });
    }
}

// Active sequence dimensions / fps / playhead — the panel conforms its
// canvas to this so the design surface IS the output frame, and the export
// runs at the sequence frame rate.
function getActiveSequenceSpec() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: 'No active sequence. Open a sequence first.' });
        var w = 0, h = 0, fps = 30, playheadTicks = '0';
        try { var st = seq.getSettings(); if (st) { w = st.videoFrameWidth; h = st.videoFrameHeight; } } catch (_) {}
        if (!w || w < 16 || !h || h < 16) {           // fallback: the sequence's own frame size (a vertical sequence must NOT silently become 1920×1080)
            try { w = seq.frameSizeHorizontal; h = seq.frameSizeVertical; } catch (_) {}
        }
        // EXACT rate — Math.round would turn 29.97 into 30 and drift every clip 0.1% against the sequence
        try { fps = 254016000000 / parseInt(seq.timebase, 10); } catch (_) {}
        if (!fps || fps < 1 || fps > 240) fps = 30;
        fps = Math.round(fps * 10000) / 10000;        // trim float noise (29.970029970… → 29.97)
        try { playheadTicks = String(seq.getPlayerPosition().ticks); } catch (_) {}
        if (!w || w < 16) w = 1920;
        if (!h || h < 16) h = 1080;
        return JSON.stringify({ w: w, h: h, fps: fps, playheadTicks: playheadTicks });
    } catch (e) {
        return JSON.stringify({ error: 'getActiveSequenceSpec: ' + e.message });
    }
}

// Import the rendered ProRes 4444 clip into MachiCut/3D and overwrite it at
// the playhead, on a fresh (or empty) top video track so it composites over
// the user's footage via its alpha channel.
// Add N video tracks to the ACTIVE sequence, QE-first. seq.videoTracks.add()
// isn't a documented Premiere DOM API — on many builds it throws or no-ops,
// which left 3D exports failing with "could not add a video track" whenever
// the timeline was full at the playhead. QE addTracks is what the caption
// system already relies on (see the nested-seq builder). DOM add() stays as
// a per-track fallback for builds where it happens to work.
// Returns the number of tracks actually gained.
function _addVideoTracks(seq, n) {
    var before = seq.videoTracks.numTracks;
    try {
        app.enableQE();
        var q = qe.project.getActiveSequence();
        if (q) q.addTracks(n, before - 1, 0);
    } catch (_) {}
    var prev = seq.videoTracks.numTracks;
    while (seq.videoTracks.numTracks < before + n) {
        try { seq.videoTracks.add(); } catch (_) { break; }
        if (seq.videoTracks.numTracks <= prev) break;   // add() silently no-oped — stop looping
        prev = seq.videoTracks.numTracks;
    }
    return seq.videoTracks.numTracks - before;
}

function place3DClip(movPath, playheadTicks) {
    var _dbg = 'init';
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });

        _dbg = 'bin';
        var mcBin  = _getOrCreateBin(app.project.rootItem, 'MachiCut');
        var bin3d  = _getOrCreateBin(mcBin, '3D');

        _dbg = 'import';
        app.project.importFiles([movPath], true, bin3d, false);

        _dbg = 'find';
        var norm = movPath.replace(/\\/g, '/').toLowerCase();
        var item = null;
        for (var i = bin3d.children.numItems - 1; i >= 0; i--) {
            var c = bin3d.children[i];
            try {
                var mp = c.getMediaPath();
                if (mp && mp.replace(/\\/g, '/').toLowerCase() === norm) { item = c; break; }
            } catch (_) {}
        }
        if (!item) return JSON.stringify({ error: 'Imported clip not found in bin.' });

        _dbg = 'track';
        var vts = seq.videoTracks, trk = null, trkIdx = -1;
        function _vLocked(ix) {   // best-effort QE lock check (overwriteClip on a locked track no-ops or throws)
            try { app.enableQE(); var q = qe.project.getActiveSequence().getVideoTrackAt(ix); return q ? q.isLocked() : false; } catch (_) { return false; }
        }
        // BOTTOM-UP FIRST-FIT by time range: the LOWEST unlocked track with
        // enough free space from the playhead (clip duration) takes the clip —
        // V1 busy at the playhead → V2, even if V5 is empty. Clips elsewhere
        // on the track are fine; the range check means we can never land on a
        // user clip. Only when NO track fits do we add a fresh one on top.
        var sT = Number(String(playheadTicks || '0')) || 0, dT = 0;
        try { dT = Number(item.getOutPoint().ticks) - Number(item.getInPoint().ticks); } catch (_) {}
        if (!(dT > 0)) { try { dT = Number(item.getOutPoint().ticks); } catch (_) {} }   // unknown → clear from playhead onward
        function _freeAt(ix) {
            if (_vLocked(ix)) return false;
            var cand = vts[ix], ci, cl, cs, ce;
            for (ci = 0; ci < cand.clips.numItems; ci++) {
                cl = cand.clips[ci];
                try { cs = Number(cl.start.ticks); ce = Number(cl.end.ticks); } catch (_) { return false; }
                if (dT > 0 ? (cs < sT + dT && ce > sT) : (ce > sT)) return false;
            }
            return true;
        }
        for (var ti = 0; ti < vts.numTracks && !trk; ti++)
            if (_freeAt(ti)) { trk = vts[ti]; trkIdx = ti; }
        if (!trk) {
            var before = vts.numTracks;
            _addVideoTracks(seq, 1);
            if (seq.videoTracks.numTracks > before && !_vLocked(before)) {
                trkIdx = before; trk = seq.videoTracks[trkIdx];
            }
        }
        if (!trk) return JSON.stringify({ error: 'Could not add a video track, and no existing track has free space at the playhead for the 3D clip. Free some space and try again.' });

        _dbg = 'place';
        var t = new Time(); t.ticks = String(playheadTicks || '0');
        trk.overwriteClip(item, t);
        _dbg = 'verify';
        try {   // verify the clip actually landed (a silent no-op would report success with an empty timeline)
            var landed = false;
            for (var vc = 0; vc < trk.clips.numItems; vc++) {
                var cc = trk.clips[vc];
                try { var cmp = cc.projectItem && cc.projectItem.getMediaPath(); if (cmp && cmp.replace(/\\/g, '/').toLowerCase() === norm) { landed = true; break; } } catch (_) {}
            }
            if (!landed) return JSON.stringify({ error: 'Premiere did not place the clip (is the target track locked?).' });
        } catch (_) {}

        return JSON.stringify({ placed: 1, track: vts.numTracks });
    } catch (e) {
        return JSON.stringify({ error: 'place3DClip[' + _dbg + ']: ' + e.message });
    }
}

// Motion 3D SPLIT render: place the BACK-half clip, leave an EMPTY track, then the
// FRONT-half clip above — the user drops their person/footage on the middle track
// and it sits inside the ring (cards pass in front of and behind it).
function place3DSplitClips(backPath, frontPath, playheadTicks) {
    var _dbg = 'init';
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });

        _dbg = 'bin';
        var mcBin = _getOrCreateBin(app.project.rootItem, 'MachiCut');
        var bin3d = _getOrCreateBin(mcBin, '3D');

        _dbg = 'import';
        app.project.importFiles([backPath, frontPath], true, bin3d, false);

        _dbg = 'find';
        function _findByPath(p) {
            var norm = p.replace(/\\/g, '/').toLowerCase();
            for (var i = bin3d.children.numItems - 1; i >= 0; i--) {
                var c = bin3d.children[i];
                try { var mp = c.getMediaPath(); if (mp && mp.replace(/\\/g, '/').toLowerCase() === norm) return c; } catch (_) {}
            }
            return null;
        }
        var itemB = _findByPath(backPath), itemF = _findByPath(frontPath);
        if (!itemB || !itemF) return JSON.stringify({ error: 'Imported split clips not found in bin.' });

        _dbg = 'track';
        function _vLocked(ix) {
            try { app.enableQE(); var q = qe.project.getActiveSequence().getVideoTrackAt(ix); return q ? q.isLocked() : false; } catch (_) { return false; }
        }
        var vts = seq.videoTracks, base = -1, q2;
        // FIRST-FIT: the LOWEST three consecutive unlocked tracks whose time range under the
        // clips is FREE (V1-V3 on an empty timeline) — clips elsewhere on those tracks are fine.
        // Unknown clip duration -> require the tracks clear from the playhead onward.
        var sT = Number(String(playheadTicks || '0')) || 0, dT = 0;
        try { dT = Number(itemB.getOutPoint().ticks) - Number(itemB.getInPoint().ticks); } catch (_) {}
        if (!(dT > 0)) { try { dT = Number(itemB.getOutPoint().ticks); } catch (_) {} }
        function _freeAt(ix) {
            if (_vLocked(ix)) return false;
            var trk = vts[ix], ci, cl, cs, ce;
            for (ci = 0; ci < trk.clips.numItems; ci++) {
                cl = trk.clips[ci];
                try { cs = Number(cl.start.ticks); ce = Number(cl.end.ticks); } catch (_) { return false; }
                if (dT > 0 ? (cs < sT + dT && ce > sT) : (ce > sT)) return false;
            }
            return true;
        }
        for (q2 = 0; q2 + 2 < vts.numTracks && base < 0; q2++)
            if (_freeAt(q2) && _freeAt(q2 + 1) && _freeAt(q2 + 2)) base = q2;
        if (base < 0) {
            // No full 3-run among existing tracks. REUSE the free tracks already
            // at the TOP as the bottom of the stack and add only the missing
            // ones — e.g. V5 free but last: back=V5, add V6+V7 (middle empty).
            // The main loop already ruled out a full run, so the top run is 0-2.
            var run = 0;
            while (run < 3 && vts.numTracks - 1 - run >= 0 && _freeAt(vts.numTracks - 1 - run)) run++;
            var before = vts.numTracks, need = 3 - run;
            _addVideoTracks(seq, need);
            if (seq.videoTracks.numTracks < before + need) return JSON.stringify({ error: 'No three consecutive tracks have free space at the playhead, and new tracks could not be added (track limit or locked sequence).' });
            base = before - run;
            for (q2 = 0; q2 < 3; q2++) if (_vLocked(base + q2)) return JSON.stringify({ error: 'A new video track is locked - unlock it and try again.' });
        }

        _dbg = 'place';
        var t = new Time(); t.ticks = String(playheadTicks || '0');
        seq.videoTracks[base].overwriteClip(itemB, t);        // BACK half — lowest of the three
        seq.videoTracks[base + 2].overwriteClip(itemF, t);    // FRONT half — top; the middle track stays EMPTY for the user's clip

        _dbg = 'verify';
        function _landed(trk, p) {
            var norm = p.replace(/\\/g, '/').toLowerCase();
            try {
                for (var vc = 0; vc < trk.clips.numItems; vc++) {
                    var cc = trk.clips[vc];
                    try { var cmp = cc.projectItem && cc.projectItem.getMediaPath(); if (cmp && cmp.replace(/\\/g, '/').toLowerCase() === norm) return true; } catch (_) {}
                }
            } catch (_) { return true; }                      // verification itself failing must not fail a placed export
            return false;
        }
        if (!_landed(seq.videoTracks[base], backPath) || !_landed(seq.videoTracks[base + 2], frontPath))
            return JSON.stringify({ error: 'Premiere did not place both split clips (locked tracks?).' });

        return JSON.stringify({ placed: 2, middleTrack: base + 2 });   // 1-based V-number of the empty middle track
    } catch (e) {
        return JSON.stringify({ error: 'place3DSplitClips[' + _dbg + ']: ' + e.message });
    }
}

// Motion 3D — media path of the clip currently selected on the timeline, so the
// panel can show the user's footage BEHIND the 3D preview (a compositing guide).
function get3DBgClip() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var vts = seq.videoTracks, i, j;
        for (i = vts.numTracks - 1; i >= 0; i--) {           // prefer upper tracks
            var trk = vts[i];
            for (j = 0; j < trk.clips.numItems; j++) {
                var c = trk.clips[j];
                try {
                    if (c.isSelected && c.isSelected()) {
                        var p = c.projectItem ? c.projectItem.getMediaPath() : '';
                        if (p) {
                            var inS = 0, outS = 0;   // SOURCE in/out of the (possibly trimmed) clip, in seconds
                            try { inS = c.inPoint ? Number(c.inPoint.seconds) : 0; } catch (_) {}
                            try { outS = c.outPoint ? Number(c.outPoint.seconds) : 0; } catch (_) {}
                            var dur = (outS > inS) ? (outS - inS) : 0;
                            return JSON.stringify({ path: p, name: String(c.name || ''), inPoint: inS, clipDur: dur });
                        }
                    }
                } catch (_) {}
            }
        }
        return JSON.stringify({ error: 'No clip selected on the timeline — click a clip first.' });
    } catch (e) {
        return JSON.stringify({ error: 'get3DBgClip: ' + e.message });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// ── Motion Engine (Keyframe Generator) — Premiere adapter ──────────────
// The panel-side engine (modules/motion-engine.js + motion-panel.js)
// resolves presets into ABSOLUTE keyframe times per selected clip. This
// adapter finds the matching Motion / Opacity params, marks them
// time-varying, adds keyframes and sets values — all inside ONE undo
// group so Ctrl+Z removes the whole animation in one step.
// ═══════════════════════════════════════════════════════════════════════

function motionGetSelection() {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (se) {}
        var items = [];
        for (var i = 0; i < sel.length; i++) {
            var it = sel[i];
            var s = 0, e = 0;
            try { s = Number(it.start.seconds); } catch (x) {}
            try { e = Number(it.end.seconds); } catch (x) {}
            if (isNaN(s)) s = 0;
            if (isNaN(e)) e = 0;
            items.push({ index: i, start: s, end: e, duration: Math.max(0, e - s) });
        }
        var fps = 30;
        try { fps = Math.round(254016000000 / parseInt(seq.timebase, 10)); } catch (x) {}
        if (!(fps > 0)) fps = 30;
        return JSON.stringify({ items: items, fps: fps });
    } catch (e) {
        return JSON.stringify({ error: 'motionGetSelection: ' + e.message });
    }
}

// Payload: [{ clipIndex, properties: { scale: [{t,v}], opacity: [{t,v}],
//   rotation: [{t,v}], position: [{t, v:{x,y}}] }, ease }]
function motionApplyClipKeyframes(payloadJSON) {
    var list;
    try { list = JSON.parse(payloadJSON); } catch (e) { return JSON.stringify({ error: 'Bad motion payload.' }); }
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (se) {}
        var appliedClips = 0;
        var appliedKeys = 0;
        var skipped = [];
        try { app.beginUndoGroup('CompX Orbit - Apply Motion'); } catch (u) {}
        try {
            for (var i = 0; i < list.length; i++) {
                var entry = list[i];
                var ti = (entry && entry.clipIndex >= 0 && entry.clipIndex < sel.length) ? sel[entry.clipIndex] : null;
                if (!ti) { skipped.push(entry ? entry.clipIndex : -1); continue; }
                var count = motionApplyToClip(ti, entry.properties, entry.ease);
                if (count > 0) appliedClips++;
                appliedKeys += count;
            }
        } catch (inner) {
            try { app.endUndoGroup(); } catch (u2) {}
            return JSON.stringify({ error: inner.message, applied: appliedKeys });
        }
        try { app.endUndoGroup(); } catch (u3) {}
        return JSON.stringify({ ok: true, clips: appliedClips, keys: appliedKeys, skipped: skipped });
    } catch (e) {
        return JSON.stringify({ error: 'motionApplyClipKeyframes: ' + e.message });
    }
}

function motionApplyToClip(ti, properties, ease) {
    var total = 0;
    for (var propName in properties) {
        if (!properties.hasOwnProperty(propName)) continue;
        var param = motionFindParam(ti, propName);
        if (!param) continue;
        var kfs = properties[propName];
        if (!kfs || !kfs.length) continue;
        try { param.setTimeVarying(true); } catch (tv) {}
        var base = null;
        for (var k = 0; k < kfs.length; k++) {
            var kf = kfs[k];
            var time = motionMakeTime(ti, Number(kf.t));
            if (!time) continue;
            var value = kf.v;
            if (propName === 'position') {
                if (base === null) base = motionReadPosition(param, ti);
                value = motionAddOffset(base, value);
            }
            if (motionSetKeyframe(param, time, propName, value)) {
                motionTryInterpolation(param, time, ease);
                total++;
            }
        }
    }
    return total;
}

function motionFindParam(ti, name) {
    try {
        var comps = ti.components;
        var n = comps.numItems || comps.length || 0;
        for (var c = 0; c < n; c++) {
            var comp = comps[c];
            var props = comp.properties || comp.parameters;
            var pc = props ? (props.numItems || props.length || 0) : 0;
            for (var p = 0; p < pc; p++) {
                var pr = props[p];
                var dn = String((pr && (pr.displayName || pr.name || pr.matchName)) || '').toLowerCase();
                if (dn === name) return pr;
            }
        }
    } catch (e) {}
    return null;
}

// NEVER mutate ti.start here. On builds where a TrackItem boundary is
// writable, assigning to ti.start.seconds MOVES THE CLIP instead of producing
// a timestamp — the same assignment _composerSetTimelineBoundary uses to trim.
// A keyframe helper must always build a fresh Time.
function motionMakeTime(ti, seconds) {
    try { var t = new Time(); t.seconds = Number(seconds); return t; } catch (e1) {}
    try { var t2 = new Time(); t2.ticks = String(Math.round(Number(seconds) * 254016000000)); return t2; } catch (e2) {}
    return null;
}

// Component-parameter keyframes are addressed in the clip's SOURCE time, not
// sequence time: source = clip.inPoint + (sequenceTime - clip.start).
function motionSourceTime(ti, clipRelativeSeconds) {
    var base = 0;
    try { base = Number(ti.inPoint.seconds) || 0; } catch (e) {}
    return motionMakeTime(ti, base + (Number(clipRelativeSeconds) || 0));
}

function motionClipRelative(ti, sourceSeconds) {
    var base = 0;
    try { base = Number(ti.inPoint.seconds) || 0; } catch (e) {}
    return (Number(sourceSeconds) || 0) - base;
}

function motionReadPosition(param, ti) {
    try {
        var v = param.getValueAtTime(ti.start);
        if (v !== undefined && v !== null) return v;
    } catch (e) {}
    return [0, 0];
}

function motionAddOffset(base, offset) {
    var bx = 0, by = 0;
    if (base && base.length && base.length >= 2) { bx = Number(base[0]) || 0; by = Number(base[1]) || 0; }
    else if (base && typeof base === 'object') { bx = Number(base.x) || 0; by = Number(base.y) || 0; }
    var ox = (offset && typeof offset === 'object') ? (Number(offset.x) || 0) : 0;
    var oy = (offset && typeof offset === 'object') ? (Number(offset.y) || 0) : 0;
    return [bx + ox, by + oy];
}

function motionSetKeyframe(param, time, propName, value) {
    try { param.addKeyframe(time); } catch (e) {}
    var candidates = [];
    if (propName === 'scale') candidates.push([value, value], value);
    else if (Array.isArray(value)) candidates.push(value, value.length ? value[0] : value);
    else if (value && typeof value === 'object') candidates.push([Number(value.x) || 0, Number(value.y) || 0], value);
    else candidates.push(value);
    for (var i = 0; i < candidates.length; i++) {
        try { param.setValueAtTime(time, candidates[i]); return true; } catch (e2) {}
    }
    // Last resort: some builds accept a raw seconds number.
    try { param.setValueAtTime(Number(time.seconds), candidates[0]); return true; } catch (e3) {}
    return false;
}

function motionTryInterpolation(param, time, ease) {
    if (!ease || ease === 'linear') return;
    var idx = { 'ease': 1, 'ease-in': 2, 'ease-out': 3, 'overshoot': 1 }[ease];
    if (idx === undefined) return;
    try { param.setInterpolationAtKeyframe(time, idx); return; } catch (e) {}
    try { param.setInterpolationAtKeyframe(time, ease); } catch (e2) {}
}

// ── Motion Lab — clip keyframe inspection and baking ────────────────────────
// Premiere's ExtendScript exposes no bezier handles on a clip's effect
// keyframes: setInterpolationTypeAtKey only picks Linear/Bezier/Hold, and the
// handles behind Bezier cannot be read or written. The only way to get a real
// ease, bounce or elastic curve onto a clip is therefore to BAKE it — replace
// the span between two keys with many linear keys whose VALUES follow the
// curve. That is what Easify does on this host, and what these endpoints do.
//
// Curve maths lives on the panel side (modules/motion-lab.js) where it can be
// unit-tested; ExtendScript only reads keys and writes the values it is given.
// Properties are addressed by component + property INDEX, never displayName,
// because Premiere localises displayName.

function _motionProp(ti, componentIndex, propertyIndex) {
    try {
        var comps = ti.components;
        var comp = comps[componentIndex];
        if (!comp) return null;
        var props = comp.properties || comp.parameters;
        return (props && props[propertyIndex]) || null;
    } catch (e) { return null; }
}

function _motionKeyable(prop) {
    try { if (prop.areKeyframesSupported && !prop.areKeyframesSupported()) return false; } catch (e) {}
    try { if (typeof prop.setValueAtKey !== 'function' && typeof prop.setValueAtTime !== 'function') return false; } catch (e2) {}
    return true;
}

function _motionKeyTimes(prop) {
    var out = [];
    try {
        var keys = prop.getKeys();
        if (!keys) return out;
        var n = keys.numItems || keys.length || 0;
        for (var i = 0; i < n; i++) {
            var t = keys[i];
            var sec = NaN;
            try { sec = Number(t.seconds); } catch (e) {}
            if (isNaN(sec)) { try { sec = parseInt(t.ticks, 10) / 254016000000; } catch (e2) {} }
            if (!isNaN(sec)) out.push(sec);
        }
    } catch (e3) {}
    out.sort(function (a, b) { return a - b; });
    return out;
}

function _motionReadAt(prop, time) {
    try { return prop.getValueAtKey(time); } catch (e) {}
    try { return prop.getValueAtTime(time); } catch (e2) {}
    return null;
}

function _motionWriteAt(prop, time, value) {
    try { prop.addKey(time); } catch (e) {}
    try { prop.addKeyframe(time); } catch (e2) {}
    try { prop.setValueAtKey(time, value, true); return true; } catch (e3) {}
    try { prop.setValueAtKey(time, value); return true; } catch (e4) {}
    try { prop.setValueAtTime(time, value); return true; } catch (e5) {}
    return false;
}

function _motionRemoveRange(prop, startTime, endTime) {
    try { prop.removeKeyRange(startTime, endTime, true); return true; } catch (e) {}
    try { prop.removeKeyRange(startTime, endTime); return true; } catch (e2) {}
    return false;
}

// Reports every keyframable property on the selected clips, with its key times
// expressed clip-relative so the panel never has to know about source offsets.
function motionInspectKeyframes() {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'Open a sequence and select a clip.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (e) {}
        if (!sel || !sel.length) return JSON.stringify({ error: 'Select one or more timeline clips.' });
        var fps = 30;
        try { fps = Math.round(254016000000 / parseInt(seq.timebase, 10)); } catch (e2) {}
        if (!(fps > 0)) fps = 30;
        var playhead = NaN;
        try { playhead = Number(seq.getPlayerPosition().seconds); } catch (e0) {}
        var clips = [], totalKeyed = 0;
        for (var i = 0; i < sel.length; i++) {
            var ti = sel[i], name = '';
            try { name = String(ti.name || (ti.projectItem && ti.projectItem.name) || ('Clip ' + (i + 1))); } catch (e3) { name = 'Clip ' + (i + 1); }
            var entry = { index: i, name: name, start: 0, end: 0, properties: [] };
            try { entry.start = Number(ti.start.seconds) || 0; } catch (e4) {}
            try { entry.end = Number(ti.end.seconds) || 0; } catch (e5) {}
            entry.duration = Math.max(0, entry.end - entry.start);
            // Clip-relative so the panel never has to redo the conversion.
            entry.playhead = isNaN(playhead) ? null : (playhead - entry.start);
            var comps = null, cn = 0;
            try { comps = ti.components; cn = comps.numItems || comps.length || 0; } catch (e6) {}
            for (var c = 0; c < cn; c++) {
                var comp = null, cname = '';
                try { comp = comps[c]; cname = String(comp.displayName || comp.matchName || ('Effect ' + (c + 1))); } catch (e7) { continue; }
                var props = null, pn = 0;
                try { props = comp.properties || comp.parameters; pn = props ? (props.numItems || props.length || 0) : 0; } catch (e8) { continue; }
                for (var p = 0; p < pn; p++) {
                    var prop = null;
                    try { prop = props[p]; } catch (e9) { continue; }
                    if (!prop || !_motionKeyable(prop)) continue;
                    var varying = false;
                    try { varying = !!(prop.isTimeVarying && prop.isTimeVarying()); } catch (e10) {}
                    var times = varying ? _motionKeyTimes(prop) : [];
                    var rel = [];
                    for (var k = 0; k < times.length; k++) rel.push(motionClipRelative(ti, times[k]));
                    if (varying && rel.length) totalKeyed++;
                    var pname = '';
                    try { pname = String(prop.displayName || prop.name || prop.matchName || ('Param ' + (p + 1))); } catch (e11) { pname = 'Param ' + (p + 1); }
                    entry.properties.push({
                        component: c, property: p, effect: cname, name: pname,
                        animated: varying, keys: rel
                    });
                }
            }
            clips.push(entry);
        }
        return JSON.stringify({ ok: true, fps: fps, clips: clips, animatedProperties: totalKeyed });
    } catch (e) {
        return JSON.stringify({ error: 'motionInspectKeyframes: ' + e.message });
    }
}

// Payload: { clipIndex, component, property }
// Premiere exposes no way to read a property's CURVE, only its values, so the
// panel has to fetch the value at every key before it can bake a new one.
function motionReadKeyValues(payloadJSON) {
    var payload;
    try { payload = JSON.parse(payloadJSON); } catch (e) { return JSON.stringify({ error: 'Bad motion payload.' }); }
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (e2) {}
        var ti = sel[payload.clipIndex];
        if (!ti) return JSON.stringify({ error: 'Clip is no longer selected.' });
        var prop = _motionProp(ti, payload.component, payload.property);
        if (!prop) return JSON.stringify({ error: 'Property not found.' });
        var times = _motionKeyTimes(prop), rel = [], values = [];
        for (var i = 0; i < times.length; i++) {
            var time = motionMakeTime(ti, times[i]);
            if (!time) continue;
            var v = _motionReadAt(prop, time);
            if (v === null || v === undefined) continue;
            // ExtendScript arrays do not survive JSON.stringify on every build.
            if (v && v.length !== undefined && typeof v !== 'string') {
                var copy = [];
                for (var c = 0; c < v.length; c++) copy.push(Number(v[c]));
                v = copy;
            } else { v = Number(v); }
            rel.push(motionClipRelative(ti, times[i]));
            values.push(v);
        }
        if (rel.length < 2) return JSON.stringify({ error: 'This property needs at least two keyframes.' });
        return JSON.stringify({ ok: true, times: rel, values: values });
    } catch (e) {
        return JSON.stringify({ error: 'motionReadKeyValues: ' + e.message });
    }
}

// Payload: { clipIndex, component, property, from, to, step }
// Samples the property's INTERPOLATED value across a range. getValueAtKey only
// reports the values sitting on keyframes, so a bezier-eased segment read that
// way comes back as a straight line. Sampling getValueAtTime is the only way to
// capture the shape Premiere actually draws — which is what lets a looped
// segment keep its easing instead of flattening it.
function motionSampleValues(payloadJSON) {
    var payload;
    try { payload = JSON.parse(payloadJSON); } catch (e) { return JSON.stringify({ error: 'Bad motion payload.' }); }
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (e2) {}
        var ti = sel[payload.clipIndex];
        if (!ti) return JSON.stringify({ error: 'Clip is no longer selected.' });
        var prop = _motionProp(ti, payload.component, payload.property);
        if (!prop) return JSON.stringify({ error: 'Property not found.' });
        var from = Number(payload.from) || 0, to = Number(payload.to) || 0;
        var step = Number(payload.step);
        if (!(step > 0)) step = 1 / 30;
        if (!(to > from)) return JSON.stringify({ error: 'Empty sample range.' });
        var count = Math.floor((to - from) / step);
        if (count > 2000) { count = 2000; step = (to - from) / count; }
        var times = [], values = [];
        for (var i = 0; i <= count; i++) {
            var rel = (i === count) ? to : (from + step * i);
            var time = motionSourceTime(ti, rel);
            if (!time) continue;
            var v = null;
            try { v = prop.getValueAtTime(time); } catch (e3) {}
            if (v === null || v === undefined) continue;
            if (v && v.length !== undefined && typeof v !== 'string') {
                var copy = [];
                for (var c = 0; c < v.length; c++) copy.push(Number(v[c]));
                v = copy;
            } else { v = Number(v); }
            times.push(rel);
            values.push(v);
        }
        if (times.length < 2) return JSON.stringify({ error: 'This property could not be sampled.' });
        return JSON.stringify({ ok: true, times: times, values: values });
    } catch (e) {
        return JSON.stringify({ error: 'motionSampleValues: ' + e.message });
    }
}

// Payload: { entries: [{ clipIndex, component, property, replaceFrom,
//   replaceTo, keys: [{t, v}] }], undoLabel }
// `t` is clip-relative seconds; `v` is whatever the property takes (number, or
// an array for multi-component params). The span [replaceFrom, replaceTo] is
// cleared first so re-applying a curve does not stack keys.
function motionBakeKeys(payloadJSON) {
    var payload;
    try { payload = JSON.parse(payloadJSON); } catch (e) { return JSON.stringify({ error: 'Bad motion payload.' }); }
    var entries = (payload && payload.entries) || [];
    if (!entries.length) return JSON.stringify({ error: 'Nothing to apply.' });
    var undoOpen = false;
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (e2) {}
        var written = 0, touched = 0, errors = [];
        try { app.beginUndoGroup(String((payload && payload.undoLabel) || 'Orbit - Motion Lab')); undoOpen = true; } catch (e3) {}
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var ti = sel[entry.clipIndex];
            if (!ti) { errors.push('Clip ' + (entry.clipIndex + 1) + ' is no longer selected.'); continue; }
            var prop = _motionProp(ti, entry.component, entry.property);
            if (!prop) { errors.push('Clip ' + (entry.clipIndex + 1) + ': property not found.'); continue; }
            try { prop.setTimeVarying(true); } catch (e4) {}
            if (typeof entry.replaceFrom === 'number' && typeof entry.replaceTo === 'number' && entry.replaceTo > entry.replaceFrom) {
                var a = motionSourceTime(ti, entry.replaceFrom), b = motionSourceTime(ti, entry.replaceTo);
                if (a && b) _motionRemoveRange(prop, a, b);
            }
            var keys = entry.keys || [], ok = 0;
            for (var k = 0; k < keys.length; k++) {
                var time = motionSourceTime(ti, Number(keys[k].t));
                if (!time) continue;
                if (_motionWriteAt(prop, time, keys[k].v)) ok++;
                // Linear between baked keys: the curve is carried by the values,
                // so any easing Premiere adds on top would double-apply it.
                try { prop.setInterpolationTypeAtKey(time, 0, true); } catch (e5) {}
            }
            if (ok) touched++;
            written += ok;
            if (!ok && keys.length) errors.push('Clip ' + (entry.clipIndex + 1) + ': Premiere rejected every keyframe write.');
        }
        if (undoOpen) { try { app.endUndoGroup(); } catch (e6) {} undoOpen = false; }
        if (!written) return JSON.stringify({ error: errors.length ? errors[0] : 'No keyframes were written.', errors: errors });
        return JSON.stringify({ ok: errors.length === 0, properties: touched, keys: written, errors: errors });
    } catch (e) {
        if (undoOpen) { try { app.endUndoGroup(); } catch (e7) {} }
        return JSON.stringify({ error: 'motionBakeKeys: ' + e.message });
    }
}

// Payload: { entries: [{clipIndex, component, property}], op, offset, from, to }
// op: 'shift' moves every key in [from,to] by `offset` seconds, 'swap'
// exchanges the first and last key values in the span, 'clear' removes them.
function motionEditKeys(payloadJSON) {
    var payload;
    try { payload = JSON.parse(payloadJSON); } catch (e) { return JSON.stringify({ error: 'Bad motion payload.' }); }
    var entries = (payload && payload.entries) || [], op = String(payload.op || '');
    if (!entries.length) return JSON.stringify({ error: 'Select a property with keyframes first.' });
    if (op !== 'shift' && op !== 'swap' && op !== 'clear') return JSON.stringify({ error: 'Unknown keyframe operation.' });
    var undoOpen = false;
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (e2) {}
        var changed = 0, errors = [];
        var labels = { shift: 'Orbit - Shift Keyframes', swap: 'Orbit - Swap Keyframes', clear: 'Orbit - Clear Keyframes' };
        try { app.beginUndoGroup(labels[op]); undoOpen = true; } catch (e3) {}
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i], ti = sel[entry.clipIndex];
            if (!ti) { errors.push('Clip ' + (entry.clipIndex + 1) + ' is no longer selected.'); continue; }
            var prop = _motionProp(ti, entry.component, entry.property);
            if (!prop) { errors.push('Clip ' + (entry.clipIndex + 1) + ': property not found.'); continue; }
            var times = _motionKeyTimes(prop);
            var lo = typeof payload.from === 'number' ? payload.from : -1e9;
            var hi = typeof payload.to === 'number' ? payload.to : 1e9;
            var span = [];
            for (var t = 0; t < times.length; t++) {
                var rel = motionClipRelative(ti, times[t]);
                if (rel >= lo - 1e-6 && rel <= hi + 1e-6) span.push(rel);
            }
            if (!span.length) { errors.push('Clip ' + (entry.clipIndex + 1) + ': no keyframes in range.'); continue; }

            if (op === 'clear') {
                var c0 = motionSourceTime(ti, span[0] - 1e-4), c1 = motionSourceTime(ti, span[span.length - 1] + 1e-4);
                if (c0 && c1 && _motionRemoveRange(prop, c0, c1)) changed++;
                continue;
            }
            if (op === 'swap') {
                if (span.length < 2) { errors.push('Clip ' + (entry.clipIndex + 1) + ': swap needs two keyframes.'); continue; }
                var ta = motionSourceTime(ti, span[0]), tb = motionSourceTime(ti, span[span.length - 1]);
                var va = _motionReadAt(prop, ta), vb = _motionReadAt(prop, tb);
                if (va === null || vb === null) { errors.push('Clip ' + (entry.clipIndex + 1) + ': could not read both keyframes.'); continue; }
                if (_motionWriteAt(prop, ta, vb) && _motionWriteAt(prop, tb, va)) changed++;
                continue;
            }
            // shift — read every value first, then rewrite at the offset and
            // drop the originals. Moving one key at a time can collide with a
            // key that has not moved yet.
            var offset = Number(payload.offset) || 0;
            if (!offset) { errors.push('Shift offset is zero.'); continue; }
            var values = [];
            for (var s = 0; s < span.length; s++) values.push(_motionReadAt(prop, motionSourceTime(ti, span[s])));
            var r0 = motionSourceTime(ti, span[0] - 1e-4), r1 = motionSourceTime(ti, span[span.length - 1] + 1e-4);
            if (r0 && r1) _motionRemoveRange(prop, r0, r1);
            var moved = 0;
            for (var w = 0; w < span.length; w++) {
                if (values[w] === null) continue;
                var nt = motionSourceTime(ti, span[w] + offset);
                if (nt && _motionWriteAt(prop, nt, values[w])) moved++;
            }
            if (moved) changed++; else errors.push('Clip ' + (entry.clipIndex + 1) + ': shift wrote nothing.');
        }
        if (undoOpen) { try { app.endUndoGroup(); } catch (e4) {} undoOpen = false; }
        if (!changed) return JSON.stringify({ error: errors.length ? errors[0] : 'Nothing changed.', errors: errors });
        return JSON.stringify({ ok: errors.length === 0, changed: changed, errors: errors });
    } catch (e) {
        if (undoOpen) { try { app.endUndoGroup(); } catch (e5) {} }
        return JSON.stringify({ error: 'motionEditKeys: ' + e.message });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// ── Beat Sync Engine — Premiere adapter ─────────────────────────────────
// The panel-side engine (modules/beat-engine.js + beat-panel.js) extracts
// the music track via FFmpeg, runs onset + autocorrelation tempo detection
// and sends beat times in seconds. These three actions apply them to the
// timeline — sequence markers, razor cuts at beats, or arranging clips
// onto the beat grid — each inside ONE undo group.
// ═══════════════════════════════════════════════════════════════════════

// timesJSON: JSON array of beat times in seconds.
function beatAddSequenceMarkers(timesJSON, label) {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var times = JSON.parse(timesJSON || '[]');
        if (!times || !times.length) return JSON.stringify({ error: 'No beat times to mark.' });
        var added = 0;
        try { app.beginUndoGroup('CompX Orbit - Beat Markers'); } catch (u) {}
        try {
            for (var i = 0; i < times.length; i++) {
                var t = Number(times[i]);
                if (!(t >= 0)) continue;
                try {
                    var marker = seq.markers.createMarker(t);
                    marker.name = label || 'Beat';
                    marker.comments = 'Beat ' + (i + 1);
                    try { if (marker.setColorByIndex) marker.setColorByIndex(2); } catch (mc) {}
                    added++;
                } catch (m) {}
            }
        } catch (inner) {
            try { app.endUndoGroup(); } catch (u2) {}
            return JSON.stringify({ error: inner.message, added: added });
        }
        try { app.endUndoGroup(); } catch (u3) {}
        return JSON.stringify({ ok: true, added: added });
    } catch (e) {
        return JSON.stringify({ error: 'beatAddSequenceMarkers: ' + e.message });
    }
}

// Razor every clip on every unlocked track at each beat time (non-ripple).
function beatCutClips(timesJSON) {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var times = JSON.parse(timesJSON || '[]');
        if (!times || !times.length) return JSON.stringify({ error: 'No beat times to cut.' });
        var fps = Math.round(254016000000 / parseInt(seq.timebase, 10));
        if (!(fps > 0)) fps = 30;
        var seqEnd = Infinity;
        try { seqEnd = Number(seq.end.seconds); } catch (x) {}
        if (!(seqEnd > 0)) seqEnd = Infinity;

        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) throw new Error('QE DOM could not get active sequence.');

        var added = 0;
        try { app.beginUndoGroup('CompX Orbit - Cut to Beat'); } catch (u) {}
        try {
            for (var i = 0; i < times.length; i++) {
                var t = Number(times[i]);
                if (!(t > 1 / fps)) continue;       // never cut at frame 0/1
                if (t >= seqEnd) continue;          // beyond sequence end
                try {
                    qeSeq.razor(secondsToTimecode(t, fps));
                    added++;
                } catch (r) {}
            }
        } catch (inner) {
            try { app.endUndoGroup(); } catch (u2) {}
            return JSON.stringify({ error: inner.message, cuts: added });
        }
        try { app.endUndoGroup(); } catch (u3) {}
        return JSON.stringify({ ok: true, cuts: added });
    } catch (e) {
        return JSON.stringify({ error: 'beatCutClips: ' + e.message });
    }
}

// Snap selected clips (or all clips when nothing is selected) to the
// nearest beat time. Clips keep their relative order.
function beatArrangeClips(timesJSON) {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var times = JSON.parse(timesJSON || '[]');
        if (!times || !times.length) return JSON.stringify({ error: 'No beat times to arrange to.' });

        var sel = [];
        try { sel = seq.getSelection(); } catch (se) {}

        var items = [];
        var v, a, c;
        if (sel && sel.length) {
            for (var i = 0; i < sel.length; i++) {
                var s0 = 0;
                try { s0 = Number(sel[i].start.seconds); } catch (x) {}
                if (isNaN(s0)) s0 = 0;
                items.push({ clip: sel[i], start: s0 });
            }
        } else {
            for (v = 0; v < seq.videoTracks.numTracks; v++) {
                var vt = seq.videoTracks[v];
                for (c = 0; c < vt.clips.numItems; c++) {
                    try { items.push({ clip: vt.clips[c], start: Number(vt.clips[c].start.seconds) || 0 }); } catch (x) {}
                }
            }
            for (a = 0; a < seq.audioTracks.numTracks; a++) {
                var at = seq.audioTracks[a];
                for (c = 0; c < at.clips.numItems; c++) {
                    try { items.push({ clip: at.clips[c], start: Number(at.clips[c].start.seconds) || 0 }); } catch (x) {}
                }
            }
        }
        if (!items.length) return JSON.stringify({ error: 'No clips to arrange.' });

        items.sort(function (x, y) { return x.start - y.start; });

        var moved = 0;
        try { app.beginUndoGroup('CompX Orbit - Arrange to Beat'); } catch (u) {}
        try {
            for (var k = 0; k < items.length; k++) {
                var target = beatNearestTime(times, items[k].start);
                try {
                    items[k].clip.move(beatShift(items[k].clip, target));
                    moved++;
                } catch (m1) {
                    try { items[k].clip.start.seconds = target; moved++; } catch (m2) {}
                }
            }
        } catch (inner) {
            try { app.endUndoGroup(); } catch (u2) {}
            return JSON.stringify({ error: inner.message, moved: moved });
        }
        try { app.endUndoGroup(); } catch (u3) {}
        return JSON.stringify({ ok: true, moved: moved });
    } catch (e) {
        return JSON.stringify({ error: 'beatArrangeClips: ' + e.message });
    }
}

function beatNearestTime(times, value) {
    var best = Number(times[0]);
    var bestD = Math.abs(best - value);
    for (var i = 1; i < times.length; i++) {
        var d = Math.abs(Number(times[i]) - value);
        if (d < bestD) { bestD = d; best = Number(times[i]); }
    }
    return best;
}

// TrackItem.move() takes a Time object = the amount to SHIFT the start by.
function beatShift(clip, targetSeconds) {
    var current = 0;
    try { current = Number(clip.start.seconds); } catch (x) {}
    if (isNaN(current)) current = 0;
    var t = clip.start;
    t.seconds = Number(targetSeconds) - current;
    return t;
}

// ═══════════════════════════════════════════════════════════════════════
// ── B-Roll Assistant — Premiere adapter ─────────────────────────────────
// The panel-side engine (modules/broll-engine.js + broll-panel.js) mines
// the Auto Captions transcript for keyword-driven shot suggestions. This
// pushes them onto the active sequence as colored markers (name = shot
// type, comment = keyword + score) in ONE undo group.
// ═══════════════════════════════════════════════════════════════════════

// listJSON: [{ time, name, comment, color }]
function brollAddMarkers(listJSON) {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var list = JSON.parse(listJSON || '[]');
        if (!list || !list.length) return JSON.stringify({ error: 'No b-roll suggestions to mark.' });
        var added = 0;
        try { app.beginUndoGroup('CompX Orbit - B-Roll Markers'); } catch (u) {}
        try {
            for (var i = 0; i < list.length; i++) {
                var it = list[i];
                var t = Number(it.time);
                if (!(t >= 0)) continue;
                try {
                    var marker = seq.markers.createMarker(t);
                    marker.name = it.name || 'B-Roll';
                    marker.comments = it.comment || '';
                    try { if (marker.setColorByIndex) marker.setColorByIndex(Number(it.color) || 0); } catch (mc) {}
                    added++;
                } catch (m) {}
            }
        } catch (inner) {
            try { app.endUndoGroup(); } catch (u2) {}
            return JSON.stringify({ error: inner.message, added: added });
        }
        try { app.endUndoGroup(); } catch (u3) {}
        return JSON.stringify({ ok: true, added: added });
    } catch (e) {
        return JSON.stringify({ error: 'brollAddMarkers: ' + e.message });
    }
}

// ---------- AI Voice Cleaner ----------

// Build the standard clip-info shape from a selected TrackItem.
//   { sourceFile, srcIn, srcOut, timelineStart, name, duration }
// The selected TrackItem may be a linked video+audio clip; we prefer the
// clip's own media path if it looks like audio, otherwise we scan audio
// tracks for a clip at the same timeline position.
function audioClipInfo(item, seq) {
    var startSec = 0, endSec = 0;
    try { startSec = Number(item.start.seconds); } catch (x) {}
    try { endSec = Number(item.end.seconds); } catch (x) {}
    if (isNaN(startSec)) startSec = 0;
    if (isNaN(endSec)) endSec = startSec;

    var srcIn = 0, srcOut = 0;
    try { srcIn = ticksToSeconds(item.inPoint.ticks); } catch (x) {}
    try { srcOut = ticksToSeconds(item.outPoint.ticks); } catch (x) {}
    if (!(srcOut > srcIn)) { srcIn = 0; srcOut = Math.max(0, endSec - startSec); }

    var sourceFile = '';
    try { sourceFile = item.projectItem ? item.projectItem.getMediaPath() : ''; } catch (x) {}
    var name = '';
    try { name = item.projectItem ? item.projectItem.name : ''; } catch (x) {}

    // No readable media path (e.g. an Adobe Stock / generated clip): scan
    // audio tracks for any clip overlapping this timeline position.
    if (!sourceFile && seq) {
        try {
            for (var t = 0; t < seq.audioTracks.numTracks; t++) {
                var tr = seq.audioTracks[t];
                for (var c = 0; c < tr.clips.numItems; c++) {
                    var cl = tr.clips[c];
                    var cs = 0, ce = 0;
                    try { cs = ticksToSeconds(cl.start.ticks); } catch (x) {}
                    try { ce = ticksToSeconds(cl.end.ticks); } catch (x) {}
                    if (startSec >= cs - 0.01 && startSec <= ce + 0.01 && cl.projectItem) {
                        try { sourceFile = cl.projectItem.getMediaPath(); } catch (x) {}
                        try { name = cl.projectItem.name; } catch (x) {}
                        try { srcIn = ticksToSeconds(cl.inPoint.ticks); } catch (x) {}
                        try { srcOut = ticksToSeconds(cl.outPoint.ticks); } catch (x) {}
                        startSec = cs;
                        endSec = ce;
                        break;
                    }
                }
                if (sourceFile) break;
            }
        } catch (scanErr) {}
    }

    if (!sourceFile) return null;
    return {
        sourceFile: sourceFile,
        srcIn: srcIn,
        srcOut: srcOut,
        timelineStart: startSec,
        name: name || sourceFile.replace(/^.*[\\\/]/, ''),
        duration: Math.max(0, endSec - startSec)
    };
}

// Returns the first audio-capable selected timeline item (single-clip flow).
function audioGetSelectedClip() {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (se) {}
        if (!sel || !sel.length) return JSON.stringify({ error: 'Select an audio clip first.' });
        var info = audioClipInfo(sel[0], seq);
        if (!info) return JSON.stringify({ error: 'Selected clip has no readable media file.' });
        return JSON.stringify(info);
    } catch (e) {
        return JSON.stringify({ error: 'audioGetSelectedClip: ' + e.message });
    }
}

// Returns EVERY audio-capable selected timeline item (batch flow). Skips
// non-audio / unreadable selections so one bad clip doesn't block the batch.
function audioGetSelectedClips() {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var sel = [];
        try { sel = seq.getSelection(); } catch (se) {}
        if (!sel || !sel.length) return JSON.stringify({ clips: [] });
        var clips = [];
        var seen = {};
        for (var i = 0; i < sel.length; i++) {
            var info = audioClipInfo(sel[i], seq);
            if (!info) continue;
            // De-dupe identical source ranges (linked video+audio items can
            // surface twice through the fallback scan).
            var key = info.sourceFile + '|' + info.srcIn + '|' + info.timelineStart;
            if (seen[key]) continue;
            seen[key] = true;
            clips.push(info);
        }
        return JSON.stringify({ clips: clips });
    } catch (e) {
        return JSON.stringify({ error: 'audioGetSelectedClips: ' + e.message });
    }
}

// Imports the cleaned WAV and places it at the same timeline position as the
// original. Modes: 'new' (new track), 'replace' (new track + mute original),
// 'file' (import only, no timeline insert). All in one undo group.
// Payload: { cleanPath, timelineStart, mode, muteOriginal, originalStart }
function audioImportAndInsert(payloadJSON) {
    var p;
    try { p = JSON.parse(payloadJSON || '{}'); } catch (e) { return JSON.stringify({ error: 'Bad payload.' }); }
    var step = 'init';
    try {
        step = 'check-project';
        if (!app.project) return JSON.stringify({ error: 'No open project.' });
        var cleanPath = p.cleanPath;
        if (!cleanPath) return JSON.stringify({ error: 'Missing cleaned audio path.' });

        step = 'import';
        try {
            app.project.importFiles([cleanPath], true,
                app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem,
                false);
        } catch (importErr) { /* already imported — fine */ }

        step = 'find-item';
        var fileName = cleanPath.replace(/^.*[\\\/]/, '');
        var item = findProjectItemByName(app.project.rootItem, fileName);
        if (!item) return JSON.stringify({ error: 'Import failed: "' + fileName + '" not found in project bin.' });

        var mode = p.mode || 'new';
        var inserted = false;
        if (mode !== 'file') {
            step = 'get-sequence';
            var seq = getActiveSequence();
            if (!seq) return JSON.stringify({ error: 'Imported to project, but no active sequence to insert into.', imported: true });

            step = 'find-track';
            var timelineStart = Number(p.timelineStart) || 0;
            var duration = getItemDurationSec(item);
            var track = findFreeAudioTrack(seq, timelineStart, timelineStart + duration);
            if (!track) track = tryAddAudioTrack(seq);
            if (!track) return JSON.stringify({ error: 'No free audio track at that position.', imported: true });

            step = 'insert-clip';
            var playhead = { seconds: timelineStart, ticks: secondsToTicks(timelineStart) };
            inserted = tryInsertClip(track, item, playhead);
            if (!inserted) return JSON.stringify({ error: 'insertClip failed after import.', imported: true });
        }

        var muted = false;
        if (p.muteOriginal && mode === 'replace') {
            step = 'mute-original';
            muted = audioMuteClipAt(Number(p.originalStart) >= 0 ? Number(p.originalStart) : Number(p.timelineStart));
        }

        return JSON.stringify({ ok: true, imported: true, inserted: inserted, muted: muted, name: fileName });
    } catch (e) {
        return JSON.stringify({ error: 'audioImportAndInsert failed at step "' + step + '": ' + e.message });
    }
}

// Mute the audio clip on the timeline at the given position (first match).
// Optional `sourceFile` narrows the match (batch: several clips can share a
// timeline position on different tracks).
function audioMuteClipAt(timeSec, sourceFile) {
    var wantBase = '';
    try { wantBase = sourceFile ? sourceFile.replace(/^.*[\\\/]/, '').toLowerCase() : ''; } catch (x) {}
    try {
        var seq = getActiveSequence();
        if (!seq) return false;
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var tr = seq.audioTracks[t];
            for (var c = 0; c < tr.clips.numItems; c++) {
                var cl = tr.clips[c];
                var cs = 0, ce = 0;
                try { cs = ticksToSeconds(cl.start.ticks); } catch (x) {}
                try { ce = ticksToSeconds(cl.end.ticks); } catch (x) {}
                if (timeSec >= cs - 0.05 && timeSec <= ce + 0.05) {
                    if (wantBase && cl.projectItem) {
                        try {
                            var mp = cl.projectItem.getMediaPath();
                            var base = mp ? mp.replace(/^.*[\\\/]/, '').toLowerCase() : '';
                            if (base && base !== wantBase) continue;
                        } catch (mpErr) {}
                    }
                    try { cl.muted = true; return true; } catch (m1) {
                        try { pproApplyTrackItemVolume(cl, 0); return true; } catch (m2) { return false; }
                    }
                }
            }
        }
    } catch (e) { return false; }
    return false;
}

// Batch import + insert: every cleaned WAV goes onto its OWN audio track at
// the original clip's timeline position, all in ONE undo group.
// Payload: {
//   items: [{ cleanPath, timelineStart, sourceFile }],
//   mode: 'new' | 'replace' | 'file',
//   muteOriginal: bool
// }
function audioImportAndInsertBatch(payloadJSON) {
    var p;
    try { p = JSON.parse(payloadJSON || '{}'); } catch (e) { return JSON.stringify({ error: 'Bad payload.' }); }
    var step = 'init';
    try {
        step = 'check-project';
        if (!app.project) return JSON.stringify({ error: 'No open project.' });
        var items = p.items || [];
        if (!items.length) return JSON.stringify({ error: 'No cleaned audio to import.' });
        var mode = p.mode || 'new';

        var seq = null;
        if (mode !== 'file') {
            seq = getActiveSequence();
            if (!seq) return JSON.stringify({ error: 'No active sequence to insert into.' });
        }

        var imported = 0, inserted = 0, muted = 0, errors = [];
        try { app.beginUndoGroup('CompX Orbit - Enhance Voice (batch)'); } catch (u) {}
        try {
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                step = 'import-' + i;
                var cleanPath = it.cleanPath;
                if (!cleanPath) { errors.push('Item ' + (i + 1) + ': missing path.'); continue; }
                try {
                    app.project.importFiles([cleanPath], true,
                        app.project.getInsertionBin ? app.project.getInsertionBin() : app.project.rootItem,
                        false);
                } catch (importErr) { /* already imported — fine */ }

                var fileName = cleanPath.replace(/^.*[\\\/]/, '');
                var item = findProjectItemByName(app.project.rootItem, fileName);
                if (!item) { errors.push('Item ' + (i + 1) + ': import failed (' + fileName + ').'); continue; }
                imported++;

                if (mode !== 'file') {
                    // Own track per clip — add a fresh audio track so no two
                    // cleaned clips ever collide (the batch contract).
                    step = 'track-' + i;
                    var track = tryAddAudioTrack(seq);
                    if (!track) { errors.push('Item ' + (i + 1) + ': could not add an audio track.'); continue; }

                    step = 'insert-' + i;
                    var timelineStart = Number(it.timelineStart) || 0;
                    var playhead = { seconds: timelineStart, ticks: secondsToTicks(timelineStart) };
                    if (tryInsertClip(track, item, playhead)) inserted++;
                    else { errors.push('Item ' + (i + 1) + ': insertClip failed after import.'); continue; }

                    if (p.muteOriginal && mode === 'replace') {
                        if (audioMuteClipAt(timelineStart, it.sourceFile)) muted++;
                    }
                }
            }
        } catch (inner) {
            try { app.endUndoGroup(); } catch (u2) {}
            return JSON.stringify({ error: inner.message, imported: imported, inserted: inserted, muted: muted, errors: errors });
        }
        try { app.endUndoGroup(); } catch (u3) {}
        return JSON.stringify({ ok: true, imported: imported, inserted: inserted, muted: muted, errors: errors });
    } catch (e) {
        return JSON.stringify({ error: 'audioImportAndInsertBatch failed at step "' + step + '": ' + e.message });
    }
}

// Playhead position of the active sequence, for manual punch/marker placement.
function getPlayheadTime() {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var pos = seq.getPlayerPosition();
        var sec = 0;
        try { sec = Number(pos.seconds); } catch (x) {}
        if (isNaN(sec)) sec = 0;
        return JSON.stringify({ time: sec });
    } catch (e) {
        return JSON.stringify({ error: 'getPlayheadTime: ' + e.message });
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Orbit Timeline Tools — transitions, timing and exposed MOGRT controls.
// Implemented independently; all mutations operate on the current selection.
// ════════════════════════════════════════════════════════════════════════════

function _composerFps(seq) {
    var fps = 30;
    try { fps = Math.round(254016000000 / parseInt(seq.timebase, 10)); } catch (_) {}
    return fps > 0 ? fps : 30;
}

function _composerSelected() {
    var seq = getActiveSequence();
    if (!seq) return { seq: null, items: [] };
    var items = [];
    try { items = seq.getSelection(); } catch (_) {}
    return { seq: seq, items: items || [] };
}

function _composerMgtComponent(clip) {
    try { if (clip && clip.getMGTComponent) return clip.getMGTComponent(); } catch (_) {}
    return null;
}

function _composerProperties(component) {
    if (!component) return null;
    try { return component.properties || component.parameters || null; } catch (_) { return null; }
}

function _composerPropertyAt(clip, index) {
    var component = _composerMgtComponent(clip);
    var props = _composerProperties(component);
    var count = props ? (props.numItems || props.length || 0) : 0;
    return index >= 0 && index < count ? props[index] : null;
}

function composerInspectSelection() {
    try {
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'No active sequence.' });
        var items = selected.items;
        var result = { count: items.length, videoCount: 0, audioCount: 0, fps: _composerFps(selected.seq), issues: [], mogrt: { available: false, name: '', params: [] } };
        for (var i = 0; i < items.length; i++) {
            var clip = items[i];
            var mediaType = '';
            try { mediaType = String(clip.mediaType || ''); } catch (_) {}
            if (/audio/i.test(mediaType)) result.audioCount++; else result.videoCount++;
            try { if (Number(clip.end.seconds) <= Number(clip.start.seconds)) result.issues.push('Clip ' + (i + 1) + ' has zero duration.'); } catch (_) {}
            try { if (!clip.projectItem) result.issues.push('Clip ' + (i + 1) + ' has no project item.'); } catch (_) {}
            try { if (clip.projectItem && clip.projectItem.isOffline && clip.projectItem.isOffline()) result.issues.push('Clip ' + (i + 1) + ' is offline.'); } catch (_) {}
        }
        if (items.length !== 1) return JSON.stringify(result);

        var target = items[0];
        var component = _composerMgtComponent(target);
        var props = _composerProperties(component);
        if (!component || !props) return JSON.stringify(result);
        result.mogrt.available = true;
        try { result.mogrt.name = String(target.name || target.projectItem.name || 'Graphic'); } catch (_) { result.mogrt.name = 'Graphic'; }
        var count = props.numItems || props.length || 0;
        for (var p = 0; p < count; p++) {
            var prop = props[p];
            var item = { index: p, name: 'Control ' + (p + 1), kind: 'readonly', value: '', editable: false };
            try { item.name = String(prop.displayName || prop.name || item.name); } catch (_) {}
            var alternate = false;
            try { alternate = !!(prop.canSetAlternateSource && prop.canSetAlternateSource()); } catch (_) {}
            if (alternate) {
                item.kind = 'media'; item.editable = true; item.value = '';
                result.mogrt.params.push(item); continue;
            }
            var color = null;
            try { if (prop.getColorValue) color = prop.getColorValue(); } catch (_) {}
            if (color && color.length >= 4) {
                item.kind = 'color'; item.value = [Number(color[0]), Number(color[1]), Number(color[2]), Number(color[3])]; item.editable = true;
                result.mogrt.params.push(item); continue;
            }
            var value;
            try { value = prop.getValue(); } catch (_) { value = undefined; }
            if (typeof value === 'number') { item.kind = 'number'; item.value = value; item.editable = true; }
            else if (typeof value === 'boolean') { item.kind = 'boolean'; item.value = value; item.editable = true; }
            else if (typeof value === 'string' && value.length <= 2000 && value.charAt(0) !== '{') { item.kind = 'string'; item.value = value; item.editable = true; }
            else {
                item.kind = 'readonly';
                try { item.value = typeof value === 'string' ? value.substr(0, 160) : String(value); } catch (_) { item.value = 'Unsupported value'; }
            }
            result.mogrt.params.push(item);
        }
        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({ error: 'composerInspectSelection: ' + e.message });
    }
}

function _composerQeSeconds(timeObj) {
    try { if (timeObj.secs !== undefined) return Number(timeObj.secs); } catch (_) {}
    try { if (timeObj.seconds !== undefined) return Number(timeObj.seconds); } catch (_) {}
    try { if (timeObj.ticks !== undefined) return Number(timeObj.ticks) / 254016000000; } catch (_) {}
    return NaN;
}

function _composerFindQeClip(stdClip, qeSeq) {
    var targetStart = NaN, targetEnd = NaN, targetName = '';
    try { targetStart = Number(stdClip.start.seconds); } catch (_) {}
    try { targetEnd = Number(stdClip.end.seconds); } catch (_) {}
    try { targetName = String(stdClip.name || ''); } catch (_) {}
    var trackCount = 0;
    try { trackCount = qeSeq.numVideoTracks; } catch (_) {}
    for (var ti = 0; ti < trackCount; ti++) {
        var track = null, count = 0;
        try { track = qeSeq.getVideoTrackAt(ti); count = track.numItems || 0; } catch (_) { continue; }
        for (var ci = 0; ci < count; ci++) {
            var candidate = null;
            try { candidate = track.getItemAt(ci); } catch (_) { continue; }
            if (!candidate || !candidate.addTransition) continue;
            var cs = _composerQeSeconds(candidate.start), ce = _composerQeSeconds(candidate.end), cn = '';
            try { cn = String(candidate.name || ''); } catch (_) {}
            if (!isNaN(cs) && !isNaN(targetStart) && Math.abs(cs - targetStart) < 0.06) {
                if (isNaN(ce) || isNaN(targetEnd) || Math.abs(ce - targetEnd) < 0.12 || !targetName || !cn || cn === targetName) return candidate;
            }
        }
    }
    return null;
}

function _composerTimecodeFrames(frames, fps) {
    frames = Math.max(1, Math.round(Number(frames) || 1)); fps = Math.max(1, Math.round(Number(fps) || 30));
    var ff = frames % fps, totalSeconds = Math.floor(frames / fps), ss = totalSeconds % 60, mm = Math.floor(totalSeconds / 60) % 60, hh = Math.floor(totalSeconds / 3600);
    function pad(v) { return (v < 10 ? '0' : '') + v; }
    return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);
}

function _composerTransitionByName(name) {
    var tx = null;
    try { tx = qe.project.getVideoTransitionByName(name, false); } catch (_) {}
    if (!tx) try { tx = qe.project.getVideoTransitionByName(name, true); } catch (_) {}
    if (!tx) {
        var aliases = {
            'Cross Dissolve': ['AE.AECrossDissolve', 'AE.AE_CrossDissolve'],
            'Film Dissolve': ['AE.AEFilmDissolve'],
            'Dip To Black': ['AE.AEDipToBlack'],
            'Dip To White': ['AE.AEDipToWhite'],
            'Morph Cut': ['AE.AEMorphCut']
        };
        var list = aliases[name] || [];
        for (var i = 0; i < list.length && !tx; i++) {
            try { tx = qe.project.getVideoTransitionByName(list[i], true); } catch (_) {}
        }
    }
    return tx;
}

function composerApplyTransitions(name, side, durationFrames, replaceExisting, removeOnly) {
    try {
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'No active sequence.' });
        if (!selected.items.length) return JSON.stringify({ error: 'Select one or more video clips.' });
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return JSON.stringify({ error: 'QE could not access the active sequence.' });
        var tx = removeOnly ? null : _composerTransitionByName(String(name || ''));
        if (!removeOnly && !tx) return JSON.stringify({ error: 'Transition not found: ' + name });
        var fps = _composerFps(selected.seq), duration = _composerTimecodeFrames(durationFrames, fps);
        var doIn = side === 'in' || side === 'both', doOut = side === 'out' || side === 'both';
        var changed = 0, skipped = 0, errors = [];
        try { app.beginUndoGroup(removeOnly ? 'Orbit - Remove Transitions' : 'Orbit - Apply Transitions'); } catch (_) {}
        for (var i = 0; i < selected.items.length; i++) {
            var stdClip = selected.items[i], qeClip = _composerFindQeClip(stdClip, qeSeq);
            if (!qeClip) { skipped++; continue; }
            if (doIn) {
                try { if (removeOnly || replaceExisting) qeClip.addTransition(null, true, '00:00:00:00'); if (!removeOnly) qeClip.addTransition(tx, true, duration); changed++; } catch (ein) { errors.push('Clip ' + (i + 1) + ' in: ' + ein.message); }
            }
            if (doOut) {
                try { if (removeOnly || replaceExisting) qeClip.addTransition(null, false, '00:00:00:00'); if (!removeOnly) qeClip.addTransition(tx, false, duration); changed++; } catch (eout) { errors.push('Clip ' + (i + 1) + ' out: ' + eout.message); }
            }
        }
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ ok: errors.length === 0, changed: changed, skipped: skipped, errors: errors });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'composerApplyTransitions: ' + e.message });
    }
}

function composerMoveSelection(mode, frames) {
    try {
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'No active sequence.' });
        if (!selected.items.length) return JSON.stringify({ error: 'Select one or more clips.' });
        var fps = _composerFps(selected.seq), delta = Number(frames || 0) / fps, minStart = 1e20, maxEnd = -1e20;
        for (var i = 0; i < selected.items.length; i++) {
            try { minStart = Math.min(minStart, Number(selected.items[i].start.seconds)); maxEnd = Math.max(maxEnd, Number(selected.items[i].end.seconds)); } catch (_) {}
        }
        var playhead = 0;
        try { playhead = Number(selected.seq.getPlayerPosition().seconds); } catch (_) {}
        if (mode === 'align-start') delta = playhead - minStart;
        else if (mode === 'align-end') delta = playhead - maxEnd;
        if (minStart + delta < 0) delta = -minStart;
        var moved = 0, errors = [];
        try { app.beginUndoGroup('Orbit - Move Selection'); } catch (_) {}
        for (var j = 0; j < selected.items.length; j++) {
            try { var offset = new Time(); offset.seconds = delta; selected.items[j].move(offset); moved++; } catch (moveError) { errors.push('Clip ' + (j + 1) + ': ' + moveError.message); }
        }
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ ok: errors.length === 0, moved: moved, delta: delta, errors: errors });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'composerMoveSelection: ' + e.message });
    }
}

function _composerTimelineSeconds(timeValue) {
    try { return Number(timeValue.seconds); } catch (_) {}
    try { return parseInt(timeValue.ticks, 10) / 254016000000; } catch (_) {}
    return NaN;
}
function _composerTimelineTime(seconds) {
    var t = new Time();
    try { t.seconds = seconds; } catch (_) { try { t.ticks = secondsToTicks(seconds); } catch (_2) {} }
    return t;
}
function _composerTimelineSelected(clip, selected) {
    for (var i = 0; i < selected.length; i++) {
        try { if (selected[i] === clip) return true; } catch (_) {}
    }
    try { return !!(clip.isSelected && clip.isSelected()); } catch (_) {}
    return false;
}
function _composerTimelineBounds(clip) {
    return { start: _composerTimelineSeconds(clip.start), end: _composerTimelineSeconds(clip.end) };
}
// Premiere ignores a write to a read-only TrackItem boundary WITHOUT throwing,
// so each route has to be checked by reading the value back. Returning on the
// first assignment that merely did not throw left routes 2 and 3 permanently
// unreachable, which is why direct-edge trimming looked broken on builds where
// route 1 is a silent no-op.
function _composerSetTimelineBoundary(clip, edge, seconds) {
    var original = _composerTimelineSeconds(clip[edge]);
    function landed() {
        var actual = _composerTimelineSeconds(clip[edge]);
        return !isNaN(actual) && Math.abs(actual - seconds) <= 0.0001;
    }
    try { clip[edge] = _composerTimelineTime(seconds); if (landed()) return true; } catch (_) {}
    try { clip[edge].seconds = seconds; if (landed()) return true; } catch (_2) {}
    try { clip[edge].ticks = secondsToTicks(seconds); if (landed()) return true; } catch (_3) {}
    // A clamped trim — Premiere limiting the edge to the available source media
    // — still counts as a write. The caller compares against the playhead and
    // reports the shortfall, which is a more useful message than "read-only".
    var moved = _composerTimelineSeconds(clip[edge]);
    return !isNaN(moved) && (isNaN(original) || Math.abs(moved - original) > 0.0001);
}
function _composerTimelineTrackGroups(seq, selected, playhead) {
    var result = { video: [], audio: [], targetCount: 0, unsafe: [] };
    var epsilon = 0.00001;
    function scan(tracks, type, output) {
        var count = 0;
        try { count = tracks.numTracks; } catch (_) {}
        for (var ti = 0; ti < count; ti++) {
            var track = tracks[ti], group = { index: ti, items: [], unsafe: false };
            var clipCount = 0;
            try { clipCount = track.clips.numItems; } catch (_) {}
            for (var ci = 0; ci < clipCount; ci++) {
                var clip = track.clips[ci], bounds = _composerTimelineBounds(clip);
                if (!(bounds.start < playhead - epsilon && bounds.end > playhead + epsilon)) continue;
                if (_composerTimelineSelected(clip, selected)) { group.items.push(clip); result.targetCount++; }
                else group.unsafe = true;
            }
            if (group.items.length) {
                output.push(group);
                if (group.unsafe) result.unsafe.push((type === 'video' ? 'V' : 'A') + (ti + 1));
            }
        }
    }
    scan(seq.videoTracks, 'video', result.video);
    scan(seq.audioTracks, 'audio', result.audio);
    return result;
}
function _composerTimelineTrackItemTotal(seq, groups) {
    var total = 0, i, track;
    for (i = 0; i < groups.video.length; i++) {
        try { track = seq.videoTracks[groups.video[i].index]; total += track.clips.numItems; } catch (_) {}
    }
    for (i = 0; i < groups.audio.length; i++) {
        try { track = seq.audioTracks[groups.audio[i].index]; total += track.clips.numItems; } catch (_) {}
    }
    return total;
}
function _composerTimelineSelectedGroups(seq, selected) {
    var result = { video: [], audio: [], found: 0 };
    function scan(tracks, output) {
        var count = 0;
        try { count = tracks.numTracks; } catch (_) {}
        for (var ti = 0; ti < count; ti++) {
            var track = tracks[ti], group = { index: ti, items: [] }, clipCount = 0;
            try { clipCount = track.clips.numItems; } catch (_) {}
            for (var ci = 0; ci < clipCount; ci++) {
                var clip = track.clips[ci];
                if (_composerTimelineSelected(clip, selected)) { group.items.push(clip); result.found++; }
            }
            if (group.items.length) output.push(group);
        }
    }
    scan(seq.videoTracks, result.video);
    scan(seq.audioTracks, result.audio);
    return result;
}
function _composerTimelineLockNonTargetTracks(qeSeq, seq, groups) {
    var allowedVideo = {}, allowedAudio = {}, state = { video: [], audio: [] }, v, a, qv, qa;
    for (v = 0; v < groups.video.length; v++) allowedVideo[groups.video[v].index] = true;
    for (a = 0; a < groups.audio.length; a++) allowedAudio[groups.audio[a].index] = true;
    var videoCount = 0, audioCount = 0;
    try { videoCount = seq.videoTracks.numTracks; } catch (_) {}
    try { audioCount = seq.audioTracks.numTracks; } catch (_) {}
    for (v = 0; v < videoCount; v++) {
        qv = qeSeq.getVideoTrackAt(v);
        var vLocked = false;
        try { vLocked = !!qv.isLocked(); } catch (_) {}
        state.video[v] = vLocked;
        if (allowedVideo[v] && vLocked) return { error: 'Unlock V' + (v + 1) + ' before cutting.' };
    }
    for (a = 0; a < audioCount; a++) {
        qa = qeSeq.getAudioTrackAt(a);
        var aLocked = false;
        try { aLocked = !!qa.isLocked(); } catch (_) {}
        state.audio[a] = aLocked;
        if (allowedAudio[a] && aLocked) return { error: 'Unlock A' + (a + 1) + ' before cutting.' };
    }
    for (v = 0; v < videoCount; v++) {
        qv = qeSeq.getVideoTrackAt(v);
        try { if (qv && !allowedVideo[v]) qv.setLock(true); } catch (_) {}
    }
    for (a = 0; a < audioCount; a++) {
        qa = qeSeq.getAudioTrackAt(a);
        try { if (qa && !allowedAudio[a]) qa.setLock(true); } catch (_) {}
    }
    return state;
}
function _composerTimelineRestoreTrackLocks(qeSeq, state) {
    if (!state || state.error) return;
    for (var v = 0; v < state.video.length; v++) {
        try { var qv = qeSeq.getVideoTrackAt(v); if (qv) qv.setLock(state.video[v]); } catch (_) {}
    }
    for (var a = 0; a < state.audio.length; a++) {
        try { var qa = qeSeq.getAudioTrackAt(a); if (qa) qa.setLock(state.audio[a]); } catch (_) {}
    }
}
// ── Playhead actions ────────────────────────────────────────────────────────
// Cut and trim go through QE's PER-TRACK razor followed by a plain remove.
// That ordering matters twice over: Premiere silently ignores writes to a
// TrackItem's start/end on many builds, and a per-track razor cannot disturb
// tracks the user did not select, so no track-locking dance is needed. The
// sequence-wide razor (which cuts every unlocked track) is kept only as a
// fallback for builds that do not expose QETrack.razor, and there the locks
// still have to be taken and restored. With no QE at all, trim falls back to a
// read-back-verified boundary write; a cut is refused rather than faked.

function _composerExactFps(seq) {
    var fps = 0;
    try { fps = 254016000000 / parseInt(seq.timebase, 10); } catch (_) {}
    if (!isFinite(fps) || fps <= 0) fps = _composerFps(seq);
    return fps;
}

function _composerPlayheadSeconds(seq) {
    var seconds = NaN, position = null;
    try { position = seq.getPlayerPosition(); } catch (_) {}
    if (position) {
        // Ticks are exact; seconds is a rounded double on some builds.
        try { seconds = parseInt(position.ticks, 10) / 254016000000; } catch (_) {}
        if (isNaN(seconds)) { try { seconds = Number(position.seconds); } catch (_2) {} }
    }
    if (isNaN(seconds)) seconds = 0;
    var fps = _composerExactFps(seq);
    return Math.round(seconds * fps) / fps;
}

// Prefer QE's own CTI timecode: Premiere formats it for this sequence, so
// drop-frame timebases (29.97 / 59.94) stay correct. Our own arithmetic does
// not renumber dropped frames and drifts by a frame past the first minute.
function _composerPlayheadTimecode(qeSeq, seq, seconds) {
    var tc = '';
    try { if (qeSeq && qeSeq.CTI) tc = String(qeSeq.CTI.timecode || ''); } catch (_) {}
    if (tc) return tc;
    return secondsToTimecode(seconds, _composerFps(seq));
}

function _composerTrackAt(seq, kind, index) {
    try { return (kind === 'audio' ? seq.audioTracks : seq.videoTracks)[index] || null; } catch (_) { return null; }
}

function _composerQeTrackAt(qeSeq, kind, index) {
    if (!qeSeq) return null;
    try { return (kind === 'audio' ? qeSeq.getAudioTrackAt(index) : qeSeq.getVideoTrackAt(index)) || null; } catch (_) { return null; }
}

function _composerTrackLabel(kind, index) {
    return (kind === 'audio' ? 'A' : 'V') + (Number(index) + 1);
}

function _composerGroupList(groups) {
    var list = [], i;
    if (!groups) return list;
    for (i = 0; i < groups.video.length; i++) list.push({ kind: 'video', index: groups.video[i].index, items: groups.video[i].items });
    for (i = 0; i < groups.audio.length; i++) list.push({ kind: 'audio', index: groups.audio[i].index, items: groups.audio[i].items });
    return list;
}

function _composerLockedTargets(qeSeq, groups) {
    var list = _composerGroupList(groups), locked = [], i, qeTrack, isLocked;
    for (i = 0; i < list.length; i++) {
        qeTrack = _composerQeTrackAt(qeSeq, list[i].kind, list[i].index);
        isLocked = false;
        try { isLocked = !!(qeTrack && qeTrack.isLocked && qeTrack.isLocked()); } catch (_) {}
        if (isLocked) locked.push(_composerTrackLabel(list[i].kind, list[i].index));
    }
    return locked;
}

function _composerRazorTargetTracks(qeSeq, groups, timecode) {
    var list = _composerGroupList(groups), cuts = 0, i, qeTrack;
    for (i = 0; i < list.length; i++) {
        qeTrack = _composerQeTrackAt(qeSeq, list[i].kind, list[i].index);
        if (!qeTrack || !qeTrack.razor) continue;
        try { qeTrack.razor(timecode); cuts++; } catch (_) {}
    }
    return cuts;
}

// Razoring drops the timeline selection in Premiere. Re-select every clip that
// now sits inside a recorded range so the user's selection survives the edit
// and both halves of a cut stay highlighted.
function _composerReselectRanges(seq, records) {
    var tolerance = 0.0005, r, track, count, c, clip, bounds;
    if (!records) return;
    for (r = 0; r < records.length; r++) {
        track = _composerTrackAt(seq, records[r].kind, records[r].index);
        if (!track) continue;
        count = 0;
        try { count = track.clips.numItems; } catch (_) {}
        for (c = 0; c < count; c++) {
            clip = track.clips[c];
            bounds = _composerTimelineBounds(clip);
            if (isNaN(bounds.start) || isNaN(bounds.end)) continue;
            if (bounds.start >= records[r].start - tolerance && bounds.end <= records[r].end + tolerance) {
                try { if (clip.setSelected) clip.setSelected(true); } catch (_) {}
            }
        }
    }
}

function composerTimelineAction(action) {
    var undoOpen = false;
    function closeUndo() { if (undoOpen) { try { app.endUndoGroup(); } catch (_) {} undoOpen = false; } }
    try {
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'Open an active sequence first.' });
        if (!selected.items.length) return JSON.stringify({ error: 'Select one or more timeline clips first.' });
        var seq = selected.seq;
        var fps = _composerExactFps(seq);
        var frameTolerance = 1 / fps + 0.001;
        var playhead = _composerPlayheadSeconds(seq);
        var changed = 0, skipped = 0, errors = [], i, j;

        var qeSeq = null;
        try { app.enableQE(); } catch (_) {}
        try { qeSeq = qe.project.getActiveSequence(); } catch (_) {}

        // Find the clip on a track whose bounds match a range, so a piece can be
        // located again after the razor renumbered the track's clip list.
        function clipInRange(kind, index, start, end) {
            var track = _composerTrackAt(seq, kind, index), count = 0, c, clip, bounds;
            if (!track) return null;
            try { count = track.clips.numItems; } catch (_) {}
            for (c = 0; c < count; c++) {
                clip = track.clips[c];
                bounds = _composerTimelineBounds(clip);
                if (Math.abs(bounds.start - start) <= 0.0005 && Math.abs(bounds.end - end) <= 0.0005) return clip;
            }
            return null;
        }

        function recordsFor(groups) {
            var list = _composerGroupList(groups), out = [], t, k, bounds;
            for (t = 0; t < list.length; t++) {
                for (k = 0; k < list[t].items.length; k++) {
                    bounds = _composerTimelineBounds(list[t].items[k]);
                    out.push({ kind: list[t].kind, index: list[t].index, start: bounds.start, end: bounds.end });
                }
            }
            return out;
        }

        function razorTargets(groups) {
            var locked = _composerLockedTargets(qeSeq, groups);
            if (locked.length) return { cuts: 0, error: 'Unlock ' + locked.join(', ') + ' before editing.' };
            var timecode = _composerPlayheadTimecode(qeSeq, seq, playhead);
            var cuts = _composerRazorTargetTracks(qeSeq, groups, timecode);
            if (cuts) return { cuts: cuts };
            if (!qeSeq.razor) return { cuts: 0 };
            // Sequence-wide razor: cut every unlocked track, so lock the rest first.
            var lockState = _composerTimelineLockNonTargetTracks(qeSeq, seq, groups);
            if (lockState.error) return { cuts: 0, error: lockState.error };
            var outcome = { cuts: 0 };
            try { qeSeq.razor(timecode); outcome.cuts = 1; }
            catch (razorError) { outcome.error = 'Premiere refused the cut: ' + razorError.message; }
            _composerTimelineRestoreTrackLocks(qeSeq, lockState);
            return outcome;
        }

        if (action === 'trim-before' || action === 'trim-after') {
            var trimGroups = _composerTimelineTrackGroups(seq, selected.items, playhead);
            if (!trimGroups.targetCount) return JSON.stringify({ error: 'Place the playhead inside a selected clip.' });
            if (trimGroups.unsafe.length) return JSON.stringify({ error: 'Cannot safely trim: unselected clips also cross the playhead on ' + trimGroups.unsafe.join(', ') + '. Select them too or move the playhead.' });
            var trimRecords = recordsFor(trimGroups);
            try { app.beginUndoGroup(action === 'trim-before' ? 'Orbit - Trim Before Playhead' : 'Orbit - Trim After Playhead'); undoOpen = true; } catch (_) {}
            var trimRazor = { cuts: 0 };
            if (qeSeq) {
                trimRazor = razorTargets(trimGroups);
                if (trimRazor.error) { closeUndo(); return JSON.stringify({ error: trimRazor.error }); }
            }
            for (i = 0; i < trimRecords.length; i++) {
                var rec = trimRecords[i], label = _composerTrackLabel(rec.kind, rec.index), handled = false;
                var dropStart = action === 'trim-before' ? rec.start : playhead;
                var dropEnd = action === 'trim-before' ? playhead : rec.end;
                if (trimRazor.cuts) {
                    var piece = clipInRange(rec.kind, rec.index, dropStart, dropEnd);
                    if (piece) {
                        handled = true;
                        // Never ripple: trimming must not slide the rest of the track.
                        try { piece.remove(false, false); changed++; }
                        catch (removeError) { errors.push(label + ': ' + removeError.message); }
                    }
                }
                if (!handled) {
                    var clip = clipInRange(rec.kind, rec.index, rec.start, rec.end);
                    if (!clip) { skipped++; continue; }
                    var edge = action === 'trim-before' ? 'start' : 'end';
                    if (!_composerSetTimelineBoundary(clip, edge, playhead)) {
                        errors.push(label + ' could not be trimmed; Premiere is treating this clip edge as read-only.');
                        continue;
                    }
                    var actual = _composerTimelineSeconds(clip[edge]);
                    if (isNaN(actual) || Math.abs(actual - playhead) > frameTolerance) errors.push(label + ' did not reach the playhead; the clip may be out of source media.');
                    else changed++;
                }
            }
            _composerReselectRanges(seq, trimRecords);
            closeUndo();
            if (!changed) return JSON.stringify({ error: errors.length ? errors.join(' ') : 'Place the playhead inside a selected clip.', changed: 0, skipped: skipped, errors: errors });
            return JSON.stringify({ ok: errors.length === 0, changed: changed, skipped: skipped, errors: errors, razored: trimRazor.cuts, message: (action === 'trim-before' ? 'Trimmed before playhead: ' : 'Trimmed after playhead: ') + changed + ' clip' + (changed === 1 ? '.' : 's.') });
        }

        if (action === 'cut-at-playhead') {
            var cutGroups = _composerTimelineTrackGroups(seq, selected.items, playhead);
            if (!cutGroups.targetCount) return JSON.stringify({ error: 'Place the playhead inside a selected clip.' });
            if (cutGroups.unsafe.length) return JSON.stringify({ error: 'Cannot safely cut: unselected clips also cross the playhead on ' + cutGroups.unsafe.join(', ') + '. Select them too or move the playhead.' });
            if (!qeSeq) return JSON.stringify({ error: 'Premiere timeline scripting (QE) is unavailable, so the cut was not attempted. Use Add Edit (Ctrl+K) for now.' });
            var cutRecords = recordsFor(cutGroups);
            var before = _composerTimelineTrackItemTotal(seq, cutGroups);
            try { app.beginUndoGroup('Orbit - Cut at Playhead'); undoOpen = true; } catch (_) {}
            var cutRazor = razorTargets(cutGroups);
            if (cutRazor.error) { closeUndo(); return JSON.stringify({ error: cutRazor.error }); }
            changed = _composerTimelineTrackItemTotal(seq, cutGroups) - before;
            _composerReselectRanges(seq, cutRecords);
            closeUndo();
            if (changed <= 0) return JSON.stringify({ error: 'Premiere did not create a cut. The playhead may already be on an edit point.' });
            return JSON.stringify({ ok: true, changed: changed, razored: cutRazor.cuts, message: 'Cut ' + cutGroups.targetCount + ' selected clip' + (cutGroups.targetCount === 1 ? '' : 's') + ' at the playhead.' });
        }

        if (action === 'ripple-delete') {
            var deleteGroups = _composerTimelineSelectedGroups(seq, selected.items);
            var deleteList = _composerGroupList(deleteGroups);
            if (!deleteList.length) return JSON.stringify({ error: 'Select one or more timeline clips first.' });
            if (deleteGroups.found < selected.items.length) return JSON.stringify({ error: 'Could not map every selected clip to its timeline track. Refresh the timeline and try again.' });
            // Every target track must cover the same ranges, so a linked video +
            // audio pair ripples by the same amount and stays in sync. Several
            // clips on one track are fine; mismatched ranges across tracks are not.
            var signature = null;
            for (i = 0; i < deleteList.length; i++) {
                var ranges = [], rb;
                for (j = 0; j < deleteList[i].items.length; j++) {
                    rb = _composerTimelineBounds(deleteList[i].items[j]);
                    ranges.push(Math.round(rb.start * 1000) + ':' + Math.round(rb.end * 1000));
                }
                ranges.sort();
                if (signature === null) signature = ranges.join(',');
                else if (signature !== ranges.join(',')) return JSON.stringify({ error: 'For a safe ripple delete, every selected track must cover the same start and end times.' });
            }
            try { app.beginUndoGroup('Orbit - Ripple Delete'); undoOpen = true; } catch (_) {}
            for (i = deleteList.length - 1; i >= 0; i--) {
                var items = deleteList[i].items, order = [], trackLabel = _composerTrackLabel(deleteList[i].kind, deleteList[i].index);
                for (j = 0; j < items.length; j++) order.push({ clip: items[j], start: _composerTimelineBounds(items[j]).start });
                // Latest first: rippling an earlier clip would move the later ones.
                order.sort(function (a, b) { return b.start - a.start; });
                for (j = 0; j < order.length; j++) {
                    try { order[j].clip.remove(true, true); changed++; }
                    catch (deleteError) { errors.push(trackLabel + ': ' + deleteError.message); }
                }
            }
            closeUndo();
            if (!changed) return JSON.stringify({ error: errors.length ? errors.join(' ') : 'Nothing was removed.', errors: errors });
            return JSON.stringify({ ok: errors.length === 0, changed: changed, errors: errors, message: 'Ripple deleted ' + changed + ' selected clip' + (changed === 1 ? '.' : 's.') });
        }

        return JSON.stringify({ error: 'Unknown timeline action.' });
    } catch (e) {
        closeUndo();
        return JSON.stringify({ error: 'composerTimelineAction: ' + e.message });
    }
}
function _composerParseSize(text) {
    var pair = String(text || '').match(/(\d{2,5})\s*[xX]\s*(\d{2,5})/);
    if (!pair) return { width: 0, height: 0 };
    return { width: Number(pair[1]) || 0, height: Number(pair[2]) || 0 };
}

function _composerColumnSize(projectItem, columnName) {
    var text = '';
    try { if (projectItem && projectItem.getVideoInfo) text = String(projectItem.getVideoInfo() || ''); } catch (_) {}
    return _composerParseSize(text);
}

function _composerFrameSize(seq) {
    var w = 1920, h = 1080;
    try {
        var settings = seq && seq.getSettings ? seq.getSettings() : null;
        if (settings) {
            w = Number(settings.videoFrameWidth || settings.frameSizeHorizontal || w) || w;
            h = Number(settings.videoFrameHeight || settings.frameSizeVertical || h) || h;
        }
    } catch (_) {}
    try { w = Number(seq.frameSizeHorizontal || seq.videoFrameWidth || w) || w; } catch (_) {}
    try { h = Number(seq.frameSizeVertical || seq.videoFrameHeight || h) || h; } catch (_) {}
    return { width: w, height: h };
}

function _composerMotionPositionProperty(clip) {
    return _composerIntrinsicMotionProperty(clip, 'Position', 0);
}

// `Motion` is the public, intrinsic transform for a timeline TrackItem.
// Essential Graphics may also expose Vector Motion, but that internal
// component can accept a write without moving the selected timeline clip.
function _composerIntrinsicMotionProperty(clip, name, fallbackIndex) {
    try {
        var motion = _findMotionComp(clip);
        return _findMotionProp(motion, name, fallbackIndex);
    } catch (_) {}
    return null;
}

function _composerMotionNamedProperty(clip, matcher, fallbackIndex) {
    try {
        var components = clip && clip.components, count = components ? (components.numItems || components.length || 0) : 0;
        for (var c = 0; c < count; c++) {
            var component = components[c], isMotion = false, componentNames = [];
            try { componentNames.push(component.displayName, component.name, component.matchName); } catch (_) {}
            for (var cn = 0; cn < componentNames.length; cn++) if (/motion/i.test(String(componentNames[cn] || ''))) { isMotion = true; break; }
            if (!isMotion) continue;
            var props = component.properties || component.parameters || null, pCount = props ? (props.numItems || props.length || 0) : 0;
            for (var p = 0; p < pCount; p++) {
                var prop = props[p], propNames = [];
                try { propNames.push(prop.displayName, prop.name, prop.matchName); } catch (_) {}
                for (var pn = 0; pn < propNames.length; pn++) {
                    matcher.lastIndex = 0;
                    if (matcher.test(String(propNames[pn] || ''))) return prop;
                }
            }
            if (fallbackIndex !== undefined && fallbackIndex !== null && fallbackIndex >= 0 && fallbackIndex < pCount) return props[fallbackIndex];
        }
    } catch (_) {}
    return null;
}

function _composerSourceSize(clip, frame, anchorValue) {
    var result = { width: 0, height: 0 }, texts = [];
    try {
        if (clip && clip.projectItem && clip.projectItem.getProjectColumnsMetadata) {
            var cols = JSON.parse(String(clip.projectItem.getProjectColumnsMetadata() || '[]'));
            for (var ci = 0; ci < cols.length; ci++) {
                if (String(cols[ci].ColumnName || '') === 'Video Info') {
                    var columnSize = _composerParseSize(String(cols[ci].ColumnValue || ''));
                    if (columnSize.width > 1 && columnSize.height > 1) {
                        return { width: columnSize.width, height: columnSize.height, estimated: false };
                    }
                }
            }
        }
    } catch (_) {}
    try { if (clip && clip.projectItem && clip.projectItem.getVideoInfo) texts.push(String(clip.projectItem.getVideoInfo() || '')); } catch (_) {}
    try { if (clip && clip.projectItem && clip.projectItem.getProjectMetadata) texts.push(String(clip.projectItem.getProjectMetadata() || '')); } catch (_) {}
    for (var i = 0; i < texts.length; i++) {
        var text = texts[i], w = 0, h = 0;
        var pair = text.match(/(\d{2,5})\s*[xX]\s*(\d{2,5})/);
        if (pair) { w = Number(pair[1]) || 0; h = Number(pair[2]) || 0; }
        if (!(w > 1 && h > 1)) {
            var xmpW = text.match(/stDim:w="(\d{2,5})"/), xmpH = text.match(/stDim:h="(\d{2,5})"/);
            if (xmpW && xmpH) { w = Number(xmpW[1]) || 0; h = Number(xmpH[1]) || 0; }
        }
        // XMP-style tags: <Width>1920</Width>, <xmpDM:videoFrameWidth>...
        if (!(w > 1 && h > 1)) {
            var wm = text.match(/<(?:[A-Za-z0-9]+:)?[Ww]idth[^>]*>\s*(\d{2,5})\s*</), hm = text.match(/<(?:[A-Za-z0-9]+:)?[Hh]eight[^>]*>\s*(\d{2,5})\s*</);
            if (wm && hm) { w = Number(wm[1]) || 0; h = Number(hm[1]) || 0; }
        }
        // Plain "width: 1920 height: 1080" style strings.
        if (!(w > 1 && h > 1)) {
            var wm2 = text.match(/[Ww]idth[^0-9]{1,12}(\d{2,5})/), hm2 = text.match(/[Hh]eight[^0-9]{1,12}(\d{2,5})/);
            if (wm2 && hm2) { w = Number(wm2[1]) || 0; h = Number(hm2[1]) || 0; }
        }
        if (w > 1 && h > 1) { result.width = w; result.height = h; return result; }
    }
    // Anchor offset is measured from the clip center, so an anchor parked on a
    // horizontal/vertical edge reveals that axis extent. Last resort only.
    if (anchorValue && anchorValue.length >= 2 && (Math.abs(Number(anchorValue[0])) > 2 || Math.abs(Number(anchorValue[1])) > 2)) {
        result.width = Math.max(1, Math.abs(Number(anchorValue[0])) * 2);
        result.height = Math.max(1, Math.abs(Number(anchorValue[1])) * 2);
        return result;
    }
    // A MOGRT/shape usually exposes a full-frame Motion surface. Treating an
    // unknown surface as the sequence frame prevents edge alignment from
    // throwing the graphic outside the composition.
    return { width: frame.width, height: frame.height, estimated: true };
}

function _composerMotionScale(clip) {
    var scale = _composerIntrinsicMotionProperty(clip, 'Scale', 1), sx = 1, sy = 1;
    try {
        var value = scale && scale.getValue();
        if (value && value.length >= 2) { sx = Number(value[0]) / 100; sy = Number(value[1]) / 100; }
        else if (value !== undefined && value !== null) sx = sy = Number(value) / 100;
    } catch (_) {}
    try {
        var uniform = _composerIntrinsicMotionProperty(clip, 'Uniform Scale', 2);
        var scaleWidth = _composerIntrinsicMotionProperty(clip, 'Scale Width', 3);
        var uni = uniform && uniform.getValue();
        if (uni === false || uni === 0 || String(uni).toLowerCase() === 'false') {
            var sw = scaleWidth && scaleWidth.getValue();
            if (sw !== undefined && sw !== null && !isNaN(Number(sw))) sx = Number(sw) / 100;
        }
    } catch (_) {}
    if (!(sx > 0)) sx = 1;
    if (!(sy > 0)) sy = sx;
    return { x: sx, y: sy };
}

function _composerRotatedBounds(size, anchorPx, scale, angle) {
    var rad = Number(angle || 0) * Math.PI / 180, co = Math.cos(rad), si = Math.sin(rad);
    var corners = [[0,0], [size.width,0], [0,size.height], [size.width,size.height]];
    var minX = 1e20, maxX = -1e20, minY = 1e20, maxY = -1e20;
    for (var i = 0; i < corners.length; i++) {
        var dx = (corners[i][0] - anchorPx[0]) * scale.x;
        var dy = (corners[i][1] - anchorPx[1]) * scale.y;
        var x = dx * co - dy * si, y = dx * si + dy * co;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
}

function _composerAnchorTarget(mode) {
    var points = {
        'top-left': [0, 0], 'top-center': [0.5, 0], 'top-right': [1, 0],
        'middle-left': [0, 0.5], 'center': [0.5, 0.5], 'middle-right': [1, 0.5],
        'bottom-left': [0, 1], 'bottom-center': [0.5, 1], 'bottom-right': [1, 1]
    };
    return points[String(mode || 'center')] || null;
}

// Premiere's Motion Anchor Point is a pixel offset from the clip's CENTER
// ([0,0] = dead center). The rotated-bounds helper works in top-left based
// clip pixels, so convert the anchor into that space (no clamping: an anchor
// outside the clip is legal and still pivots correctly).
function _composerAnchorPx(anchorValue, size) {
    var ax = size.width / 2, ay = size.height / 2;
    if (anchorValue && anchorValue.length >= 2) {
        var offX = Number(anchorValue[0]), offY = Number(anchorValue[1]);
        if (!isNaN(offX)) ax += offX;
        if (!isNaN(offY)) ay += offY;
    }
    return [ax, ay];
}

// Premiere's ExtendScript API exposes Motion point controls as normalized
// sequence/source coordinates even though Effect Controls renders them as
// pixels. Pixel values written through the API are clamped to 32767.
function _composerNormalizedMotionPoint(value, fallbackX, fallbackY) {
    var x = fallbackX, y = fallbackY;
    try {
        if (value && value.length >= 2) { x = Number(value[0]); y = Number(value[1]); }
    } catch (_) {}
    if (!isFinite(x) || Math.abs(x) > 16) x = fallbackX;
    if (!isFinite(y) || Math.abs(y) > 16) y = fallbackY;
    return [x, y];
}

// Premiere's setValue is ignored for time-varying Motion properties. When a
// user has already animated a Graphic, create/update the value at the active
// playhead. Static clips continue using the normal setValue route.
function _composerWriteMotionValue(prop, value, seq) {
    if (!prop) return false;
    var varying = false, playhead = null;
    try { varying = !!(prop.isTimeVarying && prop.isTimeVarying()); } catch (_) {}
    try { if (seq && seq.getPlayerPosition) playhead = seq.getPlayerPosition(); } catch (_) {}
    if (varying && playhead) {
        try { prop.addKey(playhead); } catch (_) {}
        try {
            var keyResult = prop.setValueAtKey(playhead, value, 1);
            if (keyResult === 0 || keyResult === true || keyResult === undefined) return true;
        } catch (_) {}
    }
    try {
        var staticResult = prop.setValue(value, 1);
        var after = null, readable = true;
        try { after = prop.getValue(); } catch (_) { readable = false; }
        // Judge the write by whether the REQUESTED value is now in place, not by
        // whether the value changed. Comparing against the previous value made a
        // no-op write look like a rejection, so pressing centre on a clip that is
        // already centred — or Anchor > centre on a default clip, whose anchor is
        // centred already — always reported "rejected the update".
        if (readable && after !== null) {
            var wanted = value, i, a, b;
            if (wanted && wanted.length >= 1 && after.length >= 1) {
                if (after.length < wanted.length) return false;
                for (i = 0; i < wanted.length; i++) {
                    a = Number(after[i]); b = Number(wanted[i]);
                    if (isNaN(a) || isNaN(b) || Math.abs(a - b) > 0.0005) return false;
                }
                return true;
            }
            a = Number(after); b = Number(wanted);
            if (!isNaN(a) && !isNaN(b)) return Math.abs(a - b) <= 0.0005;
            return String(after) === String(wanted);
        }
        return staticResult === 0 || staticResult === true || staticResult === undefined;
    } catch (_) {}
    return false;
}

function composerSetAnchorPoint(mode) {
    try {
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'No active sequence.' });
        if (!selected.items.length) return JSON.stringify({ error: 'Select one or more video, graphic, or MOGRT clips.' });
        var target = _composerAnchorTarget(mode);
        if (!target) return JSON.stringify({ error: 'Unknown anchor target.' });
        var frame = _composerFrameSize(selected.seq), changed = 0, skipped = 0, errors = [];
        try { app.beginUndoGroup('Orbit - Set Anchor Point'); } catch (_) {}
        for (var i = 0; i < selected.items.length; i++) {
            var clip = selected.items[i];
            var anchor = _composerIntrinsicMotionProperty(clip, 'Anchor Point', 5);
            var position = _composerIntrinsicMotionProperty(clip, 'Position', 0);
            var rotation = _composerIntrinsicMotionProperty(clip, 'Rotation', 4);
            var scaleProp = _composerIntrinsicMotionProperty(clip, 'Scale', 1);
            if (!anchor || !position) { skipped++; continue; }
            try {
                var scaleAnimated = false;
                try { scaleAnimated = !!(scaleProp && scaleProp.isTimeVarying && scaleProp.isTimeVarying()); } catch (_) {}
                if (scaleAnimated) { skipped++; errors.push('Clip ' + (i + 1) + ': Animated scale blocks anchor.'); continue; }
                var positionAnimated = false;
                try { positionAnimated = !!(position.isTimeVarying && position.isTimeVarying()); } catch (_) {}
                if (positionAnimated) { skipped++; errors.push('Clip ' + (i + 1) + ': Animated Position blocks anchor edits.'); continue; }
                var oldAnchorRaw = anchor.getValue(), oldPositionRaw = position.getValue();
                var oldAnchor = _composerNormalizedMotionPoint(oldAnchorRaw, 0.5, 0.5);
                var oldPosition = _composerNormalizedMotionPoint(oldPositionRaw, 0.5, 0.5);
                var size = _composerSourceSize(clip, frame, null);
                var newAnchor = [target[0], target[1]];
                var scale = _composerMotionScale(clip);
                var angle = 0;
                try { angle = Number(rotation && rotation.getValue()) || 0; } catch (_) {}
                var dx = (newAnchor[0] - oldAnchor[0]) * size.width * scale.x;
                var dy = (newAnchor[1] - oldAnchor[1]) * size.height * scale.y;
                var rad = angle * Math.PI / 180;
                var rx = dx * Math.cos(rad) - dy * Math.sin(rad);
                var ry = dx * Math.sin(rad) + dy * Math.cos(rad);
                var nextPosition = [oldPosition[0] + rx / frame.width, oldPosition[1] + ry / frame.height];
                if (_composerWriteMotionValue(anchor, newAnchor, selected.seq) && _composerWriteMotionValue(position, nextPosition, selected.seq)) changed++;
                else {
                    try { _composerWriteMotionValue(anchor, oldAnchorRaw, selected.seq); _composerWriteMotionValue(position, oldPositionRaw, selected.seq); } catch (_) {}
                    skipped++; errors.push('Clip ' + (i + 1) + ' rejected the Anchor Point update.');
                }
            } catch (itemError) { skipped++; errors.push('Clip ' + (i + 1) + ': ' + itemError.message); }
        }
        try { app.endUndoGroup(); } catch (_) {}
        if (!changed && errors.length) return JSON.stringify({ error: errors[0], changed: 0, skipped: skipped, errors: errors });
        return JSON.stringify({ ok: true, changed: changed, skipped: skipped, errors: errors });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'composerSetAnchorPoint: ' + e.message });
    }
}

function composerAlignSelection(mode) {
    try {
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'No active sequence.' });
        if (!selected.items.length) return JSON.stringify({ error: 'Select one or more video, graphic, or MOGRT clips.' });
        var targets = {
            'top-left': [0.05, 0.05], 'top-center': [0.50, 0.05], 'top-right': [0.95, 0.05],
            'middle-left': [0.05, 0.50], 'center': [0.50, 0.50], 'middle-right': [0.95, 0.50],
            'bottom-left': [0.05, 0.95], 'bottom-center': [0.50, 0.95], 'bottom-right': [0.95, 0.95]
        };
        var target = targets[String(mode || 'center')];
        if (!target) return JSON.stringify({ error: 'Unknown alignment target.' });
        var moved = 0, skipped = 0, errors = [];
        try { app.beginUndoGroup('Orbit - Align in Frame'); } catch (_) {}
        for (var i = 0; i < selected.items.length; i++) {
            var prop = _composerMotionPositionProperty(selected.items[i]);
            if (!prop) { skipped++; continue; }
            try {
                var keyframed = false;
                try { keyframed = !!(prop.isTimeVarying && prop.isTimeVarying()); } catch (_) {}
                if (keyframed) { skipped++; errors.push('Clip ' + (i + 1) + ': keyframed Position blocks align.'); continue; }
                var current = prop.getValue();
                if (!current || current.length < 2) { skipped++; continue; }
                // Premiere renders these normalized values as sequence pixels.
                // Example: [.5,.5] appears as 540,960 in a 1080x1920 sequence.
                if (_composerWriteMotionValue(prop, [target[0], target[1]], selected.seq)) moved++;
                else { skipped++; errors.push('Clip ' + (i + 1) + ' rejected the Position update.'); }
            } catch (eItem) { skipped++; errors.push('Clip ' + (i + 1) + ': ' + eItem.message); }
        }
        try { app.endUndoGroup(); } catch (_) {}
        if (!moved && errors.length) return JSON.stringify({ error: errors[0], moved: 0, skipped: skipped, errors: errors });
        return JSON.stringify({ ok: true, moved: moved, skipped: skipped, errors: errors });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'composerAlignSelection: ' + e.message });
    }
}
function composerCreateColorMatte(filePath, durationSeconds) {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var file = new File(String(filePath || ''));
        if (!file.exists) return JSON.stringify({ error: 'Generated matte file was not found.' });
        var duration = Math.max(0.1, Math.min(3600, Number(durationSeconds) || 5));
        var playheadSec = 0;
        try { playheadSec = Number(seq.getPlayerPosition().seconds) || 0; } catch (_) {}
        var bin = _getOrCreateBin(_getOrCreateBin(app.project.rootItem, 'CompX Orbit'), 'Generated Color Mattes');
        var normalized = String(file.fsName).replace(/\\/g, '/').toLowerCase();
        var item = _findItemByPath(bin, normalized);
        if (!item) {
            try { app.project.importFiles([file.fsName], true, bin, false); } catch (importError) { return JSON.stringify({ error: 'Could not import the color matte: ' + importError.message }); }
            item = _findItemByPath(bin, normalized);
        }
        if (!item) return JSON.stringify({ error: 'Premiere did not create a Project item for the color matte.' });
        var track = _pickFreeTopTrack(seq.videoTracks, playheadSec);
        if (!track) return JSON.stringify({ error: 'No free video track is available.' });
        var at = new Time(); at.seconds = playheadSec;
        try { track.overwriteClip(item, at); } catch (insertError) { return JSON.stringify({ error: 'Could not insert the color matte: ' + insertError.message }); }
        var placed = null;
        for (var i = 0; i < track.clips.numItems; i++) {
            try {
                var candidate = track.clips[i];
                if (Math.abs(Number(candidate.start.seconds) - playheadSec) < 0.05) { placed = candidate; break; }
            } catch (_) {}
        }
        if (!placed) return JSON.stringify({ error: 'Color matte was inserted but could not be located on the track.' });
        try { var end = new Time(); end.seconds = playheadSec + duration; placed.end = end; } catch (durationError) { return JSON.stringify({ error: 'Color matte inserted, but duration could not be set: ' + durationError.message }); }
        try { placed.name = 'Orbit Color Matte'; placed.setSelected(1, 1); } catch (_) {}
        var trackIndex = 0;
        try { for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) if (seq.videoTracks[ti] === track) { trackIndex = ti; break; } } catch (_) {}
        return JSON.stringify({ ok: true, track: trackIndex, duration: duration });
    } catch (e) {
        return JSON.stringify({ error: 'composerCreateColorMatte: ' + e.message });
    }
}
function composerSetMogrtParam(index, valueJSON, kind) {
    try {
        var selected = _composerSelected();
        if (!selected.seq || selected.items.length !== 1) return JSON.stringify({ error: 'Select exactly one MOGRT clip.' });
        var prop = _composerPropertyAt(selected.items[0], parseInt(index, 10));
        if (!prop) return JSON.stringify({ error: 'MOGRT control not found.' });
        var value = JSON.parse(valueJSON);
        var ok = false;
        if (kind === 'color' && value && value.length >= 4 && prop.setColorValue) {
            try { var colorResult = prop.setColorValue(Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3]), true); ok = colorResult !== false; } catch (_) { try { prop.setColorValue(Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3]), 1); ok = true; } catch (_) {} }
        } else ok = compxSetPropertyValue(prop, value);
        return ok ? JSON.stringify({ ok: true }) : JSON.stringify({ error: 'Premiere rejected this property value.' });
    } catch (e) {
        return JSON.stringify({ error: 'composerSetMogrtParam: ' + e.message });
    }
}

function composerReplaceMogrtMedia(index, filePath) {
    try {
        var selected = _composerSelected();
        if (!selected.seq || selected.items.length !== 1) return JSON.stringify({ error: 'Select exactly one MOGRT clip.' });
        var prop = _composerPropertyAt(selected.items[0], parseInt(index, 10));
        if (!prop || !prop.setAlternateSource) return JSON.stringify({ error: 'This MOGRT control does not support media replacement.' });
        var file = new File(filePath);
        if (!file.exists) return JSON.stringify({ error: 'Replacement file not found.' });
        var bin = _getOrCreateBin(_getOrCreateBin(app.project.rootItem, 'CompX Orbit'), 'Media Replacements');
        var norm = String(filePath).replace(/\\/g, '/').toLowerCase();
        var item = _findItemByPath(bin, norm);
        if (!item) {
            app.project.importFiles([file.fsName], true, bin, false);
            item = _findItemByPath(bin, norm);
        }
        if (!item) return JSON.stringify({ error: 'Could not import the replacement media.' });
        var result = prop.setAlternateSource(item);
        return JSON.stringify({ ok: result !== false });
    } catch (e) {
        return JSON.stringify({ error: 'composerReplaceMogrtMedia: ' + e.message });
    }
}


// ============================================================================
// Dock actions, round two: Nest/Unnest, Flip, Fit to Frame, Paste Image,
// Safe-margin guides, Create Sequence.
//
// Everything here goes through the same _composer* helpers the align/anchor
// work used, so the frame-size and Motion-property quirks are handled in one
// place. Source JSX only — rebuild hostscript.jsxbin after testing.
// ============================================================================

function _composerQe() {
    try { app.enableQE(); } catch (_) {}
    try { return qe && qe.project ? qe.project.getActiveSequence() : null; } catch (_) { return null; }
}

// Every video TrackItem carries Motion, Opacity and Time Remapping whether or
// not the editor touched them, and every audio one carries Volume, Channel
// Volume and Panner — three either way. Anything beyond that is a real,
// applied effect that an unnest cannot carry across.
var _COMPOSER_INTRINSIC_COMPONENTS = 3;

function _composerAppliedEffects(clip) {
    var total = 0;
    try { total = clip.components ? (clip.components.numItems || 0) : 0; } catch (_) { return 0; }
    var extra = total - _COMPOSER_INTRINSIC_COMPONENTS;
    return extra > 0 ? extra : 0;
}

function _composerSeconds(value) {
    try {
        if (value === null || value === undefined) return 0;
        if (value.seconds !== undefined) return Number(value.seconds) || 0;
        return Number(value) || 0;
    } catch (_) { return 0; }
}

function _composerTimeAt(seconds) {
    var t = new Time();
    try { t.seconds = Number(seconds) || 0; } catch (_) {}
    return t;
}

/* -------------------------------------------------------------- nest ----- */

/**
 * composerNest(name)
 * Wraps the selected timeline clips in a nested sequence. Premiere only
 * exposes this through QE, and QE reports nothing back, so success is judged
 * by the project gaining a sequence.
 */
function composerNest(name) {
    try {
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'Open a sequence first.' });
        if (!selected.items.length) return JSON.stringify({ error: 'Select one or more timeline clips first.' });

        var before = 0;
        try { before = app.project.sequences.numSequences; } catch (_) {}

        var qeSeq = _composerQe();
        if (!qeSeq || !qeSeq.createSubsequence) {
            return JSON.stringify({ error: 'This Premiere build does not expose Nest to scripting.' });
        }
        // The argument is "ignore track targeting". Older builds take none.
        try { qeSeq.createSubsequence(false); }
        catch (withArg) {
            try { qeSeq.createSubsequence(); }
            catch (without) { return JSON.stringify({ error: 'Nest failed: ' + without.message }); }
        }

        var after = before;
        try { after = app.project.sequences.numSequences; } catch (_) {}
        if (!(after > before)) return JSON.stringify({ error: 'Premiere did not create a nested sequence.' });

        var made = null;
        try { made = app.project.sequences[after - 1]; } catch (_) {}
        var finalName = '';
        if (made) {
            try {
                if (name) made.name = String(name);
                finalName = String(made.name || '');
            } catch (_) {}
        }
        return JSON.stringify({ ok: true, nested: selected.items.length, name: finalName });
    } catch (e) {
        return JSON.stringify({ error: 'composerNest: ' + e.message });
    }
}

// The TrackItem knows its projectItem; the Sequence that projectItem stands
// for has to be found by walking app.project.sequences, because a projectItem
// does not point back at its sequence.
function _composerSequenceForItem(projectItem) {
    if (!projectItem) return null;
    var wanted = '';
    try { wanted = String(projectItem.nodeId || ''); } catch (_) {}
    try {
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            var seq = seqs[i], node = '';
            try { node = String(seq.projectItem ? seq.projectItem.nodeId : ''); } catch (_) {}
            if (wanted && node && node === wanted) return seq;
        }
        // nodeId is missing on some builds; name is the only thing left.
        var wantedName = '';
        try { wantedName = String(projectItem.name || ''); } catch (_) {}
        if (!wantedName) return null;
        for (var j = 0; j < seqs.numSequences; j++) {
            try { if (String(seqs[j].name || '') === wantedName) return seqs[j]; } catch (_) {}
        }
    } catch (_) {}
    return null;
}

function _composerCollectNested(seq, nestIn, nestOut) {
    var rows = [], effects = 0;
    var groups = [
        { tracks: seq.videoTracks, kind: 'video' },
        { tracks: seq.audioTracks, kind: 'audio' }
    ];
    for (var g = 0; g < groups.length; g++) {
        var tracks = groups[g].tracks, count = 0;
        try { count = tracks.numTracks || 0; } catch (_) { count = 0; }
        for (var t = 0; t < count; t++) {
            var clips = null;
            try { clips = tracks[t].clips; } catch (_) { continue; }
            var n = 0;
            try { n = clips.numItems || 0; } catch (_) { n = 0; }
            for (var c = 0; c < n; c++) {
                var clip = clips[c];
                var start = _composerSeconds(clip.start), end = _composerSeconds(clip.end);
                if (end <= nestIn || start >= nestOut) continue;   // trimmed away by the nest
                var item = null;
                try { item = clip.projectItem; } catch (_) {}
                if (!item) continue;
                var head = Math.max(0, nestIn - start);            // cut off the front
                var tail = Math.max(0, end - nestOut);             // cut off the back
                rows.push({
                    kind: groups[g].kind,
                    track: t,
                    item: item,
                    name: String(clip.name || ''),
                    sourceIn: _composerSeconds(clip.inPoint) + head,
                    sourceOut: _composerSeconds(clip.outPoint) - tail,
                    at: Math.max(start, nestIn) - nestIn
                });
                effects += _composerAppliedEffects(clip);
            }
        }
    }
    return { rows: rows, effects: effects };
}

function _composerTrackFor(tracks, index) {
    var count = 0;
    try { count = tracks.numTracks || 0; } catch (_) { return null; }
    while (count <= index) {
        try { tracks.add(); } catch (_) { return null; }
        var grown = 0;
        try { grown = tracks.numTracks || 0; } catch (_) { grown = 0; }
        if (grown <= count) return null;                           // add() silently no-oped
        count = grown;
    }
    try { return tracks[index]; } catch (_) { return null; }
}

/**
 * composerUnnest(mode)
 * mode 'inspect' — report what an unnest would move and what it would cost,
 *                  changing nothing
 *      'apply'   — rebuild the nested sequence's contents on the parent
 *                  timeline and remove the nest clip
 *
 * Premiere has no unnest API and no way to copy a TrackItem's effects from
 * script, so effects and keyframes applied INSIDE the nest cannot come across.
 * The panel inspects first so it can say so BEFORE anything is touched — an
 * apply-then-warn would be warning about a change already made.
 */
function composerUnnest(mode) {
    try {
        var apply = String(mode || 'apply').toLowerCase() === 'apply';
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'Open a sequence first.' });
        if (selected.items.length !== 1) return JSON.stringify({ error: 'Select exactly one nested clip.' });

        var nest = selected.items[0], item = null;
        try { item = nest.projectItem; } catch (_) {}
        var inner = _composerSequenceForItem(item);
        if (!inner) return JSON.stringify({ error: 'The selected clip is not a nested sequence.' });

        var nestStart = _composerSeconds(nest.start);
        var nestIn = _composerSeconds(nest.inPoint);
        var nestOut = _composerSeconds(nest.outPoint);
        if (!(nestOut > nestIn)) nestOut = nestIn + (_composerSeconds(nest.end) - nestStart);

        var collected = _composerCollectNested(inner, nestIn, nestOut);
        if (!collected.rows.length) return JSON.stringify({ error: 'That nested sequence is empty.' });
        if (!apply) {
            return JSON.stringify({
                ok: true, inspected: true, clips: collected.rows.length, effects: collected.effects,
                name: String(inner.name || ''),
                message: collected.effects > 0
                    ? ('Rebuild ' + collected.rows.length + ' clip(s) on this timeline and delete the nest. '
                        + collected.effects + ' effect(s) applied inside the nest cannot be carried over and will be lost.')
                    : ('Rebuild ' + collected.rows.length + ' clip(s) on this timeline and delete the nest.')
            });
        }

        // The nest's own tracks are the base; everything inside stacks upward
        // from there so the rebuild never lands on top of unrelated clips.
        var baseVideo = 0, baseAudio = 0;
        try {
            for (var vi = 0; vi < selected.seq.videoTracks.numTracks; vi++) {
                var vTrack = selected.seq.videoTracks[vi];
                for (var vc = 0; vc < vTrack.clips.numItems; vc++) if (vTrack.clips[vc] === nest) { baseVideo = vi; break; }
            }
        } catch (_) {}
        try { baseAudio = selected.seq.audioTracks.numTracks; } catch (_) {}

        // Removing the nest FIRST frees the span the rebuilt clips need; doing
        // it afterwards would make every overwriteClip fight the nest for room.
        try { nest.remove(false, false); }
        catch (removeError) { return JSON.stringify({ error: 'Could not remove the nest clip: ' + removeError.message }); }

        var placed = 0, errors = [];
        for (var r = 0; r < collected.rows.length; r++) {
            var row = collected.rows[r];
            var tracks = row.kind === 'audio' ? selected.seq.audioTracks : selected.seq.videoTracks;
            var index = (row.kind === 'audio' ? baseAudio : baseVideo) + row.track;
            var track = _composerTrackFor(tracks, index);
            if (!track) { errors.push(row.name + ': no track available'); continue; }

            // Trimming the projectItem is the only reliable way to control what
            // overwriteClip inserts, so save and restore the original points.
            var savedIn = null, savedOut = null;
            try { savedIn = row.item.getInPoint(); savedOut = row.item.getOutPoint(); } catch (_) {}
            try { row.item.setInPoint(row.sourceIn); row.item.setOutPoint(row.sourceOut); } catch (_) {}
            try {
                track.overwriteClip(row.item, _composerTimeAt(nestStart + row.at));
                placed++;
            } catch (insertError) {
                errors.push(row.name + ': ' + insertError.message);
            }
            try {
                if (savedIn !== null) row.item.setInPoint(_composerSeconds(savedIn));
                if (savedOut !== null) row.item.setOutPoint(_composerSeconds(savedOut));
            } catch (_) {}
        }

        return JSON.stringify({
            ok: placed > 0, placed: placed, total: collected.rows.length,
            effectsLost: collected.effects, errors: errors
        });
    } catch (e) {
        return JSON.stringify({ error: 'composerUnnest: ' + e.message });
    }
}

/* -------------------------------------------------------------- flip ----- */

// Premiere's Motion has no flip, and only Scale Width can go negative, so a
// vertical flip is impossible through Motion. Both axes go through the stock
// flip effects instead. The names are localised, hence the candidate lists.
var _COMPOSER_FLIP_NAMES = {
    horizontal: ['Horizontal Flip', 'Flip Horizontal', 'Horizontale Spiegelung', 'Miroir horizontal'],
    vertical: ['Vertical Flip', 'Flip Vertical', 'Vertikale Spiegelung', 'Miroir vertical']
};

function _composerFindFlipEffect(names) {
    for (var i = 0; i < names.length; i++) {
        try {
            var effect = qe.project.getVideoEffectByName(names[i]);
            if (effect) return effect;
        } catch (_) {}
    }
    return null;
}

function _composerRemoveFlipComponent(qeClip, names) {
    var count = 0;
    try { count = qeClip.numComponents || 0; } catch (_) { return false; }
    for (var i = count - 1; i >= 0; i--) {
        var component = null;
        try { component = qeClip.getComponentAt(i); } catch (_) { continue; }
        var label = '';
        try { label = String(component.name || ''); } catch (_) {}
        for (var n = 0; n < names.length; n++) {
            if (label === names[n]) {
                try { component.remove(); return true; } catch (_) { return false; }
            }
        }
    }
    return false;
}

/**
 * composerFlip(axis)
 * Toggles Horizontal or Vertical Flip on every selected video clip: applies it
 * where it is missing, removes it where it is already there.
 */
function composerFlip(axis) {
    try {
        var key = String(axis || 'horizontal').toLowerCase();
        var names = _COMPOSER_FLIP_NAMES[key];
        if (!names) return JSON.stringify({ error: 'Unknown flip axis: ' + axis });

        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'Open a sequence first.' });
        if (!selected.items.length) return JSON.stringify({ error: 'Select one or more video clips first.' });

        var qeSeq = _composerQe();
        if (!qeSeq) return JSON.stringify({ error: 'This Premiere build does not expose effects to scripting.' });
        var effect = _composerFindFlipEffect(names);
        if (!effect) return JSON.stringify({ error: 'Premiere\'s ' + names[0] + ' effect was not found.' });

        var applied = 0, removed = 0, errors = [];
        for (var i = 0; i < selected.items.length; i++) {
            var clip = selected.items[i];
            var label = '';
            try { label = String(clip.name || 'clip'); } catch (_) { label = 'clip'; }
            try { if (clip.mediaType === 'Audio') { errors.push(label + ': audio clip skipped'); continue; } } catch (_) {}
            var qeClip = _composerFindQeClip(clip, qeSeq);
            if (!qeClip) { errors.push(label + ': not found on the QE timeline'); continue; }
            if (_composerRemoveFlipComponent(qeClip, names)) { removed++; continue; }
            try { qeClip.addVideoEffect(effect); applied++; }
            catch (addError) { errors.push(label + ': ' + addError.message); }
        }
        if (!applied && !removed) {
            return JSON.stringify({ error: errors.length ? errors[0] : 'Premiere did not confirm a flip.' });
        }
        return JSON.stringify({ ok: true, applied: applied, removed: removed, errors: errors });
    } catch (e) {
        return JSON.stringify({ error: 'composerFlip: ' + e.message });
    }
}

/* ------------------------------------------------------ fit to frame ----- */

/**
 * composerFitToFrame(mode)
 * mode 'fit'   — the whole source fits inside the frame (letterbox/pillarbox)
 *      'fill'  — the frame is covered, overhang is cropped
 *      'reset' — Scale back to 100%
 */
function composerFitToFrame(mode) {
    try {
        var kind = String(mode || 'fit').toLowerCase();
        if (kind !== 'fit' && kind !== 'fill' && kind !== 'reset') {
            return JSON.stringify({ error: 'Unknown fit mode: ' + mode });
        }
        var selected = _composerSelected();
        if (!selected.seq) return JSON.stringify({ error: 'Open a sequence first.' });
        if (!selected.items.length) return JSON.stringify({ error: 'Select one or more clips first.' });

        var frame = _composerFrameSize(selected.seq);
        var changed = 0, errors = [];
        for (var i = 0; i < selected.items.length; i++) {
            var clip = selected.items[i];
            var label = '';
            try { label = String(clip.name || 'clip'); } catch (_) { label = 'clip'; }

            var scaleProp = _composerIntrinsicMotionProperty(clip, 'Scale', 1);
            if (!scaleProp) { errors.push(label + ': no Motion Scale'); continue; }

            var percent = 100;
            if (kind !== 'reset') {
                var size = _composerSourceSize(clip, frame, null);
                if (!(size.width > 0) || !(size.height > 0)) { errors.push(label + ': source size unknown'); continue; }
                var byWidth = frame.width / size.width, byHeight = frame.height / size.height;
                percent = (kind === 'fill' ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight)) * 100;
            }

            // A non-uniform clip ignores Scale on one axis, so the fit would
            // only half apply. Turn Uniform Scale back on first.
            try {
                var uniform = _composerIntrinsicMotionProperty(clip, 'Uniform Scale', 2);
                if (uniform && uniform.getValue() === false) _composerWriteMotionValue(uniform, true, selected.seq);
            } catch (_) {}

            if (_composerWriteMotionValue(scaleProp, percent, selected.seq)) changed++;
            else errors.push(label + ': Premiere rejected the Scale change');
        }
        if (!changed) return JSON.stringify({ error: errors.length ? errors[0] : 'Premiere did not confirm a Scale change.' });
        return JSON.stringify({ ok: true, changed: changed, mode: kind, errors: errors });
    } catch (e) {
        return JSON.stringify({ error: 'composerFitToFrame: ' + e.message });
    }
}

/* ------------------------------------------------- insert a still -------- */

// Shared by Paste Image and the safe-margin guides: import once, drop it on a
// free top video track at `atSeconds`, and give it an exact duration.
function _composerPlaceStill(seq, filePath, binName, clipName, atSeconds, durationSeconds) {
    var file = new File(String(filePath || ''));
    if (!file.exists) return { error: 'Generated image was not found on disk.' };

    var bin = _getOrCreateBin(_getOrCreateBin(app.project.rootItem, 'CompX Orbit'), binName);
    var normalized = String(file.fsName).replace(/\\/g, '/').toLowerCase();
    var item = _findItemByPath(bin, normalized);
    if (!item) {
        try { app.project.importFiles([file.fsName], true, bin, false); }
        catch (importError) { return { error: 'Could not import the image: ' + importError.message }; }
        item = _findItemByPath(bin, normalized);
    }
    if (!item) return { error: 'Premiere did not create a Project item for the image.' };

    var track = _pickFreeTopTrack(seq.videoTracks, atSeconds);
    if (!track) return { error: 'No free video track is available.' };
    try { track.overwriteClip(item, _composerTimeAt(atSeconds)); }
    catch (insertError) { return { error: 'Could not insert the image: ' + insertError.message }; }

    var placed = null;
    try {
        for (var i = 0; i < track.clips.numItems; i++) {
            var candidate = track.clips[i];
            if (Math.abs(_composerSeconds(candidate.start) - atSeconds) < 0.05) { placed = candidate; break; }
        }
    } catch (_) {}
    if (!placed) return { error: 'The image was inserted but could not be located on the track.' };

    try { placed.end = _composerTimeAt(atSeconds + durationSeconds); }
    catch (durationError) { return { error: 'Image inserted, but its duration could not be set: ' + durationError.message }; }
    try { placed.name = clipName; } catch (_) {}

    var trackIndex = 0;
    try { for (var t = 0; t < seq.videoTracks.numTracks; t++) if (seq.videoTracks[t] === track) { trackIndex = t; break; } } catch (_) {}
    return { ok: true, track: trackIndex, clip: placed };
}

/**
 * composerInsertImageAtPlayhead(filePath, durationSeconds)
 * Drops an already-written image file at the playhead. The panel writes the
 * file — from the OS clipboard for Paste Image — because ExtendScript cannot
 * read a bitmap off the clipboard.
 */
function composerInsertImageAtPlayhead(filePath, durationSeconds) {
    try {
        var seq = getActiveSequence();
        var duration = Math.max(0.1, Math.min(3600, Number(durationSeconds) || 5));
        var at = 0;
        try { at = _composerSeconds(seq.getPlayerPosition()); } catch (_) {}
        var result = _composerPlaceStill(seq, filePath, 'Pasted Images', 'Pasted Image', at, duration);
        if (result.error) return JSON.stringify({ error: result.error });
        try { result.clip.setSelected(1, 1); } catch (_) {}
        return JSON.stringify({ ok: true, track: result.track, duration: duration });
    } catch (e) {
        return JSON.stringify({ error: 'composerInsertImageAtPlayhead: ' + e.message });
    }
}

/* ------------------------------------------------------------ guides ---- */

var _COMPOSER_GUIDE_CLIP_NAME = 'Orbit Safe Margins';

/**
 * composerInsertGuides(filePath, aspectLabel)
 * Lays a generated guide overlay across the whole sequence on the top video
 * track. Premiere exposes no program-monitor overlay to scripting, so a clip
 * on a guide track is the only way to show safe margins.
 */
function composerInsertGuides(filePath, aspectLabel) {
    try {
        var seq = getActiveSequence();
        composerRemoveGuides();                                    // never stack two
        var duration = 0;
        try { duration = _composerSeconds(seq.end); } catch (_) {}
        if (!(duration > 0)) duration = 60;
        var name = _COMPOSER_GUIDE_CLIP_NAME + ' ' + String(aspectLabel || '');
        var result = _composerPlaceStill(seq, filePath, 'Safe Margin Guides', name, 0, duration);
        if (result.error) return JSON.stringify({ error: result.error });
        return JSON.stringify({ ok: true, track: result.track, aspect: String(aspectLabel || '') });
    } catch (e) {
        return JSON.stringify({ error: 'composerInsertGuides: ' + e.message });
    }
}

/** Removes every guide clip this panel placed, on any video track. */
function composerRemoveGuides() {
    try {
        var seq = getActiveSequence();
        var removed = 0, tracks = seq.videoTracks, count = 0;
        try { count = tracks.numTracks || 0; } catch (_) { count = 0; }
        for (var t = 0; t < count; t++) {
            var clips = null;
            try { clips = tracks[t].clips; } catch (_) { continue; }
            var n = 0;
            try { n = clips.numItems || 0; } catch (_) { n = 0; }
            // Backwards: removing a clip re-indexes everything after it.
            for (var c = n - 1; c >= 0; c--) {
                var label = '';
                try { label = String(clips[c].name || ''); } catch (_) { continue; }
                if (label.indexOf(_COMPOSER_GUIDE_CLIP_NAME) !== 0) continue;
                try { clips[c].remove(false, false); removed++; } catch (_) {}
            }
        }
        return JSON.stringify({ ok: true, removed: removed });
    } catch (e) {
        return JSON.stringify({ error: 'composerRemoveGuides: ' + e.message });
    }
}

/* -------------------------------------------------- create sequence ----- */

/**
 * composerCreateSequence(mode, name)
 * mode 'selection' — a new sequence from the selected timeline clips, which
 *                    also gives it their format
 *      '16x9'      — a new 1920x1080 sequence
 *      '9x16'      — a new 1080x1920 sequence
 *
 * createNewSequence() is used rather than QE's newSequence() because it does
 * not need a preset path, which differs by platform and Premiere version. The
 * frame size is then written through setSettings().
 */
function composerCreateSequence(mode, name) {
    try {
        if (!app.project) return JSON.stringify({ error: 'Open a project first.' });
        var kind = String(mode || 'selection').toLowerCase();
        var title = String(name || '').replace(/^\s+|\s+$/g, '') || 'CompX Sequence';
        var before = 0;
        try { before = app.project.sequences.numSequences; } catch (_) {}

        if (kind === 'selection') {
            var selected = _composerSelected();
            if (!selected.seq || !selected.items.length) return JSON.stringify({ error: 'Select one or more timeline clips first.' });
            var items = [];
            for (var i = 0; i < selected.items.length; i++) {
                try { if (selected.items[i].projectItem) items.push(selected.items[i].projectItem); } catch (_) {}
            }
            if (!items.length) return JSON.stringify({ error: 'The selected clips have no source media.' });
            if (!app.project.createNewSequenceFromClips) return JSON.stringify({ error: 'This Premiere build cannot create a sequence from clips.' });
            app.project.createNewSequenceFromClips(title, items, app.project.rootItem);
            var madeCount = before;
            try { madeCount = app.project.sequences.numSequences; } catch (_) {}
            if (!(madeCount > before)) return JSON.stringify({ error: 'Premiere did not create a sequence.' });
            return JSON.stringify({ ok: true, name: title, from: items.length });
        }

        if (kind !== '16x9' && kind !== '9x16') return JSON.stringify({ error: 'Unknown sequence mode: ' + mode });
        var width = kind === '9x16' ? 1080 : 1920;
        var height = kind === '9x16' ? 1920 : 1080;

        app.project.createNewSequence(title, title);
        var after = before;
        try { after = app.project.sequences.numSequences; } catch (_) {}
        if (!(after > before)) return JSON.stringify({ error: 'Premiere did not create a sequence.' });

        var made = null;
        try { made = app.project.sequences[after - 1]; } catch (_) {}
        if (!made) return JSON.stringify({ ok: true, name: title, width: 0, height: 0, resized: false });

        var resized = false;
        try {
            var settings = made.getSettings();
            settings.videoFrameWidth = width;
            settings.videoFrameHeight = height;
            made.setSettings(settings);
            var check = made.getSettings();
            resized = Number(check.videoFrameWidth) === width && Number(check.videoFrameHeight) === height;
        } catch (_) { resized = false; }

        return JSON.stringify({ ok: true, name: title, width: width, height: height, resized: resized });
    } catch (e) {
        return JSON.stringify({ error: 'composerCreateSequence: ' + e.message });
    }
}


// ============================================================================
// SFX Studio host endpoints.
//
// The panel does the audio work — decoding, the effects rack, writing the WAV
// — because ExtendScript has no audio API at all. The host's job is the two
// things the panel cannot do: say where the media should live, and put the
// finished file on the timeline.
// ============================================================================

var _SFX_MEDIA_ROOT = 'CompX Orbit Audio';

/**
 * sfxMediaFolder()
 * Where processed audio should be written.
 *
 * Beside the project, because that is the one location that survives the
 * project being moved or handed to someone else — media written to Documents
 * goes offline the moment the .prproj travels. An unsaved project has no
 * "beside", so that case falls back to Documents rather than refusing to
 * work; the panel shows which one it got.
 *
 * Returns { root, scope:'project'|'user', originals, converted, segments }.
 */
function sfxMediaFolder() {
    try {
        var root = '', scope = 'user';
        try {
            var projectPath = String(app.project && app.project.path || '');
            if (projectPath) {
                var projectFile = new File(projectPath);
                if (projectFile.parent) {
                    root = String(projectFile.parent.fsName) + '/' + _SFX_MEDIA_ROOT;
                    scope = 'project';
                }
            }
        } catch (_) {}
        if (!root) {
            root = String(Folder.myDocuments.fsName) + '/CompX-Orbit-Premiere/' + _SFX_MEDIA_ROOT;
            scope = 'user';
        }
        var out = {
            ok: true, scope: scope, root: root,
            originals: root + '/Originals',
            converted: root + '/Converted',
            segments: root + '/Segments'
        };
        // Create them here rather than in the panel: the panel would have to
        // guess the separator and the permissions, and this is one round trip
        // instead of four.
        var names = ['', '/Originals', '/Converted', '/Segments'];
        for (var i = 0; i < names.length; i++) {
            try {
                var folder = new Folder(root + names[i]);
                if (!folder.exists) folder.create();
            } catch (_) {}
        }
        return JSON.stringify(out);
    } catch (e) {
        return JSON.stringify({ error: 'sfxMediaFolder: ' + e.message });
    }
}

// The insertion point. 'playhead' is the default; 'clip' puts the sound at the
// start of the selected clip, which is what you want when scoring a cut.
function _sfxInsertSeconds(seq, target) {
    var playhead = 0;
    try { playhead = Number(seq.getPlayerPosition().seconds) || 0; } catch (_) {}
    if (String(target || 'playhead') !== 'clip') return playhead;
    var earliest = null;
    try {
        var selection = seq.getSelection() || [];
        for (var i = 0; i < selection.length; i++) {
            var start = Number(selection[i].start.seconds);
            if (!isNaN(start) && (earliest === null || start < earliest)) earliest = start;
        }
    } catch (_) {}
    return earliest === null ? playhead : earliest;
}

/**
 * sfxInsertAudio(filePath, optionsJSON)
 * options: { target:'playhead'|'clip', cue:Number, label:String, kind:'segment'|'full' }
 *
 * `cue` is how far into the file the audible hit is: the clip lands at
 * (insert point − cue) so the hit itself is on the mark rather than the file's
 * silent lead-in.
 */
function sfxInsertAudio(filePath, optionsJSON) {
    try {
        var options = {};
        try { options = JSON.parse(optionsJSON || '{}') || {}; } catch (_) {}

        var file = new File(String(filePath || ''));
        if (!file.exists) return JSON.stringify({ error: 'The processed audio file was not found.' });
        var seq = getActiveSequence();

        var bin = _getOrCreateBin(_getOrCreateBin(app.project.rootItem, 'CompX Orbit'),
            String(options.kind) === 'segment' ? 'SFX Segments' : 'SFX');
        var normalized = String(file.fsName).replace(/\\/g, '/').toLowerCase();
        var item = _findItemByPath(bin, normalized);
        if (!item) {
            try { app.project.importFiles([file.fsName], true, bin, false); }
            catch (importError) { return JSON.stringify({ error: 'Could not import the audio: ' + importError.message }); }
            item = _findItemByPath(bin, normalized);
        }
        if (!item) return JSON.stringify({ error: 'Premiere did not create a Project item for the audio.' });

        var at = _sfxInsertSeconds(seq, options.target);
        var cue = Number(options.cue) || 0;
        var placeAt = at - cue;
        if (placeAt < 0) placeAt = 0;

        var track = _pickFreeTopTrack(seq.audioTracks, placeAt);
        if (!track) return JSON.stringify({ error: 'No free audio track is available.' });
        var time = new Time(); time.seconds = placeAt;
        try { track.overwriteClip(item, time); }
        catch (insertError) { return JSON.stringify({ error: 'Could not insert the audio: ' + insertError.message }); }

        var placed = null;
        try {
            for (var c = 0; c < track.clips.numItems; c++) {
                var candidate = track.clips[c];
                if (Math.abs(Number(candidate.start.seconds) - placeAt) < 0.05) { placed = candidate; break; }
            }
        } catch (_) {}
        if (placed && options.label) { try { placed.name = String(options.label); } catch (_) {} }
        if (placed) { try { placed.setSelected(1, 1); } catch (_) {} }

        var trackIndex = 0;
        try { for (var t = 0; t < seq.audioTracks.numTracks; t++) if (seq.audioTracks[t] === track) { trackIndex = t; break; } } catch (_) {}
        return JSON.stringify({ ok: true, track: trackIndex, at: placeAt, target: String(options.target || 'playhead') });
    } catch (e) {
        return JSON.stringify({ error: 'sfxInsertAudio: ' + e.message });
    }
}


// ============================================================================
// Beat Lab v2 - marker toolkit and Curve Lab Lite motion
// Source JSX only. Rebuild hostscript.jsxbin after testing.
// ============================================================================
var _orbitBeatMarkerClipboard = [];

function _beatV2Seconds(value) {
    try {
        if (value && value.seconds !== undefined) return Number(value.seconds) || 0;
        return Number(value) || 0;
    } catch (_) { return 0; }
}

function _beatV2Range(seq, scope) {
    var end = 1e20;
    try { end = _beatV2Seconds(seq.end); } catch (_) {}
    var range = { start: 0, end: end };
    if (scope === 'workarea') {
        try { range.start = _beatV2Seconds(seq.getInPoint ? seq.getInPoint() : 0); } catch (_) {}
        try {
            var out = _beatV2Seconds(seq.getOutPoint ? seq.getOutPoint() : 0);
            if (out > range.start) range.end = out;
        } catch (_) {}
    }
    return range;
}

function _beatV2InRange(time, range) {
    return time >= range.start - 0.0005 && time <= range.end + 0.0005;
}

function _beatV2MarkerTime(marker) {
    try { return _beatV2Seconds(marker.start); } catch (_) {}
    try { return Number(marker.start) || 0; } catch (_) {}
    return 0;
}

function _beatV2MarkerRows(collection) {
    var rows = [];
    if (!collection) return rows;
    try {
        var marker = collection.getFirstMarker();
        var guard = 0;
        while (marker && guard++ < 100000) {
            rows.push({
                marker: marker,
                time: _beatV2MarkerTime(marker),
                name: String(marker.name || 'Beat'),
                comments: String(marker.comments || ''),
                color: (function () { try { return marker.getColorByIndex ? marker.getColorByIndex() : 2; } catch (_) { return 2; } })()
            });
            marker = collection.getNextMarker(marker);
        }
    } catch (_) {}
    return rows;
}

function _beatV2Create(collection, time, row) {
    try {
        var marker = collection.createMarker(Number(time));
        marker.name = (row && row.name) || 'Beat';
        marker.comments = (row && row.comments) || '';
        try { if (marker.setColorByIndex) marker.setColorByIndex(row && row.color !== undefined ? Number(row.color) : 2); } catch (_) {}
        return true;
    } catch (_) { return false; }
}

function _beatV2Delete(collection, marker) {
    try { collection.deleteMarker(marker); return true; } catch (_) {}
    return false;
}

function _beatV2ClipTargets(seq) {
    var selected = pproSelectedClips ? pproSelectedClips(seq) : [];
    var out = [], seen = {};
    for (var i = 0; i < selected.length; i++) {
        var clip = selected[i], item = null, collection = null;
        try { item = clip.projectItem; } catch (_) {}
        try { collection = item && item.getMarkers ? item.getMarkers() : null; } catch (_) {}
        if (!item || !collection) continue;
        var key = '';
        try { key = String(item.nodeId || item.treePath || item.name); } catch (_) { key = String(i); }
        key += '|' + String(_beatV2Seconds(clip.start));
        if (seen[key]) continue;
        seen[key] = true;
        out.push({
            clip: clip,
            item: item,
            markers: collection,
            seqStart: _beatV2Seconds(clip.start),
            seqEnd: _beatV2Seconds(clip.end),
            srcIn: _beatV2Seconds(clip.inPoint)
        });
    }
    return out;
}

function _beatV2SeqToSource(target, seqTime) {
    return target.srcIn + (Number(seqTime) - target.seqStart);
}

function _beatV2SourceToSeq(target, sourceTime) {
    return target.seqStart + (Number(sourceTime) - target.srcIn);
}

function beatCreateMarkers(timesJSON, markerType, scope, label) {
    try {
        var seq = getActiveSequence();
        var times = JSON.parse(timesJSON || '[]');
        if (!times.length) return JSON.stringify({ error: 'No selected beat events.' });
        var range = _beatV2Range(seq, scope), added = 0;
        try { app.beginUndoGroup('CompX Orbit - Beat Lab Markers'); } catch (_) {}
        if (markerType === 'clip') {
            var targets = _beatV2ClipTargets(seq);
            if (!targets.length) {
                try { app.endUndoGroup(); } catch (_) {}
                return JSON.stringify({ error: 'Select one or more timeline clips for clip markers.' });
            }
            for (var c = 0; c < targets.length; c++) {
                for (var i = 0; i < times.length; i++) {
                    var t = Number(times[i]);
                    if (!_beatV2InRange(t, range) || t < targets[c].seqStart || t > targets[c].seqEnd) continue;
                    if (_beatV2Create(targets[c].markers, _beatV2SeqToSource(targets[c], t), {
                        name: label || 'Beat', comments: 'Beat event ' + (i + 1), color: 2
                    })) added++;
                }
            }
        } else {
            for (var j = 0; j < times.length; j++) {
                var st = Number(times[j]);
                if (_beatV2InRange(st, range) && _beatV2Create(seq.markers, st, {
                    name: label || 'Beat', comments: 'Beat event ' + (j + 1), color: 2
                })) added++;
            }
        }
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ ok: true, added: added });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'beatCreateMarkers: ' + e.message });
    }
}

function _beatV2ScopedMarkers(seq, markerType, scope) {
    var range = _beatV2Range(seq, scope), out = [];
    if (markerType === 'clip') {
        var targets = _beatV2ClipTargets(seq);
        for (var c = 0; c < targets.length; c++) {
            var rows = _beatV2MarkerRows(targets[c].markers);
            for (var i = 0; i < rows.length; i++) {
                var seqTime = _beatV2SourceToSeq(targets[c], rows[i].time);
                if (_beatV2InRange(seqTime, range) && seqTime >= targets[c].seqStart && seqTime <= targets[c].seqEnd) {
                    out.push({ collection: targets[c].markers, marker: rows[i].marker, time: seqTime,
                        name: rows[i].name, comments: rows[i].comments, color: rows[i].color, target: targets[c] });
                }
            }
        }
    } else {
        var seqRows = _beatV2MarkerRows(seq.markers);
        for (var j = 0; j < seqRows.length; j++) if (_beatV2InRange(seqRows[j].time, range)) {
            out.push({ collection: seq.markers, marker: seqRows[j].marker, time: seqRows[j].time,
                name: seqRows[j].name, comments: seqRows[j].comments, color: seqRows[j].color });
        }
    }
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
}

function _beatV2PasteRows(seq, markerType, rows, anchor) {
    var count = 0;
    if (markerType === 'clip') {
        var targets = _beatV2ClipTargets(seq);
        for (var i = 0; i < rows.length; i++) {
            var seqTime = anchor + Number(rows[i].relative || 0);
            for (var c = 0; c < targets.length; c++) {
                if (seqTime < targets[c].seqStart || seqTime > targets[c].seqEnd) continue;
                if (_beatV2Create(targets[c].markers, _beatV2SeqToSource(targets[c], seqTime), rows[i])) count++;
            }
        }
    } else {
        for (var j = 0; j < rows.length; j++) {
            if (_beatV2Create(seq.markers, anchor + Number(rows[j].relative || 0), rows[j])) count++;
        }
    }
    return count;
}

function beatManageMarkers(command, markerType, scope) {
    try {
        var seq = getActiveSequence();
        var rows = _beatV2ScopedMarkers(seq, markerType, scope);
        var playhead = 0;
        try { playhead = _beatV2Seconds(seq.getPlayerPosition()); } catch (_) {}
        if (command === 'copy') {
            if (!rows.length) return JSON.stringify({ error: 'No markers in this scope.' });
            var first = rows[0].time;
            _orbitBeatMarkerClipboard = [];
            for (var i = 0; i < rows.length; i++) _orbitBeatMarkerClipboard.push({
                relative: rows[i].time - first, name: rows[i].name, comments: rows[i].comments, color: rows[i].color
            });
            return JSON.stringify({ ok: true, copied: _orbitBeatMarkerClipboard.length });
        }
        if (command === 'paste') {
            if (!_orbitBeatMarkerClipboard.length) return JSON.stringify({ error: 'Marker clipboard is empty.' });
            try { app.beginUndoGroup('CompX Orbit - Paste Markers'); } catch (_) {}
            var pasted = _beatV2PasteRows(seq, markerType, _orbitBeatMarkerClipboard, playhead);
            try { app.endUndoGroup(); } catch (_) {}
            return JSON.stringify({ ok: true, pasted: pasted });
        }
        if (!rows.length) return JSON.stringify({ error: 'No markers in this scope.' });
        try { app.beginUndoGroup(command === 'move' ? 'CompX Orbit - Move Markers' : 'CompX Orbit - Delete Markers'); } catch (_) {}
        var removed = 0;
        if (command === 'move') {
            var start = rows[0].time, moving = [];
            for (var m = 0; m < rows.length; m++) moving.push({
                relative: rows[m].time - start, name: rows[m].name, comments: rows[m].comments, color: rows[m].color
            });
            for (var d = rows.length - 1; d >= 0; d--) if (_beatV2Delete(rows[d].collection, rows[d].marker)) removed++;
            var moved = _beatV2PasteRows(seq, markerType, moving, playhead);
            try { app.endUndoGroup(); } catch (_) {}
            return JSON.stringify({ ok: true, moved: moved, deleted: removed });
        }
        if (command === 'delete') {
            for (var x = rows.length - 1; x >= 0; x--) if (_beatV2Delete(rows[x].collection, rows[x].marker)) removed++;
            try { app.endUndoGroup(); } catch (_) {}
            return JSON.stringify({ ok: true, deleted: removed });
        }
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'Unknown marker command.' });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'beatManageMarkers: ' + e.message });
    }
}

function _beatV2ReadValue(param, time, fallback) {
    try {
        var value = param.getValueAtTime(time);
        if (value !== undefined && value !== null) return value;
    } catch (_) {}
    try {
        var current = param.getValue();
        if (current !== undefined && current !== null) return current;
    } catch (_) {}
    return fallback;
}

function _beatV2Scalar(value, fallback) {
    if (value && value.length) return Number(value[0]) || fallback;
    return Number(value);
}

function _beatV2AddKey(list, time, value, clipStart, clipEnd) {
    time = Math.max(clipStart, Math.min(clipEnd, time));
    if (list.length && Math.abs(list[list.length - 1].t - time) < 0.0001) list[list.length - 1].v = value;
    else list.push({ t: time, v: value });
}

function beatApplyMotion(timesJSON, optionsJSON) {
    try {
        var seq = getActiveSequence();
        var times = JSON.parse(timesJSON || '[]');
        var opts = JSON.parse(optionsJSON || '{}');
        if (!times.length) return JSON.stringify({ error: 'No selected beat events.' });
        var selected = pproSelectedClips ? pproSelectedClips(seq) : [];
        if (!selected.length) return JSON.stringify({ error: 'Select one or more video clips.' });
        var fps = 30;
        try { fps = 254016000000 / parseInt(seq.timebase, 10); } catch (_) {}
        if (!(fps > 0)) fps = 30;
        var property = String(opts.property || 'scale').toLowerCase();
        var curve = String(opts.curve || 'pulse').toLowerCase();
        var amount = Number(opts.amount);
        if (!isFinite(amount)) amount = 12;
        var duration = Math.max(2, Number(opts.durationFrames) || 8) / fps;
        var repeatEvery = Math.max(1, parseInt(opts.repeatEvery, 10) || 1);
        var stagger = Math.max(0, Number(opts.staggerFrames) || 0) / fps;
        var keys = 0, clips = 0, skipped = 0;
        try { app.beginUndoGroup('CompX Orbit - Beat Motion'); } catch (_) {}

        for (var c = 0; c < selected.length; c++) {
            var clip = selected[c], param = motionFindParam(clip, property);
            if (!param) { skipped++; continue; }
            var clipStart = _beatV2Seconds(clip.start), clipEnd = _beatV2Seconds(clip.end);
            var clipTimes = [];
            for (var i = 0; i < times.length; i++) {
                if (i % repeatEvery !== 0) continue;
                var eventTime = Number(times[i]) + c * stagger;
                if (eventTime >= clipStart && eventTime <= clipEnd) clipTimes.push(eventTime);
            }
            if (!clipTimes.length) { skipped++; continue; }
            var probe = motionMakeTime(clip, clipTimes[0]);
            var fallback = property === 'position' ? [0, 0] : (property === 'scale' ? 100 : (property === 'opacity' ? 100 : 0));
            var base = _beatV2ReadValue(param, probe, fallback);
            var scalar = _beatV2Scalar(base, Number(fallback) || 0);
            if (!isFinite(scalar)) scalar = Number(fallback) || 0;
            var keyframes = [];
            for (var e = 0; e < clipTimes.length; e++) {
                var center = clipTimes[e], half = duration / 2;
                var baseValue = property === 'position' ? { x: 0, y: 0 } : scalar;
                var peakValue;
                if (property === 'position') peakValue = { x: 0, y: amount };
                else if (property === 'opacity') peakValue = Math.max(0, Math.min(100, scalar + amount));
                else peakValue = scalar + amount;
                _beatV2AddKey(keyframes, center - half, baseValue, clipStart, clipEnd);
                _beatV2AddKey(keyframes, center, peakValue, clipStart, clipEnd);
                if (curve === 'bounce') {
                    var bounceValue = property === 'position' ? { x: 0, y: -amount * 0.35 } :
                        (property === 'opacity' ? Math.max(0, Math.min(100, scalar - amount * 0.35)) : scalar - amount * 0.35);
                    _beatV2AddKey(keyframes, center + half * 0.62, bounceValue, clipStart, clipEnd);
                } else if (curve === 'overshoot') {
                    var overshootValue = property === 'position' ? { x: 0, y: -amount * 0.22 } :
                        (property === 'opacity' ? Math.max(0, Math.min(100, scalar - amount * 0.22)) : scalar - amount * 0.22);
                    _beatV2AddKey(keyframes, center + half * 0.55, overshootValue, clipStart, clipEnd);
                }
                _beatV2AddKey(keyframes, center + half, baseValue, clipStart, clipEnd);
            }
            keyframes.sort(function (a, b) { return a.t - b.t; });
            var compactKeys = [];
            for (var k = 0; k < keyframes.length; k++) {
                if (compactKeys.length && Math.abs(compactKeys[compactKeys.length - 1].t - keyframes[k].t) < 0.0001) {
                    compactKeys[compactKeys.length - 1] = keyframes[k];
                } else compactKeys.push(keyframes[k]);
            }
            var properties = {};
            properties[property] = compactKeys;
            var applied = motionApplyToClip(clip, properties, curve === 'pulse' ? 'ease' : 'overshoot');
            if (applied) { keys += applied; clips++; } else skipped++;
        }
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ ok: true, clips: clips, keys: keys, skipped: skipped });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'beatApplyMotion: ' + e.message });
    }
}

/**
 * createAnimatedCaptionClips - Enhanced SRT to animated text clips
 * Creates PNG sequences from SRT data and places them as animated clips
 * Supports multiple animation styles and multi-language text
 */
function createAnimatedCaptionClips(animationDataJson) {
    return JSON.stringify({ error: 'Legacy SRT host export is disabled because it did not create real timeline clips. Use SRT to Templates through Caption Editor.' });
    /* Legacy placeholder retained temporarily for source compatibility; it is
       intentionally unreachable so callers can never receive false success. */
    try {
        var data = JSON.parse(animationDataJson);
        if (!data || !data.captions || !data.captions.length) {
            return JSON.stringify({ error: "No caption data provided." });
        }

        var seq = getActiveSequence();
        var seqInfo = data.sequenceInfo || { width: 1920, height: 1080, timebase: 30 };
        var settings = data.settings || {};
        var captions = data.captions;
        
        // Create CompX Orbit bin structure
        var orbitBin = _getOrCreateBin(app.project.rootItem, 'CompX Orbit');
        var captionBin = _getOrCreateBin(orbitBin, 'Animated Captions');
        var runBinName = 'Run_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var runBin = _getOrCreateBin(captionBin, runBinName);
        
        var createdClips = 0;
        var errors = [];
        
        // Process each caption - for now we'll create placeholder clips
        // In a full implementation, this would import the actual PNG sequences
        for (var i = 0; i < captions.length; i++) {
            var cap = captions[i];
            try {
                // Create a placeholder for the animated caption
                // In production, this would import the PNG sequence files
                var clipName = 'Caption_' + cap.id + '_' + (cap.language || 'latin');
                
                // For demonstration, we create a title clip instead of importing PNGs
                // This would be replaced with actual PNG sequence import in production
                var startTime = new Time();
                startTime.seconds = cap.start;
                
                var duration = cap.end - cap.start;
                if (duration < 0.1) duration = 0.1; // minimum duration
                
                // Create a simple title clip at the caption position
                // This is a placeholder - production would use actual PNG sequences
                var trackIdx = 2; // Use video track 2 by default
                if (seq.videoTracks.numTracks <= trackIdx) {
                    seq.videoTracks.add();
                }
                
                createdClips++;
            } catch (clipError) {
                errors.push('Caption ' + cap.id + ': ' + clipError.message);
            }
        }
        
        return JSON.stringify({
            success: true,
            created: createdClips,
            total: captions.length,
            errors: errors,
            binPath: 'CompX Orbit/Animated Captions/' + runBinName,
            settings: settings
        });
        
    } catch (e) {
        return JSON.stringify({ error: "createAnimatedCaptionClips: " + e.message });
    }
}

// Auto Montage Builder -------------------------------------------------------
// Builds an original Premiere edit from Project-panel footage using Beat Lab
// events, constant intervals or sequence markers. ProjectItem in/out points are
// restored after every placement and existing target-track media is protected
// unless the user explicitly enables overwrite.
function _orbitMontageSelection() {
    var out = [], i, j;
    try {
        if (typeof app.getProjectViewIDs === 'function' && typeof app.getProjectViewSelection === 'function') {
            var ids = app.getProjectViewIDs();
            for (i = 0; ids && i < ids.length; i++) {
                var rows = null;
                try { rows = app.getProjectViewSelection(ids[i]); } catch (_) {}
                for (j = 0; rows && j < rows.length; j++) if (rows[j]) out.push(rows[j]);
            }
        }
    } catch (_) {}
    if (out.length) return out;
    try {
        if (typeof app.getCurrentProjectViewSelection === 'function') {
            var current = app.getCurrentProjectViewSelection();
            for (i = 0; current && i < current.length; i++) if (current[i]) out.push(current[i]);
        }
    } catch (_) {}
    if (out.length) return out;
    try {
        if (app.project && typeof app.project.getSelectedProjectItems === 'function') {
            var selected = app.project.getSelectedProjectItems();
            var count = selected ? (selected.numItems !== undefined ? selected.numItems : selected.length || 0) : 0;
            for (i = 0; i < count; i++) if (selected[i]) out.push(selected[i]);
        }
    } catch (_) {}
    return out;
}

function _orbitMontageItemKey(item) {
    try { if (item.nodeId !== undefined) return 'node:' + String(item.nodeId); } catch (_) {}
    try { var path = String(item.getMediaPath() || ''); if (path) return 'path:' + path.toLowerCase(); } catch (_) {}
    try { return 'name:' + String(item.name || ''); } catch (_) {}
    return 'unknown';
}

function _orbitMontageCollect(item, out, seen) {
    if (!item) return;
    var isBin = false, typeKnown = false;
    try { isBin = item.type === ProjectItemType.BIN; typeKnown = true; } catch (_) {}
    if (!typeKnown) try { isBin = !!(item.children && item.children.numItems > 0); } catch (_) {}
    if (isBin) {
        var count = 0;
        try { count = item.children.numItems; } catch (_) {}
        for (var i = 0; i < count; i++) _orbitMontageCollect(item.children[i], out, seen);
        return;
    }
    var path = '';
    try { path = String(item.getMediaPath() || ''); } catch (_) {}
    if (!path || !/\.(mp4|mov|m4v|avi|mkv|webm|mpg|mpeg|wmv|mxf|mts|m2ts|r3d|braw|ari|crm|dng|jpg|jpeg|png|gif|bmp|webp|tif|tiff|exr|psd)$/i.test(path)) return;
    try { if (item.isOffline && item.isOffline()) return; } catch (_) {}
    var key = _orbitMontageItemKey(item);
    if (seen[key]) return;
    seen[key] = true;
    out.push(item);
}

function _orbitMontageSources() {
    var selected = _orbitMontageSelection(), out = [], seen = {};
    for (var i = 0; i < selected.length; i++) _orbitMontageCollect(selected[i], out, seen);
    return out;
}

function _orbitMontageMarkerTimes(seq) {
    var rows = [];
    try { rows = _beatV2MarkerRows(seq.markers); } catch (_) {}
    var times = [];
    for (var i = 0; i < rows.length; i++) {
        var t = Number(rows[i].time);
        if (isFinite(t) && t >= 0) times.push(t);
    }
    times.sort(function (a, b) { return a - b; });
    return times;
}

function beatMontageInspectSources(optionsJSON) {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'Open an active sequence first.' });
        var sources = _orbitMontageSources(), names = [];
        for (var i = 0; i < sources.length && i < 12; i++) names.push(String(sources[i].name || 'Clip'));
        return JSON.stringify({
            ok: true,
            sourceCount: sources.length,
            names: names,
            markerCount: _orbitMontageMarkerTimes(seq).length,
            videoTracks: seq.videoTracks.numTracks || 0,
            sequence: String(seq.name || '')
        });
    } catch (e) {
        return JSON.stringify({ error: 'beatMontageInspectSources: ' + e.message });
    }
}

function _orbitMontageRandom(seedRef) {
    seedRef.value = (seedRef.value * 1664525 + 1013904223) % 4294967296;
    return seedRef.value / 4294967296;
}

function _orbitMontageShuffle(items, seedRef) {
    var out = items.slice(0);
    for (var i = out.length - 1; i > 0; i--) {
        var j = Math.floor(_orbitMontageRandom(seedRef) * (i + 1));
        var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
}

function _orbitMontageUniqueTimes(values) {
    var out = [], source = values || [];
    for (var i = 0; i < source.length; i++) {
        var value = Number(source[i]);
        if (isFinite(value) && value >= 0) out.push(value);
    }
    out.sort(function (a, b) { return a - b; });
    var unique = [];
    for (i = 0; i < out.length; i++) if (!unique.length || Math.abs(out[i] - unique[unique.length - 1]) > .001) unique.push(out[i]);
    return unique;
}

function _orbitMontageBoundaries(rawTimes, opts, total) {
    var mode = String(opts.mode || 'beat'), raw = _orbitMontageUniqueTimes(rawTimes), offsets = [], i;
    if (mode === 'constant') {
        var step = Math.max(.1, Number(opts.constantDuration) || 2.5);
        for (var at = 0; at < total; at += step) offsets.push(at);
    } else {
        if (!raw.length) return [];
        var base = raw[0];
        for (i = 0; i < raw.length; i++) offsets.push(Math.max(0, raw[i] - base));
    }
    if (!offsets.length || offsets[0] > .001) offsets.unshift(0);
    var minShot = Math.max(.1, Number(opts.minShot) || .5);
    var maxShot = Math.max(minShot, Number(opts.maxShot) || 4);
    var boundaries = [0];
    for (i = 1; i < offsets.length; i++) {
        var point = Math.min(total, offsets[i]);
        if (point <= boundaries[boundaries.length - 1] + .001) continue;
        while (point - boundaries[boundaries.length - 1] > maxShot + .001) boundaries.push(boundaries[boundaries.length - 1] + maxShot);
        if (point - boundaries[boundaries.length - 1] >= minShot - .001) boundaries.push(point);
    }
    while (total - boundaries[boundaries.length - 1] > maxShot + .001) boundaries.push(boundaries[boundaries.length - 1] + maxShot);
    if (total - boundaries[boundaries.length - 1] > .04) boundaries.push(total);
    return boundaries;
}

function _orbitMontageTimeSeconds(value) {
    try { if (value.seconds !== undefined) return Number(value.seconds); } catch (_) {}
    try { if (value.secs !== undefined) return Number(value.secs); } catch (_) {}
    try { if (value.ticks !== undefined) return Number(value.ticks) / 254016000000; } catch (_) {}
    var number = Number(value);
    return isFinite(number) ? number : 0;
}

function _orbitMontageSourceRange(item) {
    var oldIn = null, oldOut = null, inSec = 0, outSec = 0;
    try { oldIn = item.getInPoint(4); inSec = _orbitMontageTimeSeconds(oldIn); } catch (_) {}
    try { oldOut = item.getOutPoint(4); outSec = _orbitMontageTimeSeconds(oldOut); } catch (_) {}
    if (!(outSec > inSec)) {
        try { outSec = _orbitMontageTimeSeconds(item.duration); } catch (_) {}
    }
    return { oldIn: oldIn, oldOut: oldOut, inSec: Math.max(0, inSec), outSec: Math.max(0, outSec), duration: Math.max(0, outSec - inSec) };
}

function _orbitMontageSetPoint(item, method, seconds) {
    if (!item || typeof item[method] !== 'function') return false;
    try { item[method](seconds, 4); return true; } catch (_) {}
    try { var time = new Time(); time.seconds = seconds; item[method](time, 4); return true; } catch (_) {}
    return false;
}

function _orbitMontageRestoreRange(item, range) {
    if (!item || !range) return;
    try { if (range.oldIn !== null) item.setInPoint(range.oldIn, 4); else _orbitMontageSetPoint(item, 'setInPoint', range.inSec); } catch (_) {}
    try { if (range.oldOut !== null) item.setOutPoint(range.oldOut, 4); else if (range.outSec > 0) _orbitMontageSetPoint(item, 'setOutPoint', range.outSec); } catch (_) {}
}

function _orbitMontageTrackCollision(track, start, end) {
    var count = 0;
    try { count = track.clips.numItems; } catch (_) {}
    for (var i = 0; i < count; i++) {
        var cs = 0, ce = 0;
        try { cs = Number(track.clips[i].start.seconds); ce = Number(track.clips[i].end.seconds); } catch (_) { continue; }
        if (ce > start + .001 && cs < end - .001) return true;
    }
    return false;
}

function _orbitMontageFindClip(track, start, item) {
    var count = 0, key = _orbitMontageItemKey(item);
    try { count = track.clips.numItems; } catch (_) {}
    for (var i = count - 1; i >= 0; i--) {
        var clip = track.clips[i], cs = NaN;
        try { cs = Number(clip.start.seconds); } catch (_) {}
        if (isNaN(cs) || Math.abs(cs - start) > .08) continue;
        try { if (clip.projectItem && _orbitMontageItemKey(clip.projectItem) === key) return clip; } catch (_) {}
        return clip;
    }
    return null;
}

function _orbitMontageSetClipEnd(clip, seconds) {
    if (!clip) return false;
    try { var time = new Time(); time.seconds = seconds; clip.end = time; return true; } catch (_) {}
    try { clip.end.seconds = seconds; return true; } catch (_) {}
    return false;
}

function _orbitMontageRemoveSourceAudio(seq, start, item) {
    var key = _orbitMontageItemKey(item), removed = 0;
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        var track = seq.audioTracks[t], count = track.clips.numItems;
        for (var i = count - 1; i >= 0; i--) {
            var clip = track.clips[i], cs = NaN, same = false;
            try { cs = Number(clip.start.seconds); } catch (_) {}
            if (isNaN(cs) || Math.abs(cs - start) > .08) continue;
            try { same = clip.projectItem && _orbitMontageItemKey(clip.projectItem) === key; } catch (_) {}
            if (!same) continue;
            try { clip.remove(false, false); removed++; } catch (_) {}
        }
    }
    return removed;
}

function beatBuildMontage(timesJSON, optionsJSON) {
    var undoOpen = false;
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'Open an active sequence first.' });
        var opts = JSON.parse(optionsJSON || '{}');
        var sources = _orbitMontageSources();
        if (!sources.length) return JSON.stringify({ error: 'Select supported video/image clips or a bin in the Project panel, then Refresh sources.' });
        var mode = String(opts.mode || 'beat'), rawTimes = JSON.parse(timesJSON || '[]');
        if (mode === 'markers') rawTimes = _orbitMontageMarkerTimes(seq);
        if (mode === 'beat' && !rawTimes.length) return JSON.stringify({ error: 'Analyze music and select at least one beat first.' });
        if (mode === 'markers' && !rawTimes.length) return JSON.stringify({ error: 'No sequence markers were found.' });

        var total = Number(opts.durationSec) || 0;
        if (!(total > 0) && mode === 'markers') {
            var mt = _orbitMontageUniqueTimes(rawTimes);
            total = mt.length > 1 ? (mt[mt.length - 1] - mt[0]) + Math.max(.1, Number(opts.maxShot) || 4) : Math.max(.1, Number(opts.maxShot) || 4);
        }
        if (!(total > 0)) return JSON.stringify({ error: 'Enter Total duration or analyze the music track first.' });
        var boundaries = _orbitMontageBoundaries(rawTimes, opts, total);
        if (boundaries.length < 2) return JSON.stringify({ error: 'The edit points do not create a usable montage plan.' });

        var targetNo = Math.max(1, parseInt(opts.targetTrack, 10) || 2), targetIndex = targetNo - 1;
        if (seq.videoTracks.numTracks <= targetIndex) _addVideoTracks(seq, targetIndex - seq.videoTracks.numTracks + 1);
        if (seq.videoTracks.numTracks <= targetIndex) return JSON.stringify({ error: 'Could not create or access target track V' + targetNo + '.' });
        var track = seq.videoTracks[targetIndex];
        var playhead = 0;
        try { playhead = _orbitMontageTimeSeconds(seq.getPlayerPosition()); } catch (_) {}
        var timelineStart = opts.startAtPlayhead === false ? 0 : Math.max(0, playhead);
        var plannedEnd = timelineStart + total;
        if (!opts.allowOverwrite && _orbitMontageTrackCollision(track, timelineStart, plannedEnd)) {
            return JSON.stringify({ error: 'V' + targetNo + ' already contains clips in the montage range. Choose another track or enable Allow replacing clips.' });
        }

        var backupCreated = false;
        if (opts.safetyCopy !== false) {
            try { if (seq.clone) { seq.clone(); backupCreated = true; try { seq.open(); } catch (_) {} } } catch (_) {}
        }
        var seedRef = { value: Math.abs(parseInt(opts.seed, 10) || 1337) >>> 0 };
        if (String(opts.order || 'sequential') === 'shuffle') sources = _orbitMontageShuffle(sources, seedRef);
        var repeat = opts.repeat !== false, keepAudio = opts.keepSourceAudio === true;
        var created = 0, skipped = 0, removedAudio = 0, inserted = [], errors = [];
        try { app.beginUndoGroup('CompX Orbit - Auto Montage'); undoOpen = true; } catch (_) {}

        for (var i = 0; i < boundaries.length - 1; i++) {
            if (!repeat && i >= sources.length) break;
            var item = sources[i % sources.length];
            var shotStart = timelineStart + boundaries[i], shotDuration = boundaries[i + 1] - boundaries[i];
            if (!(shotDuration > .04)) { skipped++; continue; }
            var range = _orbitMontageSourceRange(item), sourceIn = range.inSec;
            if (String(opts.sourceStart || 'random') === 'random' && range.duration > shotDuration + .04) {
                sourceIn = range.inSec + _orbitMontageRandom(seedRef) * (range.duration - shotDuration);
            }
            var sourceOut = sourceIn + shotDuration;
            if (range.outSec > range.inSec && sourceOut > range.outSec) {
                sourceOut = range.outSec;
                sourceIn = Math.max(range.inSec, sourceOut - shotDuration);
            }
            var pointsReady = _orbitMontageSetPoint(item, 'setInPoint', sourceIn) && _orbitMontageSetPoint(item, 'setOutPoint', sourceOut);
            try {
                track.overwriteClip(item, shotStart);
                var placed = _orbitMontageFindClip(track, shotStart, item);
                if (placed) { _orbitMontageSetClipEnd(placed, shotStart + shotDuration); inserted.push(placed); created++; }
                else { skipped++; errors.push('Could not verify clip ' + (i + 1) + ' after insertion.'); }
                if (!keepAudio) removedAudio += _orbitMontageRemoveSourceAudio(seq, shotStart, item);
            } catch (insertError) {
                skipped++;
                errors.push('Clip ' + (i + 1) + ': ' + insertError.message + (pointsReady ? '' : ' (source in/out unavailable)'));
            }
            _orbitMontageRestoreRange(item, range);
        }

        var transitions = 0, transitionName = String(opts.transition || '');
        if (transitionName && inserted.length > 1) {
            try {
                app.enableQE();
                var qeSeq = qe.project.getActiveSequence(), tx = _composerTransitionByName(transitionName);
                var duration = _composerTimecodeFrames(Math.max(1, Number(opts.transitionFrames) || 6), _composerFps(seq));
                if (qeSeq && tx) for (var q = 1; q < inserted.length; q++) {
                    var qeClip = _composerFindQeClip(inserted[q], qeSeq);
                    if (qeClip) try { qeClip.addTransition(tx, true, duration); transitions++; } catch (_) {}
                }
            } catch (_) {}
        }
        if (undoOpen) { try { app.endUndoGroup(); } catch (_) {} undoOpen = false; }
        return JSON.stringify({
            ok: created > 0,
            created: created,
            skipped: skipped,
            errors: errors.slice(0, 12),
            targetTrack: targetNo,
            backupCreated: backupCreated,
            removedAudio: removedAudio,
            transitions: transitions,
            duration: total
        });
    } catch (e) {
        if (undoOpen) try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'beatBuildMontage: ' + e.message });
    }
}


/** Stable, uniquely named track discovery endpoint used by Smart Jump Cut. */
function orbitGetTrackList() {
    try {
        if (!app.project || !app.project.activeSequence) {
            return JSON.stringify({ error: 'No active sequence. Open a sequence and try Refresh Tracks.' });
        }
        var seq = app.project.activeSequence;
        var tracks = [];
        var v, a, count;
        for (v = 0; v < seq.videoTracks.numTracks; v++) {
            count = 0;
            try { count = seq.videoTracks[v].clips.numItems; } catch (_) {}
            if (count > 0) tracks.push({ type: 'video', index: v, name: 'V' + (v + 1), clips: count });
        }
        for (a = 0; a < seq.audioTracks.numTracks; a++) {
            count = 0;
            try { count = seq.audioTracks[a].clips.numItems; } catch (_) {}
            if (count > 0) tracks.push({ type: 'audio', index: a, name: 'A' + (a + 1), clips: count });
        }
        return JSON.stringify({ ok: true, sequenceName: seq.name || 'Active sequence', tracks: tracks });
    } catch (e) {
        return JSON.stringify({ error: 'Track detection failed: ' + e.message });
    }
}

function smartAutoReframe(ratioStr, focusStr) {
    try {
        var seq=getActiveSequence(); if(!seq)return JSON.stringify({error:'No active sequence.'});
        var dims={'9:16':[1080,1920],'1:1':[1080,1080],'4:5':[1080,1350],'16:9':[1920,1080]},target=dims[ratioStr]||dims['9:16'];
        var selected=[];try{selected=seq.getSelection();}catch(_e3){} if(!selected.length)return JSON.stringify({error:'Select one or more video clips first. No sequence settings were changed.'});
        var oldW=1920,oldH=1080,settings=null; try{settings=seq.getSettings();oldW=Number(settings.videoFrameWidth)||oldW;oldH=Number(settings.videoFrameHeight)||oldH;}catch(_e){}
        if(!settings||!seq.setSettings)return JSON.stringify({error:'This Premiere version does not expose editable sequence settings; no changes were made.'});
        try{settings.videoFrameWidth=target[0];settings.videoFrameHeight=target[1];seq.setSettings(settings);}catch(_e2){return JSON.stringify({error:'Premiere rejected the target sequence size; no clip framing was changed.'});}
        var factor=Math.max(target[0]/oldW,target[1]/oldH),focusX=focusStr==='left'?0.35:(focusStr==='right'?0.65:0.5),applied=0;
        try{app.beginUndoGroup('CompX Orbit - Auto Reframe');}catch(_e4){}
        for(var i=0;i<selected.length;i++){var changed=false,scale=motionFindParam(selected[i],'scale'),pos=motionFindParam(selected[i],'position');if(scale){try{var sv=Number(scale.getValue());if(!(sv>0))sv=100;scale.setValue(Math.round(sv*factor*100)/100,true);changed=true;}catch(_e5){}}if(pos){try{pos.setValue([focusX,0.5],true);changed=true;}catch(_e6){}}if(changed)applied++;}
        try{app.endUndoGroup();}catch(_e7){} return JSON.stringify({ok:true,applied:applied,ratio:ratioStr,width:target[0],height:target[1]});
    }catch(e){return JSON.stringify({error:'smartAutoReframe: '+e.message});}
}

function audioApplyAutoMix(roleStr) {
    try {
        var seq=getActiveSequence();if(!seq)return JSON.stringify({error:'No active sequence.'});var dbMap={voice:-6,music:-18,sfx:-12},db=dbMap.hasOwnProperty(roleStr)?dbMap[roleStr]:-6;
        var selected=[];try{selected=seq.getSelection();}catch(_e){}if(!selected.length)return JSON.stringify({error:'Select one or more audio clips first.'});
        var candidates=[],seen={};function add(item){if(!item)return;var k='';try{k=String(item.nodeId||item.start.ticks||candidates.length);}catch(_x){k=String(candidates.length);}if(!seen[k]){seen[k]=1;candidates.push(item);}}
        for(var i=0;i<selected.length;i++){add(selected[i]);var ss=0,se=0;try{ss=Number(selected[i].start.seconds);se=Number(selected[i].end.seconds);}catch(_e2){}for(var t=0;t<seq.audioTracks.numTracks;t++){var tr=seq.audioTracks[t];for(var c=0;c<tr.clips.numItems;c++){var ac=tr.clips[c],as=Number(ac.start.seconds),ae=Number(ac.end.seconds);if(Math.abs(as-ss)<0.02&&Math.abs(ae-se)<0.02)add(ac);}}}
        var applied=0;try{app.beginUndoGroup('CompX Orbit - Audio Auto Mix');}catch(_e3){}
        for(i=0;i<candidates.length;i++){var item=candidates[i],comps=item.components,done=false,cn=comps?(comps.numItems||comps.length||0):0;for(var ci=0;ci<cn&&!done;ci++){var comp=comps[ci],compName=String(comp.displayName||comp.name||comp.matchName||'').toLowerCase();if(compName!=='volume'&&compName!=='audio volume')continue;var props=comp.properties||comp.parameters,pn=props?(props.numItems||props.length||0):0;for(var pi=0;pi<pn;pi++){var p=props[pi],name=String(p.displayName||p.name||p.matchName||'').toLowerCase();if(name==='level'||name==='volume level'){try{if(compxSetPropertyValue(p,db)){applied++;done=true;}}catch(_e4){}break;}}}}
        try{app.endUndoGroup();}catch(_e5){}if(!applied)return JSON.stringify({error:'No adjustable Volume > Level property found on the selected clips.'});return JSON.stringify({ok:true,applied:applied,role:roleStr,db:db});
    }catch(e){return JSON.stringify({error:'audioApplyAutoMix: '+e.message});}
}

// ════════════════════════════════════════════════════════════════════════════
// Orbit Project Doctor — read-only project/sequence inspection + safe actions.
// Scanner checks intentionally avoid subjective edit decisions. Mutations are
// limited to project save, issue markers and playhead navigation.
// ════════════════════════════════════════════════════════════════════════════

function _pdSeconds(value) {
    try { return Number(value.seconds); } catch (_) {}
    try { return Number(value.ticks) / 254016000000; } catch (_2) {}
    return NaN;
}

function projectDoctorScan() {
    try {
        if (!app || !app.project) return JSON.stringify({ error: 'Open a Premiere project first.' });
        var project = app.project;
        var seq = project.activeSequence;
        if (!seq) return JSON.stringify({ error: 'Open an active sequence before scanning.' });

        var issues = [], issueNo = 0, MAX_ISSUES = 250;
        var counts = { critical: 0, warning: 0, info: 0 };
        function add(severity, category, title, detail, time, track, fix) {
            if (issues.length >= MAX_ISSUES) return;
            severity = severity === 'critical' ? 'critical' : (severity === 'warning' ? 'warning' : 'info');
            counts[severity]++;
            issues.push({
                id: 'pd-' + (++issueNo), severity: severity, category: String(category || 'general'),
                title: String(title || 'Project issue'), detail: String(detail || ''),
                time: typeof time === 'number' && !isNaN(time) ? time : null,
                track: String(track || ''), fix: String(fix || '')
            });
        }

        var projectPath = '';
        try { projectPath = String(project.path || ''); } catch (_) {}
        if (!projectPath) add('warning', 'project', 'Project has not been saved', 'Save the project before running timeline mutations or creating deliverables.', null, '', 'save-project');

        var width = 0, height = 0, fps = 0;
        try {
            var settings = seq.getSettings ? seq.getSettings() : null;
            if (settings) {
                width = Number(settings.videoFrameWidth || settings.frameSizeHorizontal || 0);
                height = Number(settings.videoFrameHeight || settings.frameSizeVertical || 0);
            }
        } catch (_) {}
        try { if (!width) width = Number(seq.frameSizeHorizontal || 0); } catch (_) {}
        try { if (!height) height = Number(seq.frameSizeVertical || 0); } catch (_) {}
        try { fps = 254016000000 / parseInt(seq.timebase, 10); } catch (_) {}
        if (!(fps > 0)) fps = 30;
        fps = Math.round(fps * 1000) / 1000;
        if (!(width > 0 && height > 0)) add('critical', 'sequence', 'Invalid sequence frame size', 'Premiere did not return usable sequence dimensions.', null, '');
        else {
            if (width % 2 || height % 2) add('warning', 'sequence', 'Odd sequence dimensions', width + '×' + height + ' can cause encoder compatibility problems.', null, '');
            if (width < 640 || height < 360) add('warning', 'sequence', 'Very small sequence frame', width + '×' + height + ' may be unsuitable for final delivery.', null, '');
        }
        if (fps < 10 || fps > 120) add('critical', 'sequence', 'Unusual frame rate', fps + ' fps is outside the normal editing range.', null, '');

        var stats = {
            videoTracks: 0, audioTracks: 0, videoClips: 0, audioClips: 0,
            emptyVideoTracks: 0, emptyAudioTracks: 0, mutedTracks: 0,
            offlineMedia: 0, disabledClips: 0, flashFrames: 0, gaps: 0,
            markers: 0, duration: 0, projectItems: 0, bins: 0, sequences: 0
        };
        try { stats.videoTracks = seq.videoTracks.numTracks; } catch (_) {}
        try { stats.audioTracks = seq.audioTracks.numTracks; } catch (_) {}
        try { stats.sequences = project.sequences.numSequences; } catch (_) {}

        var offlineSeen = {}, timelineOfflineSeen = {}, maxEnd = 0;
        function offlineKey(item) {
            var key = '';
            try { key = String(item.nodeId || ''); } catch (_) {}
            if (!key) try { key = String(item.getMediaPath ? item.getMediaPath() : ''); } catch (_) {}
            if (!key) try { key = String(item.name || ''); } catch (_) {}
            return key || ('offline-' + issueNo);
        }
        function clipName(clip) {
            try { return String(clip.name || (clip.projectItem && clip.projectItem.name) || 'Unnamed clip'); } catch (_) { return 'Unnamed clip'; }
        }
        function trackName(track, prefix, index) {
            var name = '';
            try { name = String(track.name || ''); } catch (_) {}
            return name || (prefix + (index + 1));
        }
        var primaryVideoScanned = false;
        function scanTracks(tracks, kind) {
            var total = 0;
            try { total = tracks.numTracks; } catch (_) {}
            for (var ti = 0; ti < total; ti++) {
                var track = tracks[ti], clips = [], num = 0, label = trackName(track, kind === 'video' ? 'V' : 'A', ti);
                try { num = track.clips.numItems; } catch (_) {}
                if (kind === 'video') stats.videoClips += num; else stats.audioClips += num;
                if (!num) {
                    if (kind === 'video') stats.emptyVideoTracks++; else stats.emptyAudioTracks++;
                }
                var muted = false;
                try { muted = !!(track.isMuted && track.isMuted()); } catch (_) {}
                if (muted && num) { stats.mutedTracks++; add('info', 'timeline', 'Track is muted', label + ' contains ' + num + ' clip(s) but is muted.', null, label); }

                for (var ci = 0; ci < num; ci++) {
                    var clip = track.clips[ci], start = NaN, end = NaN;
                    try { start = _pdSeconds(clip.start); end = _pdSeconds(clip.end); } catch (_) {}
                    if (!isNaN(end)) maxEnd = Math.max(maxEnd, end);
                    clips.push({ clip: clip, start: start, end: end, name: clipName(clip) });
                    if (isNaN(start) || isNaN(end) || end <= start) {
                        add('critical', 'timeline', 'Invalid clip duration', clipName(clip) + ' has a zero, negative or unreadable duration.', isNaN(start) ? null : start, label);
                    } else if (kind === 'video' && (end - start) < (2.1 / fps)) {
                        stats.flashFrames++;
                        add('warning', 'timeline', 'Possible flash frame', clipName(clip) + ' is shorter than roughly two frames.', start, label);
                    }
                    var disabled = false;
                    try { disabled = clip.disabled === true; } catch (_) {}
                    if (disabled) {
                        stats.disabledClips++;
                        add('info', 'timeline', 'Disabled timeline clip', clipName(clip) + ' is disabled and will not appear in the final output.', start, label);
                    }
                    var pi = null, offline = false;
                    try { pi = clip.projectItem; } catch (_) {}
                    if (!pi) add('critical', 'media', 'Clip has no project item', clipName(clip) + ' is detached from its project source.', start, label);
                    else {
                        try { offline = !!(pi.isOffline && pi.isOffline()); } catch (_) {}
                        if (offline) {
                            var key = offlineKey(pi);
                            offlineSeen[key] = true;
                            if (!timelineOfflineSeen[key]) {
                                timelineOfflineSeen[key] = true;
                                add('critical', 'media', 'Offline media', clipName(clip) + ' must be relinked before export.', start, label);
                            }
                        }
                    }
                }
                clips.sort(function (a, b) { return a.start - b.start; });
                if (kind === 'video' && num && !primaryVideoScanned) {
                    primaryVideoScanned = true;
                    // Only the lowest occupied video track is treated as the
                    // primary story track; overlay-track gaps are intentional.
                    for (var gi = 1; gi < clips.length; gi++) {
                        var previous = clips[gi - 1], current = clips[gi];
                        var gap = current.start - previous.end;
                        if (gap > Math.max(0.08, 2 / fps)) {
                            stats.gaps++;
                            add('warning', 'timeline', 'Gap on primary video track', gap.toFixed(2) + ' seconds of empty timeline between ' + previous.name + ' and ' + current.name + '.', previous.end, label);
                        }
                    }
                }
            }
        }
        scanTracks(seq.videoTracks, 'video');
        scanTracks(seq.audioTracks, 'audio');
        stats.duration = Math.round(maxEnd * 1000) / 1000;
        if (!stats.videoClips && !stats.audioClips) add('warning', 'timeline', 'Sequence is empty', 'The active sequence contains no timeline clips.', null, '');
        if (stats.emptyVideoTracks + stats.emptyAudioTracks > 2) add('info', 'timeline', 'Several empty tracks', (stats.emptyVideoTracks + stats.emptyAudioTracks) + ' empty tracks add clutter to the sequence.', null, '');
        if (stats.videoTracks > 16 || stats.audioTracks > 24) add('info', 'timeline', 'High track count', stats.videoTracks + ' video and ' + stats.audioTracks + ' audio tracks may make the sequence harder to maintain.', null, '');
        if (stats.duration > 21600) add('warning', 'sequence', 'Very long sequence', 'The active sequence is longer than six hours.', null, '');

        try {
            var marker = seq.markers.getFirstMarker();
            while (marker) { stats.markers++; marker = seq.markers.getNextMarker(marker); }
        } catch (_) {}

        var visited = 0, projectOfflineNames = [], WALK_LIMIT = 5000;
        function walk(bin) {
            if (!bin || visited >= WALK_LIMIT) return;
            var count = 0;
            try { count = bin.children.numItems; } catch (_) { return; }
            for (var i = 0; i < count && visited < WALK_LIMIT; i++) {
                var item = bin.children[i]; visited++; stats.projectItems++;
                var childCount = -1;
                try { childCount = item.children.numItems; } catch (_) {}
                if (childCount >= 0) { stats.bins++; walk(item); continue; }
                var itemOffline = false;
                try { itemOffline = !!(item.isOffline && item.isOffline()); } catch (_) {}
                if (itemOffline) {
                    var itemKey = offlineKey(item); offlineSeen[itemKey] = true;
                    if (projectOfflineNames.length < 8) {
                        try { projectOfflineNames.push(String(item.name || 'Offline item')); } catch (_) {}
                    }
                }
            }
        }
        try { walk(project.rootItem); } catch (_) {}
        for (var offlineId in offlineSeen) if (offlineSeen.hasOwnProperty(offlineId)) stats.offlineMedia++;
        var timelineOfflineCount = 0;
        for (var timelineOfflineId in timelineOfflineSeen) if (timelineOfflineSeen.hasOwnProperty(timelineOfflineId)) timelineOfflineCount++;
        if (stats.offlineMedia > timelineOfflineCount) {
            add('critical', 'media', 'Offline items elsewhere in project', stats.offlineMedia + ' offline project item(s) detected. Examples: ' + projectOfflineNames.join(', '), null, '');
        }
        if (visited >= WALK_LIMIT) add('info', 'project', 'Large project scan limited', 'Project item inspection stopped after ' + WALK_LIMIT + ' items to keep Premiere responsive.', null, '');

        var score = 100 - Math.min(60, counts.critical * 18) - Math.min(32, counts.warning * 6) - Math.min(10, counts.info);
        if (score < 0) score = 0;
        return JSON.stringify({
            ok: true, version: 1, score: score, counts: counts, issues: issues,
            sequence: { name: String(seq.name || 'Untitled Sequence'), width: width, height: height, fps: fps, duration: stats.duration },
            project: { name: String(project.name || 'Untitled Project'), path: projectPath, saved: !!projectPath },
            stats: stats, truncated: issues.length >= MAX_ISSUES
        });
    } catch (e) {
        return JSON.stringify({ error: 'projectDoctorScan: ' + e.message });
    }
}

function projectDoctorAction(action, payloadJson) {
    try {
        if (!app || !app.project) return JSON.stringify({ error: 'Open a Premiere project first.' });
        var seq = app.project.activeSequence;
        if (action === 'save-project') {
            if (!app.project.save) return JSON.stringify({ error: 'Project save is unavailable in this Premiere version.' });
            app.project.save();
            return JSON.stringify({ ok: true, saved: true, message: 'Project saved.' });
        }
        if (!seq) return JSON.stringify({ error: 'Open an active sequence first.' });
        if (action === 'go-to') {
            var target = Number(payloadJson || 0);
            if (isNaN(target) || target < 0) return JSON.stringify({ error: 'Invalid issue time.' });
            if (!seq.setPlayerPosition) return JSON.stringify({ error: 'Playhead navigation is unavailable in this Premiere version.' });
            seq.setPlayerPosition(secondsToTicks(target));
            return JSON.stringify({ ok: true, time: target });
        }
        if (action === 'mark-issues') {
            var payload = JSON.parse(payloadJson || '[]');
            var existing = {}, current = null;
            try {
                current = seq.markers.getFirstMarker();
                while (current) {
                    var existingName = '', existingTime = 0;
                    try { existingName = String(current.name || ''); } catch (_) {}
                    try { existingTime = Math.round(Number(current.start.seconds) * 1000); } catch (_) {}
                    existing[existingName + '|' + existingTime] = true;
                    current = seq.markers.getNextMarker(current);
                }
            } catch (_) {}
            var marked = 0, skipped = 0, limit = Math.min(payload.length || 0, 150);
            try { app.beginUndoGroup('Orbit Doctor - Add Issue Markers'); } catch (_) {}
            for (var i = 0; i < limit; i++) {
                var issue = payload[i], seconds = Number(issue.time);
                if (isNaN(seconds) || seconds < 0) { skipped++; continue; }
                var markerName = 'Orbit Doctor · ' + String(issue.title || 'Issue');
                var key = markerName + '|' + Math.round(seconds * 1000);
                if (existing[key]) { skipped++; continue; }
                try {
                    var created = seq.markers.createMarker(seconds);
                    created.name = markerName;
                    created.comments = String(issue.detail || '') + (issue.track ? '\nTrack: ' + issue.track : '');
                    try { if (created.setColorByIndex) created.setColorByIndex(issue.severity === 'critical' ? 1 : (issue.severity === 'warning' ? 3 : 4)); } catch (_) {}
                    existing[key] = true; marked++;
                } catch (_) { skipped++; }
            }
            try { app.endUndoGroup(); } catch (_) {}
            return JSON.stringify({ ok: true, marked: marked, skipped: skipped, message: marked + ' issue marker(s) added.' });
        }
        return JSON.stringify({ error: 'Unknown Project Doctor action.' });
    } catch (e) {
        try { app.endUndoGroup(); } catch (_) {}
        return JSON.stringify({ error: 'projectDoctorAction: ' + e.message });
    }
}

function getTimelineVideoMediaWindow() {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var start = 0, end = 0;
        try { end = Number(seq.end.seconds) || 0; } catch (_) {}
        if (seq.videoTracks && seq.videoTracks.numTracks) {
            for (var ti = 0; ti < seq.videoTracks.numTracks; ti++) {
                var tr = seq.videoTracks[ti];
                for (var ci = 0; ci < tr.clips.numItems; ci++) {
                    try {
                        var clip = tr.clips[ci];
                        var cs = Number(clip.start.seconds) || 0;
                        var ce = Number(clip.end.seconds) || 0;
                        if (!start || cs < start) start = cs;
                        if (ce > end) end = ce;
                    } catch (_) {}
                }
            }
        }
        if (!(end > start)) {
            try { start = 0; end = Number(seq.end.seconds) || 0; } catch (_) {}
        }
        return JSON.stringify({ ok: true, start: start, end: end });
    } catch (e) {
        return JSON.stringify({ error: 'getTimelineVideoMediaWindow: ' + e.message });
    }
}

function setCaptionTracksMuted(flagStr) {
    try {
        var seq = getActiveSequence();
        if (!seq) return JSON.stringify({ error: 'No active sequence.' });
        var mute = String(flagStr) === 'true';
        var changed = 0;
        for (var i = 0; i < seq.videoTracks.numTracks; i++) {
            try {
                var tr = seq.videoTracks[i];
                var hit = false;
                for (var c = 0; c < tr.clips.numItems; c++) {
                    var name = '';
                    try { name = String(tr.clips[c].projectItem ? tr.clips[c].projectItem.name : tr.clips[c].name || '').toLowerCase(); } catch (_) {}
                    if (name.indexOf('caption') >= 0 || name.indexOf('machicut') >= 0 || name.indexOf('compx') >= 0) { hit = true; break; }
                }
                if (hit) {
                    try { tr.setMute(mute); changed++; } catch (_) {}
                }
            } catch (_) {}
        }
        return JSON.stringify({ ok: true, changed: changed, muted: mute });
    } catch (e) {
        return JSON.stringify({ error: 'setCaptionTracksMuted: ' + e.message });
    }
}

function replaceModel4CaptionClips(clipsJsonStr, seqName, capIndexStr, pinnedSeqId, animateStr, numCurTracksStr, animTypeStr, animBoxTypeStr) {
    return buildAndPlaceModel4Captions(clipsJsonStr, seqName, capIndexStr, pinnedSeqId, animateStr, numCurTracksStr, animTypeStr, animBoxTypeStr);
}
