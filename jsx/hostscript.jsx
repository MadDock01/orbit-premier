// CompX Orbit Premiere - Host script (ExtendScript, Premiere Pro only)

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
function getActiveComp() {
  var proj = app.project;
  if (!proj) return null;
  var item = proj.activeItem;
  if (item && item instanceof CompItem) return item;
  return null;
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

// ── MachiCut session cleanup ──────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════
// Motion 3D tool — media-in from the project, sequence spec, clip placement.
// The panel renders the animation to a ProRes 4444 (alpha) .mov; these
// three functions feed it source media and drop the result on the timeline.
// ═══════════════════════════════════════════════════════════════════════

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
