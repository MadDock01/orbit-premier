/**
 * whisperLocal.js — private, zero-per-minute-cost Whisper transcription.
 *
 * Reuses the CompX Studio runtime in %LOCALAPPDATA%\CompXOrbit\AutoCaptions.
 * Missing binaries/models are downloaded from the signed runtime manifest and
 * SHA-256 verified before execution. Audio never leaves the user's computer.
 */
(function (global) {
  'use strict';

  var req = (typeof require !== 'undefined') ? require
          : (typeof window !== 'undefined' && window.require) ? window.require
          : null;
  if (!req) {
    global.WhisperLocalAPI = {
      available: false,
      getStatus: function () { return { available: false, installed: false, reason: 'CEP Node is unavailable.' }; },
      transcribeAudio: function () { return Promise.reject(new Error('Local Whisper requires CEP Node.')); }
    };
    return;
  }

  var fs = req('fs');
  var path = req('path');
  var os = req('os');
  var cp = req('child_process');
  var https = req('https');
  var urlMod = req('url');
  var crypto = req('crypto');

  function extensionRoot() {
    try {
      if (typeof CSInterface !== 'undefined') return new CSInterface().getSystemPath('extension');
    } catch (_) {}
    return '';
  }

  function loadSpec() {
    var manifestPath = path.join(extensionRoot(), 'scripts', 'autocaptions-runtime.json');
    var spec = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!spec || spec.schema !== 1 || !spec.runtime || !spec.ffmpeg || !spec.models) {
      throw new Error('Invalid local Whisper runtime manifest.');
    }
    return spec;
  }

  function runtimeRoot() {
    var local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'CompXOrbit', 'AutoCaptions');
  }

  function readRecord(root) {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); }
    catch (_) { return { schema: 1, models: {} }; }
  }

  function writeRecord(root, record) {
    fs.mkdirSync(root, { recursive: true });
    record.schema = 1;
    record.updatedAt = new Date().toISOString();
    var target = path.join(root, 'manifest.json');
    var partial = target + '.tmp';
    fs.writeFileSync(partial, JSON.stringify(record, null, 2), 'utf8');
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.renameSync(partial, target);
  }

  function safePath(root, relativePath) {
    if (!relativePath) return null;
    var resolvedRoot = path.resolve(root) + path.sep;
    var resolved = path.resolve(root, relativePath);
    if (resolved.toLowerCase().indexOf(resolvedRoot.toLowerCase()) !== 0) return null;
    return resolved;
  }

  function resolveRuntime(spec, model) {
    if (!spec.models[model]) return null;
    var root = runtimeRoot();
    var record = readRecord(root);
    if (record.runtimeVersion !== spec.runtimeVersion ||
        record.runtimeSha256 !== spec.runtime.sha256 ||
        record.ffmpegSha256 !== spec.ffmpeg.sha256) return null;
    var whisper = safePath(root, record.whisperExe);
    var ffmpeg = safePath(root, record.ffmpegExe);
    var modelRecord = record.models && record.models[model];
    var modelPath = modelRecord && modelRecord.sha256 === spec.models[model].sha256
      ? safePath(root, modelRecord.path) : null;
    if (!whisper || !ffmpeg || !modelPath ||
        !fs.existsSync(whisper) || !fs.existsSync(ffmpeg) || !fs.existsSync(modelPath)) return null;
    return { root: root, whisper: whisper, ffmpeg: ffmpeg, model: modelPath };
  }

  function estimateDownloadMB(model) {
    var spec = loadSpec();
    if (!spec.models[model]) throw new Error('Unknown local Whisper model: ' + model);
    var root = runtimeRoot();
    var record = readRecord(root);
    var total = 0;
    var whisper = safePath(root, record.whisperExe);
    var ffmpeg = safePath(root, record.ffmpegExe);
    var modelRecord = record.models && record.models[model];
    var modelPath = modelRecord && safePath(root, modelRecord.path);
    if (record.runtimeVersion !== spec.runtimeVersion || record.runtimeSha256 !== spec.runtime.sha256 ||
        !whisper || !fs.existsSync(whisper)) total += Number(spec.runtime.sizeMB) || 0;
    if (record.ffmpegSha256 !== spec.ffmpeg.sha256 || !ffmpeg || !fs.existsSync(ffmpeg)) {
      total += Number(spec.ffmpeg.sizeMB) || 0;
    }
    if (!modelRecord || modelRecord.sha256 !== spec.models[model].sha256 ||
        !modelPath || !fs.existsSync(modelPath)) total += Number(spec.models[model].sizeMB) || 0;
    return total;
  }

  function getStatus(model) {
    try {
      if (os.platform() !== 'win32' || os.arch() !== 'x64') {
        return { available: false, installed: false, reason: 'Local Whisper currently supports 64-bit Windows.' };
      }
      var spec = loadSpec();
      if (!spec.models[model]) return { available: false, installed: false, reason: 'Unknown model.' };
      var runtime = resolveRuntime(spec, model);
      return {
        available: true,
        installed: !!runtime,
        model: model,
        downloadMB: runtime ? 0 : estimateDownloadMB(model),
        root: runtimeRoot()
      };
    } catch (err) {
      return { available: false, installed: false, reason: err.message || String(err) };
    }
  }

  function getDependencyStatus(model) {
    try {
      var spec = loadSpec();
      if (!spec.models[model]) throw new Error('Unknown local Whisper model: ' + model);
      var root = runtimeRoot();
      var record = readRecord(root);
      var whisper = safePath(root, record.whisperExe);
      var ffmpeg = safePath(root, record.ffmpegExe);
      var modelRecord = record.models && record.models[model];
      var modelPath = modelRecord && safePath(root, modelRecord.path);
      var runtimeReady = record.runtimeVersion === spec.runtimeVersion &&
        record.runtimeSha256 === spec.runtime.sha256 && whisper && fs.existsSync(whisper);
      var ffmpegReady = record.ffmpegSha256 === spec.ffmpeg.sha256 &&
        ffmpeg && fs.existsSync(ffmpeg);
      var modelReady = modelRecord && modelRecord.sha256 === spec.models[model].sha256 &&
        modelPath && fs.existsSync(modelPath);
      return {
        available: os.platform() === 'win32' && os.arch() === 'x64',
        root: root, model: model, totalDownloadMB: estimateDownloadMB(model),
        runtime: { ready: !!runtimeReady, sizeMB: Number(spec.runtime.sizeMB) || 0,
          path: whisper || path.join(root, 'runtime', spec.runtimeVersion) },
        ffmpeg: { ready: !!ffmpegReady, sizeMB: Number(spec.ffmpeg.sizeMB) || 0,
          path: ffmpeg || path.join(root, 'ffmpeg', spec.ffmpeg.version) },
        selectedModel: { ready: !!modelReady, id: model,
          sizeMB: Number(spec.models[model].sizeMB) || 0,
          path: modelPath || path.join(root, 'models', spec.models[model].file) }
      };
    } catch (err) {
      return { available: false, reason: err.message || String(err), root: runtimeRoot() };
    }
  }

  function openRuntimeFolder() {
    var root = runtimeRoot();
    fs.mkdirSync(root, { recursive: true });
    if (os.platform() === 'win32') {
      var child = cp.spawn('explorer.exe', [root], { detached: true, windowsHide: false, stdio: 'ignore' });
      child.unref();
      return true;
    }
    return false;
  }

  function report(onProgress, label, percent) {
    if (typeof onProgress === 'function') {
      try { onProgress({ label: label, percent: Math.max(0, Math.min(100, Number(percent) || 0)) }); } catch (_) {}
    }
  }

  function downloadVerified(url, destination, expectedHash, label, onProgress) {
    return new Promise(function (resolve, reject) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      var partial = destination + '.part';
      try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (_) {}

      function request(currentUrl, redirects) {
        var settled = false;
        var reqHandle = https.get(currentUrl, function (response) {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            if (redirects >= 8) { reject(new Error('Too many download redirects.')); return; }
            request(urlMod.resolve(currentUrl, response.headers.location), redirects + 1);
            return;
          }
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(label + ' download returned HTTP ' + response.statusCode));
            return;
          }
          var total = Number(response.headers['content-length']) || 0;
          var received = 0;
          var hash = crypto.createHash('sha256');
          var output = fs.createWriteStream(partial);
          function fail(error) {
            if (settled) return;
            settled = true;
            try { output.destroy(); } catch (_) {}
            try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (_) {}
            reject(error);
          }
          response.on('data', function (chunk) {
            received += chunk.length;
            hash.update(chunk);
            report(onProgress, 'Downloading ' + label + '…', total ? received * 100 / total : 0);
          });
          response.on('error', fail);
          output.on('error', fail);
          output.on('finish', function () {
            output.close(function () {
              if (settled) return;
              var actual = hash.digest('hex');
              if (actual.toLowerCase() !== String(expectedHash).toLowerCase()) {
                fail(new Error(label + ' security verification failed.'));
                return;
              }
              try {
                if (fs.existsSync(destination)) fs.unlinkSync(destination);
                fs.renameSync(partial, destination);
                settled = true;
                resolve(destination);
              } catch (err) { fail(err); }
            });
          });
          response.pipe(output);
        });
        reqHandle.setTimeout(30000, function () { reqHandle.destroy(new Error(label + ' download timed out.')); });
        reqHandle.on('error', function (err) {
          try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch (_) {}
          reject(err);
        });
      }
      request(url, 0);
    });
  }

  function extractZip(archive, destination, label) {
    return new Promise(function (resolve, reject) {
      fs.mkdirSync(destination, { recursive: true });
      var quote = function (value) { return "'" + String(value).replace(/'/g, "''") + "'"; };
      var command = 'Expand-Archive -LiteralPath ' + quote(archive) +
                    ' -DestinationPath ' + quote(destination) + ' -Force';
      var proc = cp.spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { windowsHide: true });
      var output = '';
      proc.stdout.on('data', function (chunk) { output += chunk.toString(); });
      proc.stderr.on('data', function (chunk) { output += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', function (code) {
        if (code === 0) resolve();
        else reject(new Error(label + ' extraction failed: ' + output.slice(-400)));
      });
    });
  }

  function findBinary(folder, names) {
    var found = {};
    var queue = [folder];
    while (queue.length) {
      var current = queue.shift();
      var entries = fs.readdirSync(current, { withFileTypes: true });
      for (var i = 0; i < entries.length; i++) {
        var item = path.join(current, entries[i].name);
        if (entries[i].isDirectory()) queue.push(item);
        else if (found[entries[i].name.toLowerCase()] === undefined) {
          found[entries[i].name.toLowerCase()] = item;
        }
      }
    }
    for (var n = 0; n < names.length; n++) {
      var match = found[names[n].toLowerCase()];
      if (match) return match;
    }
    return null;
  }

  function ensureRuntime(model, onProgress) {
    var spec = loadSpec();
    var modelSpec = spec.models[model];
    if (!modelSpec) return Promise.reject(new Error('Unknown local Whisper model: ' + model));
    if (os.platform() !== 'win32' || os.arch() !== 'x64') {
      return Promise.reject(new Error('Local Whisper currently supports 64-bit Windows only. Use Cloud mode on this computer.'));
    }
    var existing = resolveRuntime(spec, model);
    if (existing) return Promise.resolve(existing);

    var root = runtimeRoot();
    var downloads = path.join(root, 'downloads');
    var record = readRecord(root);
    if (record.runtimeVersion !== spec.runtimeVersion) record = { schema: 1, models: {} };
    if (!record.models) record.models = {};
    fs.mkdirSync(downloads, { recursive: true });
    var chain = Promise.resolve();

    var whisperPath = safePath(root, record.whisperExe);
    if (record.runtimeSha256 !== spec.runtime.sha256 || !whisperPath || !fs.existsSync(whisperPath)) {
      chain = chain.then(function () {
        var archive = path.join(downloads, spec.runtime.archive);
        var destination = path.join(root, 'runtime', spec.runtimeVersion);
        return downloadVerified(spec.runtime.url, archive, spec.runtime.sha256, 'whisper.cpp', onProgress)
          .then(function () {
            report(onProgress, 'Installing whisper.cpp…', 100);
            return extractZip(archive, destination, 'whisper.cpp');
          }).then(function () {
            var executable = findBinary(destination, ['whisper-cli.exe', 'main.exe']);
            if (!executable) throw new Error('whisper-cli.exe was not found in the verified runtime.');
            record.runtimeVersion = spec.runtimeVersion;
            record.runtimeSha256 = spec.runtime.sha256;
            record.whisperExe = path.relative(root, executable);
            try { fs.unlinkSync(archive); } catch (_) {}
            writeRecord(root, record);
          });
      });
    }

    var ffmpegPath = safePath(root, record.ffmpegExe);
    if (record.ffmpegSha256 !== spec.ffmpeg.sha256 || !ffmpegPath || !fs.existsSync(ffmpegPath)) {
      chain = chain.then(function () {
        var archive = path.join(downloads, spec.ffmpeg.archive);
        var destination = path.join(root, 'ffmpeg', spec.ffmpeg.version);
        return downloadVerified(spec.ffmpeg.url, archive, spec.ffmpeg.sha256, 'FFmpeg', onProgress)
          .then(function () {
            report(onProgress, 'Installing FFmpeg…', 100);
            return extractZip(archive, destination, 'FFmpeg');
          }).then(function () {
            var executable = findBinary(destination, ['ffmpeg.exe']);
            if (!executable) throw new Error('ffmpeg.exe was not found in the verified package.');
            record.ffmpegSha256 = spec.ffmpeg.sha256;
            record.ffmpegExe = path.relative(root, executable);
            try { fs.unlinkSync(archive); } catch (_) {}
            writeRecord(root, record);
          });
      });
    }

    var installedModel = record.models[model];
    var installedModelPath = installedModel && safePath(root, installedModel.path);
    if (!installedModel || installedModel.sha256 !== modelSpec.sha256 ||
        !installedModelPath || !fs.existsSync(installedModelPath)) {
      chain = chain.then(function () {
        var destination = path.join(root, 'models', modelSpec.file);
        return downloadVerified(modelSpec.url, destination, modelSpec.sha256,
          'Whisper ' + model + ' model', onProgress).then(function () {
            record.models[model] = { sha256: modelSpec.sha256, path: path.relative(root, destination) };
            writeRecord(root, record);
          });
      });
    }

    return chain.then(function () {
      var runtime = resolveRuntime(spec, model);
      if (!runtime) throw new Error('Local Whisper runtime did not pass its installation check.');
      return runtime;
    });
  }

  function runProcess(executable, args, label, onProgress) {
    return new Promise(function (resolve, reject) {
      var proc = cp.spawn(executable, args, { windowsHide: true });
      var output = '';
      function collect(chunk) {
        output = (output + chunk.toString()).slice(-8000);
        var lines = chunk.toString().trim().split(/\r?\n/);
        var last = lines[lines.length - 1];
        if (last) report(onProgress, label + ': ' + last.slice(0, 140), 0);
      }
      proc.stdout.on('data', collect);
      proc.stderr.on('data', collect);
      proc.on('error', reject);
      proc.on('close', function (code) {
        if (code === 0) resolve(output);
        else reject(new Error(label + ' exited with code ' + code + (output ? ' — ' + output.slice(-350) : '')));
      });
    });
  }

  function parseWhisperJson(jsonPath) {
    var payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    var source = payload.transcription || payload.segments || [];
    var segments = [];

    source.forEach(function (segment) {
      var offsets = segment.offsets || {};
      var start = Number(offsets.from);
      var end = Number(offsets.to);
      start = isFinite(start) ? start / 1000 : Number(segment.start) || 0;
      end = isFinite(end) ? end / 1000 : Number(segment.end) || start;
      var text = String(segment.text || '').trim();
      var words = [];
      var current = null;

      function finishWord() {
        if (!current || !current.word) { current = null; return; }
        current.word = current.word.trim();
        if (current.word) words.push(current);
        current = null;
      }

      (segment.tokens || segment.words || []).forEach(function (token) {
        if (token.word !== undefined && token.start !== undefined) {
          finishWord();
          words.push({
            word: String(token.word).trim(),
            start: Number(token.start) || start,
            end: Number(token.end) || Number(token.start) || start
          });
          return;
        }
        var piece = String(token.text || '');
        if (/^\[[^\]]+\]$/.test(piece)) return;
        if (/^\s/.test(piece)) finishWord();
        piece = piece.replace(/^\s+/, '');
        if (!piece) return;
        var tokenOffsets = token.offsets || {};
        var from = isFinite(Number(tokenOffsets.from)) ? Number(tokenOffsets.from) / 1000 : start;
        var to = isFinite(Number(tokenOffsets.to)) ? Number(tokenOffsets.to) / 1000 : from;
        if (!current) current = { word: '', start: from, end: to };
        current.word += piece;
        current.end = Math.max(current.end, to);
      });
      finishWord();
      if (!text && words.length) text = words.map(function (word) { return word.word; }).join(' ');
      segments.push({ start: start, end: end, text: text, words: words });
    });

    return {
      segments: segments,
      language: payload.result && payload.result.language ? payload.result.language : payload.language,
      engine: 'local'
    };
  }

  function cleanupFiles(files) {
    files.forEach(function (file) {
      try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
    });
  }

  function transcribeAudio(filePath, language, model, options) {
    options = options || {};
    if (!filePath) return Promise.reject(new Error('Audio file path is required.'));
    if (!fs.existsSync(filePath)) return Promise.reject(new Error('Audio file not found: ' + filePath));
    var onProgress = options.onProgress;
    var runtime;
    var token = Date.now() + '_' + Math.floor(Math.random() * 100000);
    var wavPath = path.join(os.tmpdir(), 'orbit_local_whisper_' + token + '.wav');
    var outputPrefix = path.join(os.tmpdir(), 'orbit_local_whisper_' + token);
    var jsonPath = outputPrefix + '.json';

    return ensureRuntime(model || 'base', onProgress).then(function (resolved) {
      runtime = resolved;
      report(onProgress, 'Preparing audio locally…', 0);
      return runProcess(runtime.ffmpeg,
        ['-y', '-loglevel', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath],
        'FFmpeg', onProgress);
    }).then(function () {
      report(onProgress, options.translate ? 'Translating locally to English…' : 'Transcribing locally…', 0);
      var args = ['-m', runtime.model, '-f', wavPath, '-ojf', '-of', outputPrefix,
                  '-l', language || 'auto', '-pp', '-sow', '-sns'];
      if (options.translate) args.push('-tr');
      if (options.diarize) args.push('-di');
      return runProcess(runtime.whisper, args, 'Whisper', onProgress);
    }).then(function () {
      var result = parseWhisperJson(jsonPath);
      cleanupFiles([wavPath, jsonPath]);
      return result;
    }, function (error) {
      cleanupFiles([wavPath, jsonPath]);
      throw error;
    });
  }

  global.WhisperLocalAPI = {
    available: true,
    getStatus: getStatus,
    getDependencyStatus: getDependencyStatus,
    estimateDownloadMB: estimateDownloadMB,
    ensureRuntime: ensureRuntime,
    transcribeAudio: transcribeAudio,
    runtimeRoot: runtimeRoot,
    openRuntimeFolder: openRuntimeFolder
  };
})(typeof window !== 'undefined' ? window : this);
