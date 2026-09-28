/**
 * ffmpegLocal.js — Direct FFmpeg orchestration inside the CEP panel.
 *
 * Replaces the old node/ sidecar HTTP server. CEP panels run in Chromium
 * with Node.js integration enabled, so we can require('child_process')
 * and spawn FFmpeg subprocesses straight from the panel — no HTTP, no
 * port management, no second process to babysit, no compiled exe to
 * keep in sync with source.
 *
 * Public surface lives on `global.FFmpegAPI`, identical to the old
 * HTTP-backed module so call sites (silenceCutter, autoCaptions, etc.)
 * don't need to know the implementation changed.
 */

(function (global) {
  'use strict';

  // CEP exposes Node via the standard `require`. Bail out gracefully
  // if we somehow run outside CEP (e.g. opening the HTML in a plain
  // browser for layout testing).
  var _req = (typeof require !== 'undefined') ? require
           : (typeof window !== 'undefined' && window.require) ? window.require
           : null;
  if (!_req) {
    global.FFmpegAPI = {
      _disabled: 'Node integration unavailable (not running inside CEP).'
    };
    return;
  }
  var _cp       = _req('child_process');
  var spawn     = _cp.spawn;
  var spawnSync = _cp.spawnSync;
  var fs    = _req('fs');
  var path  = _req('path');
  var os    = _req('os');
  var _crypto = (function () { try { return _req('crypto'); } catch (_) { return null; } })();
  var _isMac = (typeof process !== 'undefined' && process.platform === 'darwin');

  // ── Device fingerprint ────────────────────────────────────────────────
  // Hashed, stable-per-machine id so the freemium one-time free allowance
  // is metered per DEVICE (a desktop-plugin advantage: multiple emails on
  // one machine can't multiply free minutes). Prefers the OS machine GUID
  // (Windows registry MachineGuid / macOS IOPlatformUUID); falls back to
  // hostname + primary MAC + user. Only a hash ever leaves the machine.
  var _cachedDeviceId = null;
  function _machineGuid() {
    // Use ABSOLUTE binary paths — Node's execSync goes through cmd.exe/sh
    // whose PATH may not include System32 / usr/sbin in the CEP host, so a
    // bare `reg`/`ioreg` can fail with "not recognized". Absolute paths
    // remove that dependency; failure still degrades to the MAC fallback.
    try {
      if (process.platform === 'win32') {
        var regExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\reg.exe';
        var out = _cp.execSync(
          '"' + regExe + '" query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
          { timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        var m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
        return m ? m[1] : '';
      }
      if (process.platform === 'darwin') {
        var out2 = _cp.execSync('/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice', {
          timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        var m2 = out2.match(/IOPlatformUUID"\s*=\s*"([\w-]+)"/);
        return m2 ? m2[1] : '';
      }
    } catch (_) {}
    return '';
  }
  function getDeviceId() {
    if (_cachedDeviceId) return _cachedDeviceId;
    var parts = [];
    try { parts.push(os.hostname()); } catch (_) {}
    try { parts.push(os.platform() + '/' + os.arch()); } catch (_) {}
    try { parts.push(os.userInfo().username); } catch (_) {}
    var guid = _machineGuid();
    if (guid) {
      parts.push('guid:' + guid);
    } else {
      // Fallback: first stable non-internal MAC (sorted → order-stable).
      try {
        var ifs = os.networkInterfaces(); var macs = [];
        Object.keys(ifs).forEach(function (k) {
          (ifs[k] || []).forEach(function (ni) {
            if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') macs.push(ni.mac);
          });
        });
        macs.sort();
        if (macs.length) parts.push('mac:' + macs[0]);
      } catch (_) {}
    }
    var raw = parts.join('|') || ('fallback:' + Math.random());
    if (_crypto && _crypto.createHash) {
      _cachedDeviceId = _crypto.createHash('sha256').update(raw).digest('hex');
    } else {
      // Extremely unlikely (crypto missing) — degrade to a non-hashed but
      // still opaque-ish token so the field is never empty.
      _cachedDeviceId = 'nohash-' + encodeURIComponent(raw).slice(0, 64);
    }
    return _cachedDeviceId;
  }

  // ── Config ────────────────────────────────────────────────────────────
  // The Modal endpoint that runs Whisper. Mirrored from the old server.js
  // — change in modal/app.py + deploy, then update here.
  var MODAL_ENDPOINT_URL =
    'https://abdessamedbouazza--autoedit-whisper-transcriber-transcribe.modal.run';

  // ── FFmpeg binary resolution ──────────────────────────────────────────
  // Resolution order:
  //   1) Explicit override from Settings (localStorage).
  //   2) `<extensionPath>/lib/ffmpeg(.exe)` — the canonical bundled
  //      location (post-sidecar drop).
  //   3) `<extensionPath>/node/ffmpeg(.exe)` — legacy bundled location,
  //      kept as a fallback so a half-migrated install still works.
  //   4) Well-known macOS package-manager locations. Adobe CEP does not
  //      inherit the user's interactive shell PATH, so Homebrew/MacPorts
  //      installs are otherwise invisible even though they work in Terminal.
  //   5) System PATH `ffmpeg`.
  function _extensionPath() {
    try {
      if (typeof CSInterface !== 'undefined') {
        return new CSInterface().getSystemPath('extension');
      }
    } catch (_) {}
    return '';
  }
  function _ffmpegName() {
    if (process.platform === 'darwin') {
      return process.arch === 'x64' ? 'ffmpeg-x64' : 'ffmpeg';
    }
    return 'ffmpeg.exe';
  }
  var _cachedFfmpegPath = null;
  var _lastResolveTried = [];   // for diagnostics in the not-found error

  function _rememberCandidate(candidate) {
    if (!candidate || _lastResolveTried.indexOf(candidate) !== -1) return;
    _lastResolveTried.push(candidate);
  }

  function _existingFile(candidate) {
    if (!candidate) return false;
    try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); }
    catch (_) { return false; }
  }

  function resolveFFmpeg() {
    if (_cachedFfmpegPath && _existingFile(_cachedFfmpegPath)) return _cachedFfmpegPath;

    // 1) User override
    try {
      var override = (typeof localStorage !== 'undefined')
        ? (localStorage.getItem('machicut_ffmpeg_path') || '')
        : '';
      if (override && _existingFile(override)) {
        _cachedFfmpegPath = override;
        return override;
      }
    } catch (_) {}

    // 2) Bundled binary. getSystemPath('extension') returns the extension
    //    ROOT (the folder holding CSXS/, client/, host/ — confirmed by the
    //    updater unzipping patches into it), so the binary is at
    //    <root>/client/lib/<name>. We ALSO check <root>/lib and the legacy
    //    node/ locations so this is robust whether the host reports the
    //    root or the client folder as the extension path — the old code
    //    only checked <root>/lib and silently fell through to system
    //    ffmpeg, which is why Mac (no system ffmpeg) showed "not found".
    var name = _ffmpegName();
    var ext  = _extensionPath();
    _lastResolveTried = [];
    if (ext) {
      var candidates = [
        path.join(ext, 'client', 'lib',  name),
        path.join(ext, 'lib',            name),
        path.join(ext, 'client', 'node', name),
        path.join(ext, 'node',           name)
      ];
      for (var i = 0; i < candidates.length; i++) {
        _rememberCandidate(candidates[i]);
        if (_existingFile(candidates[i])) {
          _cachedFfmpegPath = candidates[i];
          return candidates[i];
        }
      }
    } else {
      _rememberCandidate('(extension path unavailable)');
    }

    // CEP is launched by Premiere rather than the user's shell. On macOS its
    // PATH commonly omits both Apple Silicon (/opt/homebrew) and Intel
    // (/usr/local) Homebrew prefixes. Probe those absolute locations before
    // falling back to PATH so an already-installed FFmpeg is actually found.
    if (_isMac) {
      var macCandidates = [];
      try {
        if (process.env.HOMEBREW_PREFIX) {
          macCandidates.push(path.join(process.env.HOMEBREW_PREFIX, 'bin', 'ffmpeg'));
        }
      } catch (_) {}
      macCandidates.push(
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/opt/local/bin/ffmpeg'
      );
      for (var m = 0; m < macCandidates.length; m++) {
        _rememberCandidate(macCandidates[m]);
        if (_existingFile(macCandidates[m])) {
          _cachedFfmpegPath = macCandidates[m];
          return macCandidates[m];
        }
      }
    }

    // Last resort — system PATH.
    _rememberCandidate('ffmpeg (CEP PATH)');
    return 'ffmpeg';
  }

  function _isBundledFFmpeg(bin) {
    if (!bin || bin === 'ffmpeg') return false;
    var ext = _extensionPath();
    if (!ext) return false;
    try {
      var rel = path.relative(path.resolve(ext), path.resolve(bin));
      return rel !== '' && rel !== '..' && rel.indexOf('..' + path.sep) !== 0 && !path.isAbsolute(rel);
    } catch (_) { return false; }
  }

  // ── macOS self-heal ───────────────────────────────────────────────────
  // The bundled ffmpeg is delivered via a .pkg whose postinstall is
  // supposed to strip the Gatekeeper quarantine xattr and ad-hoc
  // re-codesign the binary. If that step didn't run (or the user got
  // ffmpeg into a bad state some other way), Gatekeeper SIGKILLs the
  // process the instant it spawns — silently, from the panel's point of
  // view. This makes the binary runnable from inside the plugin itself:
  // clear the quarantine, restore the exec bit, and re-apply an ad-hoc
  // signature. Runs at most once per binary per session.
  var _healedBins = {};
  function _healMacBinary(bin) {
    if (!_isMac || !bin || _healedBins[bin]) return false;
    _healedBins[bin] = true;
    try { fs.chmodSync(bin, 0o755); } catch (_) {}
    // These are best-effort; ignore individual failures. `spawnSync`
    // with a short timeout so a hung tool can't wedge the panel.
    var opts = { timeout: 8000, windowsHide: true };
    try { spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bin], opts); } catch (_) {}
    // Keep a valid Developer ID signature intact. Only add an ad-hoc
    // signature when the packaged binary is actually unsigned/invalid.
    try {
      var verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', bin], opts);
      if (!verified || verified.status !== 0) {
        spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', bin], opts);
      }
    } catch (_) {}
    return true;
  }

  // ── Subprocess helper ─────────────────────────────────────────────────
  // Spawns ffmpeg with the given args. RESOLVES only on a clean exit
  // (code 0). Any non-zero exit, or a signal kill (Gatekeeper SIGKILL on
  // an unsigned/quarantined Mac binary), REJECTS with a descriptive
  // error — previously it resolved unconditionally, so a killed ffmpeg
  // looked like "0 silences found / empty output" and the feature
  // silently did nothing. On the first Mac failure we self-heal the
  // binary (quarantine/exec-bit/signature) and retry once.
  function runFFmpeg(args, _healRetry) {
    return new Promise(function (resolve, reject) {
      var bin = resolveFFmpeg();
      // Only mutate/sign an FFmpeg that ships inside this extension. A
      // Homebrew or user-supplied binary is owned by the user/package manager
      // and must never be chmod'ed or re-signed by the panel.
      var usingBundled = _isBundledFFmpeg(bin);
      var proc;
      try {
        proc = spawn(bin, args, { windowsHide: true });
      } catch (err) {
        // Synchronous spawn failure (rare). Try a heal+retry on Mac.
        if (_isMac && usingBundled && !_healRetry && _healMacBinary(bin)) {
          return resolve(runFFmpeg(args, true));
        }
        return reject(err);
      }
      var stdout = '', stderr = '';
      proc.stdout.on('data', function (d) { stdout += d.toString(); });
      proc.stderr.on('data', function (d) { stderr += d.toString(); });

      var _settled = false;
      function _retryOrReject(makeErr) {
        if (_settled) return; _settled = true;
        if (_isMac && usingBundled && !_healRetry && _healMacBinary(bin)) {
          resolve(runFFmpeg(args, true));   // one self-heal retry
        } else {
          reject(makeErr());
        }
      }

      proc.on('error', function (err) {
        if (err.code === 'ENOENT') {
          if (_settled) return; _settled = true;
          // Include where we looked — makes any packaging/path edge case
          // self-diagnosing from the user's error log.
          var tried = (_lastResolveTried && _lastResolveTried.length)
            ? ' Looked in: ' + _lastResolveTried.join(' , ')
            : '';
          var installHint = _isMac
            ? 'The macOS build must include lib/ffmpeg, or FFmpeg must be installed with Homebrew.'
            : 'Reinstall CompX Orbit Studio to restore the bundled FFmpeg.';
          reject(new Error('FFmpeg not found. ' + installHint + tried));
          return;
        }
        // EACCES etc. — likely a permissions/Gatekeeper problem on Mac.
        _retryOrReject(function () { return err; });
      });

      proc.on('close', function (code, signal) {
        if (_settled) return;
        if (code === 0) { _settled = true; resolve({ stdout: stdout, stderr: stderr, code: 0 }); return; }
        // Killed by a signal (SIGKILL = Gatekeeper on Mac) or non-zero exit.
        _retryOrReject(function () {
          var tail = (stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ');
          var why = signal ? ('killed by ' + signal) : ('exited with code ' + code);
          var e = new Error('FFmpeg ' + why + (tail ? (': ' + tail) : '') +
            (signal === 'SIGKILL' && _isMac
              ? ' — macOS blocked the bundled FFmpeg. Reinstall MachiCut, or set a custom FFmpeg path in Settings.'
              : ''));
          e.code = code; e.signal = signal;
          return e;
        });
      });
    });
  }

  // ── Silencedetect output parser ───────────────────────────────────────
  // Same parser the old server used — FFmpeg's silencedetect filter
  // writes one start line then one end+duration line per silent region.
  function parseSilenceDetect(stderr) {
    var silences = [];
    var lines = stderr.split('\n');
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var startM = line.match(/silence_start:\s*([\d.]+)/);
      if (startM) {
        current = { start: parseFloat(startM[1]) };
        continue;
      }
      var endM = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
      if (endM && current !== null) {
        current.end      = parseFloat(endM[1]);
        current.duration = parseFloat(endM[2]);
        silences.push(current);
        current = null;
      }
    }
    return silences;
  }

  // ── High-level operations ─────────────────────────────────────────────

  // Health check. The old surface returned `{ ok, version }`. Without a
  // sidecar there's nothing to be "up", so we always return ok. Existing
  // call sites use this purely as a readiness gate before kicking off
  // heavier work; with the in-process model that gate is always true.
  function ping() {
    return Promise.resolve({ ok: true, version: 'inproc' });
  }

  // No-op replacement — kept so existing waitForServer() helpers still
  // resolve. Pre-warms nothing on the server side (because there is no
  // server). The Modal warm-up is a separate function below.
  function pingWaitable() {
    return Promise.resolve({ ok: true });
  }

  function detectSilence(filePath, threshold, duration) {
    if (!filePath) return Promise.reject(new Error('filePath is required'));
    if (!fs.existsSync(filePath)) return Promise.reject(new Error('File not found: ' + filePath));
    var th = threshold || -30;
    var d  = duration  ||  0.5;
    var filter = 'silencedetect=noise=' + th + 'dB:d=' + d;
    return runFFmpeg(['-i', filePath, '-af', filter, '-f', 'null', '-'])
      .then(function (r) { return parseSilenceDetect(r.stderr); });
  }

  function extractAudio(inputPath, outputPath) {
    if (!inputPath || !outputPath) {
      return Promise.reject(new Error('inputPath and outputPath are required'));
    }
    if (!fs.existsSync(inputPath)) {
      return Promise.reject(new Error('Input file not found: ' + inputPath));
    }
    var outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    // Speech-optimal extract — mono 16k MP3 32k, same as before.
    var args = [
      '-y', '-i', inputPath,
      '-vn',
      '-acodec', 'libmp3lame',
      '-ar', '16000', '-ac', '1', '-b:a', '32k',
      outputPath
    ];
    return runFFmpeg(args).then(function () {
      if (!fs.existsSync(outputPath)) {
        throw new Error('Output file was not created.');
      }
      return { outputPath: outputPath };
    });
  }

  // Extract every clip segment from its source file, pad inter-clip
  // gaps with silence so timestamps stay aligned, concat into one MP3.
  // Returns { outputPath, clipMap } — clipMap is the concat-time ↔
  // timeline-time mapping every downstream feature uses.
  function extractSegments(clips, outputPath) {
    if (!clips || !clips.length || !outputPath) {
      return Promise.reject(new Error('clips and outputPath are required'));
    }
    var tmpDir = os.tmpdir();
    var segPaths = [];
    var clipMap  = [];
    var concatOffset = 0;
    var silentIdx = 0;

    var chain = Promise.resolve();
    clips.forEach(function (clip, i) {
      chain = chain.then(function () {
        if (!fs.existsSync(clip.sourceFile)) {
          throw new Error('Source file not found: ' + clip.sourceFile);
        }
        // Pad gap between previous clip's timeline end and this clip's start.
        if (i > 0) {
          var prev    = clips[i - 1];
          var prevEnd = prev.timelineStart + (prev.srcOut - prev.srcIn);
          var gap     = clip.timelineStart - prevEnd;
          if (gap > 0.001) {
            var silPath = path.join(tmpDir, 'machicut_sil_' + (silentIdx++) + '.wav');
            return runFFmpeg([
              '-y',
              '-f', 'lavfi',
              '-i', 'anullsrc=r=16000:cl=mono',
              '-t', gap.toFixed(3),
              '-acodec', 'pcm_s16le',
              silPath
            ]).then(function () {
              if (!fs.existsSync(silPath)) throw new Error('Silence pad not created.');
              segPaths.push(silPath);
              concatOffset += gap;
            });
          }
        }
      }).then(function () {
        var segPath = path.join(tmpDir, 'machicut_seg_' + i + '.wav');
        var segDuration = clip.srcOut - clip.srcIn;
        // Seek on input, then cut by duration on output. `-to` before `-i`
        // follows the source file's embedded timecode and often comes back
        // longer than the Premiere clip — Whisper then writes SRT past the
        // video and word animation never hits the spoken frame.
        return runFFmpeg([
          '-y',
          '-ss', String(clip.srcIn),
          '-i',  clip.sourceFile,
          '-t',  String(segDuration),
          '-vn',
          '-acodec', 'pcm_s16le',
          '-ar', '16000', '-ac', '1',
          segPath
        ]).then(function () {
          if (!fs.existsSync(segPath)) throw new Error('Segment ' + i + ' not created.');
          var actual = 0;
          try {
            var dataBytes = Math.max(0, fs.statSync(segPath).size - 44);
            actual = dataBytes / (16000 * 2);
          } catch (_) {}
          var concatDur = (actual > 0.05 && Math.abs(actual - segDuration) > 0.08) ? actual : segDuration;
          clipMap.push({
            concatStart:   concatOffset,
            concatEnd:     concatOffset + concatDur,
            timelineStart: clip.timelineStart,
            timelineDur:   segDuration
          });
          concatOffset += concatDur;
          segPaths.push(segPath);
        });
      });
    });

    return chain.then(function () {
      // Write FFmpeg concat list
      var concatListPath = path.join(tmpDir, 'machicut_concat.txt');
      var concatContent  = segPaths.map(function (p) {
        return "file '" + p.replace(/\\/g, '/') + "'";
      }).join('\n');
      fs.writeFileSync(concatListPath, concatContent, 'utf8');

      var outDir = path.dirname(outputPath);
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      return runFFmpeg([
        '-y',
        '-f', 'concat', '-safe', '0',
        '-i', concatListPath,
        '-acodec', 'libmp3lame',
        '-ar', '16000', '-ac', '1',
        '-b:a', '32k',
        outputPath
      ]).then(function () {
        if (!fs.existsSync(outputPath)) {
          throw new Error('Concatenated output was not created.');
        }
        // Cleanup temp segments (best-effort)
        segPaths.forEach(function (p) { try { fs.unlinkSync(p); } catch (_) {} });
        try { fs.unlinkSync(concatListPath); } catch (_) {}
        return { outputPath: outputPath, clipMap: clipMap };
      }).catch(function (err) {
        segPaths.forEach(function (p) { try { fs.unlinkSync(p); } catch (_) {} });
        throw err;
      });
    });
  }

  // Mix clips from multiple guidance tracks on their real timeline positions.
  // Silence detection on this file fires only when every selected track is quiet.
  function mixTimelineClips(clips, outputPath, scope) {
    if (!clips || !clips.length || !outputPath) return Promise.reject(new Error('clips and outputPath are required'));
    var start = scope && isFinite(scope.start) ? Number(scope.start) : Infinity;
    var end = scope && isFinite(scope.end) ? Number(scope.end) : -Infinity;
    for (var ci = 0; ci < clips.length; ci++) {
      if (!fs.existsSync(clips[ci].sourceFile)) return Promise.reject(new Error('Source file not found: ' + clips[ci].sourceFile));
      start = Math.min(start, Number(clips[ci].timelineStart));
      end = Math.max(end, Number(clips[ci].timelineStart) + (Number(clips[ci].srcOut) - Number(clips[ci].srcIn)));
    }
    if (scope && isFinite(scope.start)) start = Number(scope.start);
    if (scope && isFinite(scope.end)) end = Number(scope.end);
    if (!isFinite(start) || !isFinite(end) || end <= start) return Promise.reject(new Error('Invalid guidance range'));

    var args = ['-y'];
    var filters = [];
    var labels = [];
    var inputIndex = 0;
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      var clipStart = Number(clip.timelineStart);
      var clipEnd = clipStart + (Number(clip.srcOut) - Number(clip.srcIn));
      var useStart = Math.max(start, clipStart);
      var useEnd = Math.min(end, clipEnd);
      if (useEnd <= useStart) continue;
      var srcIn = Number(clip.srcIn) + (useStart - clipStart);
      var srcOut = srcIn + (useEnd - useStart);
      args.push('-ss', String(srcIn), '-to', String(srcOut), '-i', clip.sourceFile);
      var delayMs = Math.max(0, Math.round((useStart - start) * 1000));
      var label = 'g' + inputIndex;
      filters.push('[' + inputIndex + ':a]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono,asetpts=PTS-STARTPTS,adelay=' + delayMs + '|' + delayMs + '[' + label + ']');
      labels.push('[' + label + ']');
      inputIndex++;
    }
    if (!inputIndex) return Promise.reject(new Error('No guidance clips overlap the selected range'));
    filters.push(labels.join('') + 'amix=inputs=' + inputIndex + ':duration=longest:dropout_transition=0:normalize=0,atrim=0:' + (end - start).toFixed(6) + '[mix]');
    var outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    args.push('-filter_complex', filters.join(';'), '-map', '[mix]', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', outputPath);
    return runFFmpeg(args).then(function () {
      if (!fs.existsSync(outputPath)) throw new Error('Guidance mix was not created.');
      return { outputPath: outputPath, clipMap: [{ concatStart: 0, concatEnd: end - start, timelineStart: start }] };
    });
  }

  // Decode a slice (or the whole file) of audio to float32 mono,
  // compute peaks for waveform display. Same algorithm as before —
  // target ~4 raw samples per peak, normalize to 0..1.
  function waveform(filePath, points, opts) {
    if (!filePath) return Promise.reject(new Error('filePath is required'));
    if (!fs.existsSync(filePath)) return Promise.reject(new Error('File not found: ' + filePath));
    var pts = points || 800;
    var hasSlice = (opts && typeof opts.startSec === 'number' && typeof opts.endSec === 'number'
                    && opts.endSec > opts.startSec);

    return runFFmpeg(['-i', filePath, '-f', 'null', '-']).then(function (probe) {
      var durMatch = probe.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      var fullDuration = durMatch
        ? parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3])
        : 0;
      if (!fullDuration) throw new Error('Could not determine duration');

      var sliceStart = hasSlice ? Math.max(0, opts.startSec) : 0;
      var sliceEnd   = hasSlice ? Math.min(fullDuration, opts.endSec) : fullDuration;
      var duration   = sliceEnd - sliceStart;

      var sampleRate = Math.max(100, Math.ceil((pts * 4) / duration));
      var tmpPcm = path.join(os.tmpdir(), 'machicut_waveform_' + Date.now() + '.raw');

      var args = ['-y'];
      if (hasSlice) args.push('-ss', String(sliceStart), '-to', String(sliceEnd));
      args.push(
        '-i', filePath,
        '-vn', '-ac', '1', '-ar', String(sampleRate),
        '-f', 'f32le', tmpPcm
      );

      return runFFmpeg(args).then(function () {
        var buf = fs.readFileSync(tmpPcm);
        try { fs.unlinkSync(tmpPcm); } catch (_) {}

        var totalSamples = buf.length / 4;
        var chunkSize    = Math.max(1, Math.floor(totalSamples / pts));
        var peaks        = [];
        for (var i = 0; i < pts; i++) {
          var start = i * chunkSize;
          var end   = Math.min(start + chunkSize, totalSamples);
          var peak  = 0;
          for (var s = start; s < end; s++) {
            var v = Math.abs(buf.readFloatLE(s * 4));
            if (v > peak) peak = v;
          }
          peaks.push(peak);
        }
        var maxPeak = peaks.reduce(function (m, v) { return Math.max(m, v); }, 0.0001);
        var normalized = peaks.map(function (v) { return v / maxPeak; });
        return { peaks: normalized, duration: duration };
      });
    });
  }

  // Decode an audio file to raw mono f32 PCM at a fixed sample rate — the
  // input the Beat Sync engine needs for onset/tempo detection. Returns
  // { samples: Float32Array, sampleRate, duration }.
  function decodePcm(filePath, sampleRate) {
    if (!filePath) return Promise.reject(new Error('filePath is required'));
    if (!fs.existsSync(filePath)) return Promise.reject(new Error('File not found: ' + filePath));
    var rate = sampleRate || 8000;
    var tmpPcm = path.join(os.tmpdir(), 'machicut_pcm_' + Date.now() + '.raw');
    return runFFmpeg(['-y', '-i', filePath, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', tmpPcm])
      .then(function () {
        if (!fs.existsSync(tmpPcm)) throw new Error('PCM output was not created.');
        var buf = fs.readFileSync(tmpPcm);
        try { fs.unlinkSync(tmpPcm); } catch (_) {}
        var samples = new Float32Array(buf.length / 4);
        for (var i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
        return { samples: samples, sampleRate: rate, duration: samples.length / rate };
      });
  }

  // Extract a single clip's source range (srcIn..srcOut) to a WAV file at
  // the given sample rate, preserving the source's channel layout. This is
  // the denoiser's input step — unlike extractSegments (which downmixes to
  // mono 16 kHz MP3 for silence detection), the AI Voice Cleaner needs
  // full-bandwidth, multi-channel audio.
  // clip: { sourceFile, srcIn, srcOut } — resolves { outputPath, sampleRate }.
  function extractClipWav(clip, outputPath, sampleRate) {
    if (!clip || !clip.sourceFile || !outputPath) {
      return Promise.reject(new Error('clip and outputPath are required'));
    }
    if (!fs.existsSync(clip.sourceFile)) {
      return Promise.reject(new Error('Source file not found: ' + clip.sourceFile));
    }
    var rate = sampleRate || 48000;
    var outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    return runFFmpeg([
      '-y',
      '-ss', String(clip.srcIn),
      '-to', String(clip.srcOut),
      '-i', clip.sourceFile,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', String(rate),
      outputPath
    ]).then(function () {
      if (!fs.existsSync(outputPath)) throw new Error('WAV export was not created.');
      return { outputPath: outputPath, sampleRate: rate };
    });
  }

  // Denoise a WAV file. Prefer optional bundled RNNoise, then FFmpeg's
  // adaptive FFT denoiser, and only then the pure-JS spectral-gate fallback.
  // Buyers therefore need no separate model or native install.
  function denoiseWav(inputPath, opts) {
    if (!inputPath || !fs.existsSync(inputPath)) {
      return Promise.reject(new Error('Input audio not found: ' + inputPath));
    }
    opts = opts || {};
    var strength = Math.max(0, Math.min(1, Number(opts.strength) || 0.8));
    var outPath = inputPath.replace(/\.wav$/i, '_clean.wav');

    // Native addon path (requires the user to compile native/audio-addon/).
    var native = null;
    try {
      var addonPath = path.join(__dirname, '..', 'native', 'audio-addon', 'build', 'Release', 'orbit_audio.node');
      native = require(addonPath);
    } catch (e) { native = null; }
    if (native && typeof native.denoiseWav === 'function') {
      return new Promise(function (resolve, reject) {
        try {
          var res = native.denoiseWav(inputPath, outPath, {
            strength: strength,
            normalize: opts.normalize === true
          });
          if (res && res.success) resolve({ outputPath: outPath, engine: 'native' });
          else reject(new Error((res && res.error) || 'Native denoise failed.'));
        } catch (e) {
          reject(new Error('Native denoise failed: ' + e.message));
        }
      });
    }

    // FFmpeg adaptive FFT denoiser. It needs no model file or native module,
    // unlike arnndn/RNNoise. The amount is capped so the Strong preset still
    // preserves consonants better than a hard gate. If a custom FFmpeg build
    // lacks afftdn, retain the pure-JS fallback.
    var reductionDb = Math.round(8 + (strength * 24)); // 8 dB .. 32 dB
    var filter = 'afftdn=nr=' + reductionDb + ':nf=-50:tn=1';
    if (opts.normalize === true) filter += ',loudnorm=I=-16:TP=-1.5:LRA=11';
    return runFFmpeg(['-y', '-i', inputPath, '-af', filter, '-c:a', 'pcm_s16le', outPath])
      .then(function () {
        if (!fs.existsSync(outPath)) throw new Error('FFmpeg denoise output was not created.');
        return { outputPath: outPath, engine: 'ffmpeg' };
      })
      .catch(function () {
        // JS spectral-gate fallback.
        var engine = (typeof window !== 'undefined') ? window.AudioEngine : null;
        if (!engine || typeof engine.processFile !== 'function') {
          throw new Error('No denoiser available.');
        }
        return engine.processFile(inputPath, outPath, {
          strength: strength,
          mix: opts.mix === undefined ? 1 : opts.mix,
          normalize: opts.normalize === true
        }, opts.onProgress).then(function (res) {
          return { outputPath: res.outputPath, engine: 'js' };
        });
      });
  }

  // Read a WAV file as an ArrayBuffer — used by the panel's in-panel
  // preview playback (decodeAudioData).
  function readWavBuffer(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return Promise.reject(new Error('Audio not found: ' + filePath));
    }
    return new Promise(function (resolve, reject) {
      fs.readFile(filePath, function (err, buf) {
        if (err) return reject(new Error('Cannot read audio: ' + err.message));
        var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        resolve(ab);
      });
    });
  }

  // ── Library thumbnails ────────────────────────────────────────────────
  // Generates a small, cacheable preview image for a Library asset:
  //   • video → a single poster frame, scaled to `width`
  //   • image → the image scaled down (bounds panel memory; the grid never
  //             loads the full-res original)
  //   • audio → a waveform picture via ffmpeg's showwavespic filter
  // Resolves { outputPath, duration } (duration in seconds, 0 for images).
  function _parseDuration(stderr) {
    var m = (stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    return m ? (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3])) : 0;
  }
  // Source pixel dimensions from the first Video stream line (input, not the
  // scaled output — the input line appears first in ffmpeg's stderr).
  function _parseResolution(stderr) {
    var m = (stderr || '').match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
    return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : { width: 0, height: 0 };
  }
  function makeThumb(inputPath, outputPath, kind, opts) {
    opts = opts || {};
    if (!inputPath || !outputPath) return Promise.reject(new Error('inputPath and outputPath are required'));
    if (!fs.existsSync(inputPath)) return Promise.reject(new Error('Input not found: ' + inputPath));
    var outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    var w = opts.width || 320;

    function videoArgs(ss) {
      return ['-y', '-ss', String(ss), '-i', inputPath, '-frames:v', '1',
              '-vf', 'scale=' + w + ':-2', '-q:v', '4', outputPath];
    }
    var args;
    if (kind === 'audio') {
      var color = String(opts.color || '638fff').replace('#', '');
      args = ['-y', '-i', inputPath, '-filter_complex',
              'showwavespic=s=' + w + 'x' + (opts.height || 120) + ':colors=0x' + color,
              '-frames:v', '1', outputPath];
    } else if (kind === 'video') {
      args = videoArgs(typeof opts.ss === 'number' ? opts.ss : 0.5);
    } else { // image
      args = ['-y', '-i', inputPath, '-vf', 'scale=' + w + ':-2', '-q:v', '4', outputPath];
    }

    function _result(r) {
      var res = _parseResolution(r.stderr);
      return { outputPath: outputPath, duration: _parseDuration(r.stderr), width: res.width, height: res.height };
    }
    return runFFmpeg(args).then(function (r) {
      if (fs.existsSync(outputPath)) return _result(r);
      throw new Error('Thumbnail not created');
    }).catch(function (err) {
      // A very short video with -ss past its end yields no frame → retry at 0.
      if (kind === 'video' && (opts.ss === undefined || opts.ss > 0)) {
        return runFFmpeg(videoArgs(0)).then(function (r2) {
          if (fs.existsSync(outputPath)) return _result(r2);
          throw new Error('Thumbnail not created');
        });
      }
      throw err;
    });
  }

  // ── Modal upload (Whisper transcription) ──────────────────────────────
  // The old server proxied the multipart POST through Node + form-data.
  // Browser fetch + native FormData can do the same multipart upload
  // directly. File is read into memory as a Blob — fine for the small
  // (1–2 MB at the default quality) MP3s we produce.
  // `authToken` is the Supabase session JWT (via AuthAPI.getAccessToken).
  // Sent both as Authorization: Bearer for JWT-aware backends AND as the
  // legacy `license_key` FormData field so an unchanged Modal endpoint
  // still accepts it if it's been migrated to validate JWTs under either
  // name. Parameter is still called `licenseKey` at the call sites for
  // now — historic naming, semantically it's whichever credential proves
  // this session.
  function transcribeAudio(filePath, language, authToken, model) {
    if (!filePath)  return Promise.reject(new Error('filePath is required'));
    if (!authToken) return Promise.reject(new Error('Not signed in. Reopen the panel to sign in.'));
    if (!fs.existsSync(filePath)) {
      return Promise.reject(new Error('Audio file not found: ' + filePath));
    }
    var buf  = fs.readFileSync(filePath);
    var mime = filePath.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
    var blob = new Blob([buf], { type: mime });

    var form = new FormData();
    form.append('file', blob, path.basename(filePath));
    form.append('license_key', authToken);
    form.append('model', model || 'turbo');
    // Device fingerprint → server meters the freemium free allowance
    // per machine. Harmless for paid users (their path ignores it).
    try { form.append('device_id', getDeviceId()); } catch (_) {}
    if (language && language !== 'auto') form.append('language', language);

    return fetch(MODAL_ENDPOINT_URL, {
      method:  'POST',
      body:    form,
      headers: { 'Authorization': 'Bearer ' + authToken },
    }).then(function (response) {
      return response.json().then(function (data) {
        if (response.ok) return data;
        // Match the old error surface so existing call sites keep working.
        if (response.status === 401) {
          var e1 = new Error('Session invalid or expired. Reopen the panel to sign in again.');
          e1.status = 401; e1.body = data; throw e1;
        }
        if (response.status === 429) {
          // Limit hit — bubble the structured payload up so the popup
          // can render its limit banner.
          var e2 = new Error('Daily limit reached.');
          e2.status = 429; e2.body = data; throw e2;
        }
        var e3 = new Error('Transcription error (' + response.status + '): ' +
                           (data.error || JSON.stringify(data)));
        e3.status = response.status; e3.body = data; throw e3;
      });
    });
  }

  // Lightweight GET on the Modal endpoint to wake the container — any
  // HTTP response (even 4xx/405) means it's warm.
  function warmServer() {
    var WARM_TIMEOUT_MS = 60000;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, WARM_TIMEOUT_MS);
    return fetch(MODAL_ENDPOINT_URL, { method: 'GET', signal: controller.signal })
      .then(function (res) {
        clearTimeout(timer);
        return { ready: true, status: res.status };
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          var e = new Error('timeout');
          e.code = 'WARM_TIMEOUT'; throw e;
        }
        throw err;
      });
  }

  function checkFFmpeg(customPath) {
    var prev = _cachedFfmpegPath;
    if (customPath) _cachedFfmpegPath = customPath;
    var pth = customPath || resolveFFmpeg();

    // CEP on Windows can occasionally miss the child close event for a
    // very short-lived ffmpeg -version process. That leaves the readiness
    // Promise pending forever even though FFmpeg has already exited, so the
    // Generate UI stays on Generating before audio extraction begins.
    // A bounded synchronous probe is safe here and avoids relying on that
    // event. Keep macOS asynchronous for its quarantine/self-heal path.
    if (!_isMac) {
      try {
        var probe = spawnSync(pth, ['-version'], {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        if (probe.error) throw probe.error;
        if (probe.status !== 0) {
          throw new Error('FFmpeg readiness check exited with code ' + probe.status + '.');
        }
        var output = probe.stderr || probe.stdout || '';
        return Promise.resolve({
          ok: true,
          version: output.split('\n')[0] || '',
          path: pth
        });
      } catch (err) {
        if (customPath) _cachedFfmpegPath = prev;
        return Promise.reject(err);
      }
    }

    var probeTimeout;
    var timedProbe = new Promise(function (_, reject) {
      probeTimeout = setTimeout(function () {
        reject(new Error('FFmpeg readiness check timed out.'));
      }, 15000);
    });
    return Promise.race([runFFmpeg(['-version']), timedProbe]).then(function (r) {
      clearTimeout(probeTimeout);
      var versionLine = (r.stderr || r.stdout || '').split('\n')[0] || '';
      return { ok: true, version: versionLine, path: pth };
    }).catch(function (err) {
      clearTimeout(probeTimeout);
      if (customPath) _cachedFfmpegPath = prev;
      throw err;
    });
  }

  // ── Folder deletion (caption hard-clean) ──────────────────────────────
  // Pattern check moved here from server.js — accept paths whose
  // basename matches a MachiCut render timestamp AND whose parent is
  // one of the known caption output bins. Same allow-list as before;
  // we no longer need the OS-temp branch because there's no untrusted
  // network input — the caller is in-panel.
  function deleteFolders(folders) {
    if (!Array.isArray(folders) || !folders.length) {
      return Promise.resolve({ ok: true, deleted: 0, bytes: 0, errors: [] });
    }
    var TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
    var ALLOWED_PARENTS = ['CompX Orbit Captions', 'CompX Captions', 'compx captions', 'MachiCut Captions', 'machicut captions', 'captions'];

    function _isAllowed(p) {
      var norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
      var parts = norm.split('/');
      if (parts.length < 2) return false;
      var last   = parts[parts.length - 1];
      var parent = parts[parts.length - 2];
      if (!TIMESTAMP_RE.test(last)) return false;
      var parentL = parent.toLowerCase();
      for (var i = 0; i < ALLOWED_PARENTS.length; i++) {
        if (parent === ALLOWED_PARENTS[i] || parentL === ALLOWED_PARENTS[i].toLowerCase()) {
          return true;
        }
      }
      return false;
    }

    function _sizeBytes(folder) {
      var total = 0;
      try {
        var items = fs.readdirSync(folder, { withFileTypes: true });
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var p = path.join(folder, it.name);
          if (it.isDirectory()) total += _sizeBytes(p);
          else { try { total += fs.statSync(p).size; } catch (_) {} }
        }
      } catch (_) {}
      return total;
    }

    var deleted = 0, totalBytes = 0;
    var errors  = [];
    for (var i = 0; i < folders.length; i++) {
      var folder = folders[i];
      try {
        if (!folder) continue;
        var normRaw = String(folder).replace(/\\/g, '/').replace(/\/+$/, '');
        if (!_isAllowed(normRaw)) {
          errors.push({
            folder: normRaw,
            reason: 'refused — path must be **/MachiCut Captions/<timestamp>'
          });
          continue;
        }
        if (!fs.existsSync(normRaw)) {
          errors.push({ folder: normRaw, reason: 'already gone (skipped)' });
          continue;
        }
        var bytes = _sizeBytes(normRaw);
        fs.rmSync(normRaw, { recursive: true, force: true });
        deleted++;
        totalBytes += bytes;
      } catch (err) {
        errors.push({ folder: String(folder), reason: err.message });
      }
    }
    return Promise.resolve({
      ok: true, deleted: deleted, bytes: totalBytes, errors: errors
    });
  }

  // ── Public API ────────────────────────────────────────────────────────
  // ── Diagnostic ────────────────────────────────────────────────────────
  // Reports what the media pipeline actually sees, so a failure on a machine
  // we cannot reach names the step that broke instead of surfacing whatever
  // error bubbled up last. Every probe is individually guarded: this must
  // return a report even when nothing works.
  function _probeStep(label, fn) {
    var started = Date.now();
    try { return { step: label, ok: true, value: fn(), ms: Date.now() - started }; }
    catch (err) { return { step: label, ok: false, error: String(err && err.message || err), ms: Date.now() - started }; }
  }

  function diagnose() {
    var report = { generated: new Date().toISOString(), steps: [] };
    function add(label, fn) { report.steps.push(_probeStep(label, fn)); }

    add('platform', function () {
      return process.platform + ' / ' + process.arch + ' / node ' + process.versions.node;
    });
    add('extension path', function () {
      var ext = _extensionPath();
      if (!ext) throw new Error('CSInterface did not return an extension path');
      return ext;
    });
    add('expected binary name', function () { return _ffmpegName(); });

    var bin = null;
    add('resolved ffmpeg', function () {
      _cachedFfmpegPath = null;            // force a fresh resolve for the report
      bin = resolveFFmpeg();
      return bin + (_isBundledFFmpeg(bin) ? '  [bundled]' : '  [external]');
    });
    add('paths tried', function () { return _lastResolveTried.join('\n              '); });
    add('binary on disk', function () {
      if (!bin || bin === 'ffmpeg') throw new Error('fell through to PATH — no bundled binary was found');
      var st = fs.statSync(bin);
      var detail = (st.size / 1048576).toFixed(1) + ' MB, mode ' + (st.mode & 511).toString(8);
      if (!_isMac || (st.mode & 64)) return detail;
      throw new Error(detail + ' — the owner execute bit is missing, so the binary cannot run. '
        + 'ZXP packaging does not preserve it; chmod +x the bundled ffmpeg.');
    });
    add('binary format', function () {
      if (!bin || bin === 'ffmpeg') throw new Error('no file to inspect');
      var fd = fs.openSync(bin, 'r'), head = Buffer.alloc(4);
      try { fs.readSync(fd, head, 0, 4, 0); } finally { try { fs.closeSync(fd); } catch (_) {} }
      var magic = head.toString('hex');
      var kinds = {
        'cffaedfe': 'Mach-O 64-bit (macOS)', 'cefaedfe': 'Mach-O 32-bit (macOS)',
        'cafebabe': 'Mach-O universal (macOS)', 'bebafeca': 'Mach-O universal (macOS)',
        '7f454c46': 'ELF (Linux)'
      };
      var kind = kinds[magic] || (head.toString('latin1', 0, 2) === 'MZ' ? 'PE/EXE (Windows)' : 'unknown');
      var wanted = _isMac ? 'Mach-O' : 'PE/EXE';
      if (kind.indexOf(wanted) !== -1) return kind + ' (0x' + magic + ')';
      throw new Error(kind + ' (0x' + magic + ') but this machine needs ' + wanted
        + ' — the wrong binary is bundled, or _ffmpegName() picked the wrong one.');
    });
    if (_isMac) {
      add('macOS quarantine', function () {
        var r = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', bin], { timeout: 8000, encoding: 'utf8' });
        return r.status === 0 ? 'QUARANTINED — Gatekeeper will kill it: ' + String(r.stdout).trim() : 'clear';
      });
      add('macOS signature', function () {
        var r = spawnSync('/usr/bin/codesign', ['--verify', '--strict', bin], { timeout: 8000, encoding: 'utf8' });
        return r.status === 0 ? 'valid' : 'INVALID/UNSIGNED — ' + String(r.stderr || '').trim().slice(0, 160);
      });
    }
    add('ffmpeg -version', function () {
      var r = spawnSync(bin, ['-version'], { timeout: 15000, encoding: 'utf8', windowsHide: true });
      if (r.error) throw r.error;
      if (r.signal) throw new Error('killed by signal ' + r.signal + (_isMac ? ' (Gatekeeper kills unsigned or quarantined binaries)' : ''));
      if (r.status !== 0) throw new Error('exit code ' + r.status + ' — ' + String(r.stderr || '').slice(0, 200));
      return String(r.stdout || r.stderr || '').split('\n')[0];
    });
    add('temp dir writable', function () {
      var probe = path.join(os.tmpdir(), 'orbit-probe-' + Date.now() + '.txt');
      fs.writeFileSync(probe, 'ok');
      try { fs.unlinkSync(probe); } catch (_) {}
      return os.tmpdir();
    });
    // Informational, never a failure: local Whisper is a Windows-x64-only
    // accelerator, and every other platform is expected to use the cloud.
    add('transcription route', function () {
      return (process.platform === 'win32' && process.arch === 'x64')
        ? 'local whisper.cpp available, cloud as fallback'
        : 'cloud only (utils/whisperLocal.js installs on Windows x64 only)';
    });

    report.ok = true;
    for (var i = 0; i < report.steps.length; i++) if (!report.steps[i].ok) report.ok = false;
    return report;
  }

  function diagnoseText() {
    var r;
    try { r = diagnose(); }
    catch (err) { return 'Orbit media diagnostic failed to run: ' + String(err && err.message || err); }
    var lines = ['CompX Orbit Premiere — media diagnostic', r.generated, ''];
    for (var i = 0; i < r.steps.length; i++) {
      var s = r.steps[i];
      lines.push((s.ok ? '  OK   ' : '  FAIL ') + s.step + ': ' + (s.ok ? s.value : s.error));
    }
    lines.push('', r.ok ? 'All checks passed.' : 'At least one check failed — the first FAIL above is the one to fix.');
    return lines.join('\n');
  }

  global.FFmpegAPI = {
    ping:           ping,
    diagnose:       diagnose,
    diagnoseText:   diagnoseText,
    pingWaitable:   pingWaitable,
    warmServer:     warmServer,
    detectSilence:  detectSilence,
    extractAudio:   extractAudio,
    extractSegments: extractSegments,
    mixTimelineClips: mixTimelineClips,
    extractClipWav:  extractClipWav,
    denoiseWav:      denoiseWav,
    readWavBuffer:   readWavBuffer,
    transcribeAudio: transcribeAudio,
    checkFFmpeg:    checkFFmpeg,
    waveform:       waveform,
    decodePcm:       decodePcm,
    makeThumb:      makeThumb,
    deleteFolders:  deleteFolders,
    // Device fingerprint — reused by the Phase 2 free-tier meter.
    getDeviceId:    getDeviceId,

    // Exposed for diagnostics / Settings page
    resolveFFmpegPath: resolveFFmpeg
  };

}(window));
