/** Orbit Core v1 — shared host, operation safety and diagnostics foundation. */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var HISTORY_KEY = 'orbit_core_history_v1';
  var active = Object.create(null);
  var history = loadHistory();
  var health = [];
  var queuedDiagnostics = [];
  var ui = {};

  function clean(value, limit) {
    return String(value == null ? '' : value)
      .replace(/([A-Za-z]:\\|\/Users\/|\/home\/)[^\s"']+/g, '[local-path]')
      .slice(0, limit || 600);
  }
  function message(error, fallback) {
    return clean(error && error.message ? error.message : (error || fallback || 'Operation failed.'), 900);
  }
  function loadHistory() {
    try {
      var data = JSON.parse(global.localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(data) ? data.slice(0, 30) : [];
    } catch (_) { return []; }
  }
  function saveHistory() {
    try { global.localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 30))); } catch (_) {}
  }
  function recordDiagnostic(level, code, title, detail, outcome) {
    var args = [level, code, clean(title), clean(detail, 1200), outcome];
    if (global.CompXDiagnostics && typeof global.CompXDiagnostics.record === 'function') {
      global.CompXDiagnostics.record.apply(global.CompXDiagnostics, args);
    } else {
      queuedDiagnostics.push(args);
      if (queuedDiagnostics.length > 50) queuedDiagnostics.shift();
    }
  }
  function flushDiagnostics() {
    if (!global.CompXDiagnostics || typeof global.CompXDiagnostics.record !== 'function') return;
    while (queuedDiagnostics.length) global.CompXDiagnostics.record.apply(global.CompXDiagnostics, queuedDiagnostics.shift());
  }
  function pushHistory(item) {
    history.unshift({
      id: clean(item.id, 80), title: clean(item.title, 100), state: item.state,
      message: clean(item.message, 500), time: new Date().toISOString(),
      durationMs: Math.max(0, Number(item.durationMs) || 0), safetyCopy: !!item.safetyCopy
    });
    history = history.slice(0, 30);
    saveHistory(); renderHistory();
  }

  function hostError(name, result) {
    var error = new Error((result && (result.error || result.message)) || ('Premiere rejected ' + name + '.'));
    error.code = 'HOST_RESULT_ERROR'; error.hostFunction = name; error.result = result;
    return error;
  }
  function retryable(error) { return /did not respond|timed out|timeout|stale connection/i.test(message(error)); }
  function hostCall(name, args, options) {
    options = options || {};
    var attempts = options.readOnly ? Math.max(1, Number(options.attempts) || 2) : 1;
    var timeout = Math.max(1000, Number(options.timeout) || 15000);
    function attempt(n) {
      if (!global.CEP || typeof global.CEP.evalScript !== 'function') {
        return Promise.reject(new Error('Premiere host bridge is unavailable. Reload the extension panel.'));
      }
      return global.CEP.evalScript(name, args || [], timeout).then(function (result) {
        var failed = result && typeof result === 'object' &&
          (result.success === false || result.error || result.ok === false);
        if (failed && !options.allowHostError) throw hostError(name, result);
        return result;
      }).catch(function (error) {
        if (n < attempts && retryable(error)) return attempt(n + 1);
        error = error instanceof Error ? error : new Error(message(error));
        error.hostFunction = error.hostFunction || name;
        throw error;
      });
    }
    return attempt(1);
  }

  function setCoreState(state, title) {
    if (!ui.badge) return;
    ui.badge.dataset.state = state;
    var label = ui.badge.querySelector('span');
    if (label) label.textContent = state === 'working' ? 'WORKING' : state === 'error' ? 'CHECK CORE' : 'CORE READY';
    if (title) ui.badge.title = title;
  }
  function updateStatus(config, phase, text, isError) {
    if (typeof config.onStatus === 'function') {
      try { config.onStatus(phase, text, !!isError); } catch (_) {}
    }
    if (ui.live) ui.live.textContent = (config.title || 'Orbit Core') + (text ? ' · ' + text : '');
    setCoreState(phase === 'working' ? 'working' : (isError ? 'error' : 'ready'), text);
  }
  function setButton(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (button._orbitHtml == null) button._orbitHtml = button.innerHTML;
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      if (label) button.innerHTML = '<span class="orbit-core-spinner"></span>' + clean(label, 40);
    } else {
      button.disabled = false; button.removeAttribute('aria-busy');
      if (button._orbitHtml != null) button.innerHTML = button._orbitHtml;
      button._orbitHtml = null;
    }
  }
  function confirmOperation(config) {
    if (!config.confirm) return Promise.resolve(true);
    var preview;
    try { preview = typeof config.preview === 'function' ? config.preview() : config.preview; }
    catch (_) { preview = 'Review the selected operation before applying it.'; }
    var body = String(preview || 'This operation will modify the active sequence.');
    var safety = typeof config.safetyCopy === 'function' ? !!config.safetyCopy() : !!config.safetyCopy;
    if (safety) body += '\n\nA safety copy of the active sequence will be created first.';
    if (typeof global.showModal === 'function') {
      return global.showModal({ title: config.title || 'Preview changes', message: body,
        okText: config.confirmText || 'Apply changes', cancelText: 'Cancel', danger: !!config.danger
      }).then(function (value) { return !!value; });
    }
    if (typeof global.showConfirm === 'function') {
      return new Promise(function (resolve) { global.showConfirm(body, function () { resolve(true); }, function () { resolve(false); }); });
    }
    return Promise.resolve(typeof global.confirm === 'function' ? global.confirm(body) : false);
  }

  function run(config) {
    config = config || {};
    var id = clean(config.id || config.title || 'operation', 80);
    var title = clean(config.title || 'Orbit operation', 100);
    if (active[id]) return Promise.reject(new Error(title + ' is already running.'));
    if (typeof config.execute !== 'function') return Promise.reject(new Error('Operation has no execute function.'));
    active[id] = true;
    var started = Date.now(), safetyMade = false, button = config.button || null;

    return Promise.resolve().then(function () { return confirmOperation(config); }).then(function (confirmed) {
      if (!confirmed) { var cancelled = new Error('Cancelled'); cancelled.code = 'OPERATION_CANCELLED'; throw cancelled; }
      setButton(button, true, config.busyLabel || 'Working…');
      updateStatus(config, 'working', config.startMessage || 'Preparing operation…', false);
      var context = {
        host: hostCall,
        status: function (value) { updateStatus(config, 'working', value, false); }
      };
      var wantsSafety = typeof config.safetyCopy === 'function' ? !!config.safetyCopy() : !!config.safetyCopy;
      var before = Promise.resolve().then(function () { return config.preflight ? config.preflight(context) : null; }).then(function () { return wantsSafety ? hostCall('ppro_duplicateActiveSequence', [true], { timeout: 20000 }).then(function (copy) {
        safetyMade = true; context.safetyCopy = copy;
        updateStatus(config, 'working', 'Safety sequence created. Applying changes…', false);
      }) : null; });
      return before.then(function () { return config.execute(context); });
    }).then(function (result) {
      var done = typeof config.successMessage === 'function' ? config.successMessage(result) :
        (config.successMessage || title + ' completed.');
      pushHistory({ id: id, title: title, state: 'success', message: done, durationMs: Date.now() - started, safetyCopy: safetyMade });
      recordDiagnostic('info', 'ORBIT_OPERATION_OK', done, id + ' · ' + (Date.now() - started) + 'ms', 'applied');
      updateStatus(config, 'success', done, false);
      if (config.toast !== false && typeof global.showToast === 'function') global.showToast(done);
      return result;
    }).catch(function (error) {
      if (error && error.code === 'OPERATION_CANCELLED') {
        updateStatus(config, 'cancelled', 'No changes were made.', false);
        return { cancelled: true };
      }
      var failure = message(error, title + ' failed.');
      pushHistory({ id: id, title: title, state: 'error', message: failure, durationMs: Date.now() - started, safetyCopy: safetyMade });
      recordDiagnostic('error', 'ORBIT_OPERATION_FAILED', failure, id + (error && error.hostFunction ? ' · ' + error.hostFunction : ''), 'failed');
      updateStatus(config, 'error', failure, true);
      if (config.toast !== false && typeof global.showToast === 'function') global.showToast(failure, true);
      if (typeof config.onError === 'function') config.onError(error);
      throw error;
    }).then(function (result) {
      active[id] = false; setButton(button, false); return result;
    }, function (error) {
      active[id] = false; setButton(button, false); throw error;
    });
  }

  function checked(name, promise, warnOnly) {
    return Promise.resolve(promise).then(function (detail) {
      return { name: name, status: 'pass', detail: clean(detail || 'Available', 180) };
    }).catch(function (error) {
      return { name: name, status: warnOnly ? 'warn' : 'fail', detail: message(error) };
    });
  }
  function healthCheck() {
    setCoreState('working', 'Running health check…');
    var storage = new Promise(function (resolve, reject) {
      try { var key = 'orbit_core_test'; global.localStorage.setItem(key, 'ok'); global.localStorage.removeItem(key); resolve('Preset and history storage available'); }
      catch (error) { reject(error); }
    });
    var host = hostCall('getSequenceInfo', [], { timeout: 7000, readOnly: true, attempts: 2, allowHostError: true }).then(function (result) {
      return result && result.error ? 'Connected · open a sequence for timeline tools' : 'Connected to Premiere';
    });
    // ComposerTools stays: it drives #orbitGlobalDock even though the Tools
    // rail is gone. Motion and Punch were removed entirely.
    var modules = ['OrbitRailRouter', 'ComposerTools', 'SilenceCutter', 'AutoCaptions', 'BeatPanel',
      'AudioPanel', 'MotionPanel', 'ProjectDoctor'];
    var moduleCount = modules.filter(function (name) { return !!global[name]; }).length;
    var routeViews = ['silenceCutterView', 'autoCaptionsView', 'beatView', 'audioView',
      'motionView', 'sfxMogrtView', 'projectDoctorView'];
    var routeCount = routeViews.filter(function (id) { return !!document.getElementById(id); }).length;
    var tracks = hostCall('orbitGetTrackList', [], { timeout: 8000, readOnly: true, attempts: 2, allowHostError: true })
      .then(function (result) {
        if (result && result.error && !/No active sequence/i.test(result.error)) throw new Error(result.error);
        return result && result.error ? 'Host endpoint ready · open a sequence to detect tracks' :
          ((result && result.tracks ? result.tracks.length : 0) + ' populated track(s) detected');
      });
    return Promise.all([
      checked('Premiere bridge', host),
      checked('Track discovery', tracks),
      checked('Local storage', storage),
      checked('Media runtime', global.FFmpegAPI ? Promise.resolve('FFmpeg tools loaded') : Promise.reject(new Error('FFmpeg tools unavailable')), true),
      checked('Feature modules', moduleCount === modules.length
        ? Promise.resolve(moduleCount + '/' + modules.length + ' rail modules active')
        : Promise.reject(new Error(moduleCount + '/' + modules.length + ' rail modules active')), true),
      checked('Rail views', routeCount === routeViews.length
        ? Promise.resolve(routeCount + '/' + routeViews.length + ' rail views wired')
        : Promise.reject(new Error(routeCount + '/' + routeViews.length + ' rail views wired')), true),
      checked('Diagnostics', global.CompXDiagnostics ? Promise.resolve('Sanitized local logging active') : Promise.reject(new Error('Diagnostics unavailable')), true)
    ]).then(function (items) {
      health = items; renderChecks();
      if (global.CompXDiagnostics && typeof global.CompXDiagnostics.setHealthChecks === 'function') global.CompXDiagnostics.setHealthChecks(items);
      var failed = items.filter(function (item) { return item.status === 'fail'; }).length;
      setCoreState(failed ? 'error' : 'ready', failed ? failed + ' critical check(s) failed' : 'All critical checks passed');
      return items;
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function renderHistory() {
    if (!ui.history) return;
    if (!history.length) { ui.history.innerHTML = '<div class="orbit-core-empty">No operations recorded yet.</div>'; return; }
    ui.history.innerHTML = history.slice(0, 12).map(function (item) {
      var time = ''; try { time = new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) {}
      return '<div class="orbit-core-history-item ' + item.state + '"><span class="orbit-core-history-icon">' +
        (item.state === 'success' ? '✓' : '!') + '</span><div><strong>' + escapeHtml(item.title) +
        '</strong><small>' + escapeHtml(item.message) + '</small></div><time>' + escapeHtml(time) + '</time></div>';
    }).join('');
  }
  function renderChecks() {
    if (!ui.checks) return;
    ui.checks.innerHTML = health.map(function (item) {
      return '<div class="orbit-core-check ' + item.status + '"><i></i><div><strong>' + escapeHtml(item.name) +
        '</strong><small>' + escapeHtml(item.detail) + '</small></div></div>';
    }).join('');
  }
  function reportText() {
    var lines = ['Orbit Core Diagnostic Report', 'Version: ' + VERSION, 'Generated: ' + new Date().toISOString()];
    if (health.length) {
      lines.push('', 'System health:');
      health.forEach(function (item) { lines.push('- [' + item.status.toUpperCase() + '] ' + item.name + ' — ' + item.detail); });
    }
    lines.push('', 'Recent operations:');
    history.forEach(function (item) { lines.push('- [' + item.state.toUpperCase() + '] ' + item.title + ' — ' + item.message + ' (' + item.durationMs + 'ms)'); });
    if (global.CompXDiagnostics && typeof global.CompXDiagnostics.reportText === 'function') lines.push('', global.CompXDiagnostics.reportText());
    return lines.join('\n');
  }
  function copyReport() {
    var report = reportText();
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) return global.navigator.clipboard.writeText(report);
    return new Promise(function (resolve, reject) {
      try {
        var area = document.createElement('textarea'); area.value = report; area.style.position = 'fixed'; area.style.left = '-9999px';
        document.body.appendChild(area); area.select(); var ok = document.execCommand('copy'); document.body.removeChild(area);
        if (!ok) throw new Error('Clipboard rejected the report.'); resolve(true);
      } catch (error) { reject(error); }
    });
  }
  function initUi() {
    if (document.getElementById('orbitCoreBadge')) return;
    // The badge used to live in the shell header, where it read as a stray
    // green dot next to the product name. It belongs with the other
    // diagnostics instead, in Project Doctor's action row; the header falls
    // back only if that panel is not in the document.
    var host = document.querySelector('#projectDoctorView .pd-actions') || document.querySelector('.pd-actions')
      || document.querySelector('.orbit-shell-header');
    if (!host) return;
    var badge = document.createElement('button'); badge.type = 'button'; badge.id = 'orbitCoreBadge'; badge.className = 'orbit-core-badge'; badge.dataset.state = 'ready';
    badge.innerHTML = '<i></i><span>Core status</span>'; badge.title = 'Open Orbit Core status'; host.appendChild(badge);
    var drawer = document.createElement('div'); drawer.id = 'orbitCoreDrawer'; drawer.className = 'orbit-core-drawer'; drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML = '<div class="orbit-core-backdrop" data-core-close></div><section class="orbit-core-sheet" role="dialog" aria-modal="true">' +
      '<header><div><span class="orbit-core-kicker">SYSTEM FOUNDATION</span><h2>Orbit Core <b>v' + VERSION + '</b></h2></div><button class="orbit-core-close" data-core-close>×</button></header>' +
      '<div class="orbit-core-live" aria-live="polite"></div><div class="orbit-core-actions"><button id="orbitCoreRunCheck">Run health check</button><button id="orbitCoreCopy">Copy report</button></div>' +
      '<h3>System health</h3><div class="orbit-core-checks"><div class="orbit-core-empty">Run a health check to verify this installation.</div></div>' +
      '<div class="orbit-core-history-head"><h3>Recent operations</h3><button id="orbitCoreClear">Clear</button></div><div class="orbit-core-history"></div></section>';
    document.body.appendChild(drawer);
    ui.badge = badge; ui.drawer = drawer; ui.live = drawer.querySelector('.orbit-core-live'); ui.checks = drawer.querySelector('.orbit-core-checks'); ui.history = drawer.querySelector('.orbit-core-history');
    renderHistory();
    function close() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); }
    badge.addEventListener('click', function () { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); flushDiagnostics(); });
    Array.prototype.forEach.call(drawer.querySelectorAll('[data-core-close]'), function (node) { node.addEventListener('click', close); });
    drawer.querySelector('#orbitCoreRunCheck').addEventListener('click', function () {
      var button = this; button.disabled = true; button.textContent = 'Checking…';
      healthCheck().catch(function (error) { if (global.showToast) global.showToast(message(error), true); }).then(function () { button.disabled = false; button.textContent = 'Run health check'; });
    });
    drawer.querySelector('#orbitCoreCopy').addEventListener('click', function () { copyReport().then(function () { if (global.showToast) global.showToast('Diagnostic report copied.'); }).catch(function (error) { if (global.showToast) global.showToast(message(error), true); }); });
    drawer.querySelector('#orbitCoreClear').addEventListener('click', function () { history = []; saveHistory(); renderHistory(); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') close(); });
    setTimeout(flushDiagnostics, 1500);
  }

  global.OrbitCore = Object.freeze({
    version: VERSION, host: Object.freeze({ call: hostCall }), run: run, healthCheck: healthCheck,
    getHistory: function () { return history.slice(); }, reportText: reportText, copyReport: copyReport,
    isActive: function (id) { return !!active[id]; }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi); else initUi();
})(window);
