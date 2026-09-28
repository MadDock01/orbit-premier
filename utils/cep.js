/**
 * cep.js — CEP bridge helpers
 * Wraps CSInterface and provides promise-based evalScript + process launch.
 */

(function (global) {
  'use strict';

  // ── CSInterface singleton ──────────────────────────────────────────────────
  var _cs = null;

  function getCS() {
    if (!_cs) {
      if (typeof CSInterface === 'undefined') {
        throw new Error('CSInterface not found. Are you running inside Premiere Pro?');
      }
      _cs = new CSInterface();
    }
    return _cs;
  }

  // Reset the CSInterface when the PC wakes from sleep.
  // After sleep, the underlying IPC socket to Premiere's scripting engine can
  // become stale, causing evalScript callbacks to never fire. Re-creating
  // CSInterface on the next call re-establishes the connection.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        _cs = null; // force fresh CSInterface on next call
      }
    });
  }

  // ── evalScript (promise wrapper) ───────────────────────────────────────────
  /**
   * Calls a function in host/index.jsx and returns a Promise.
   * @param {string} fnName   - ExtendScript function name
   * @param {any[]}  args     - Arguments (will be JSON-serialized for strings/objects)
   * @returns {Promise<any>}
   */
  function evalScript(fnName, args, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        _cs = null; // stale connection — force fresh CSInterface on next call
        reject(new Error('Premiere did not respond — is a sequence open?'));
      }, timeoutMs || 10000);

      var cs;
      try { cs = getCS(); } catch (e) { clearTimeout(timer); reject(e); return; }

      var serialized = (args || []).map(function (a) {
        // JSON-encode, then \uXXXX-escape all non-ASCII: the CEP→ExtendScript transport
        // mangles raw UTF-8 (e.g. accented/Cyrillic/CJK user names in file paths), while
        // \u escapes are plain ASCII and decode identically on the other side.
        return JSON.stringify(a).replace(/[\u007f-\uffff]/g, function (ch) {
          return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
        });
      });
      // Wrap in try/catch so the actual error message is returned instead of
      // the opaque 'EvalScript error.' that CSInterface produces on throw.
      var innerCall = fnName + '(' + serialized.join(',') + ')';
      var call = '(function(){try{return ' + innerCall + '}catch(_e){return "__ERR__:"+_e.message}})()';

      cs.evalScript(call, function (result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!result || result === 'EvalScript error.') {
          reject(new Error('ExtendScript error in ' + fnName + ' (no result)'));
        } else if (result.indexOf('__ERR__:') === 0) {
          reject(new Error(result.slice('__ERR__:'.length)));
        } else {
          // Try to JSON-parse the result; fall back to raw string
          try {
            resolve(JSON.parse(result));
          } catch (_) {
            resolve(result);
          }
        }
      });
    });
  }

  // launchNodeServer was removed — FFmpeg now runs in-process via
  // utils/ffmpegLocal.js. Kept as a no-op so any straggling caller
  // doesn't throw, but it returns null and logs once to surface the
  // change during the migration.
  var _launchWarned = false;
  function launchNodeServer() {
    if (!_launchWarned) {
      _launchWarned = true;
      console.log('[CEP] launchNodeServer is a no-op — FFmpeg runs in-process now.');
    }
    return null;
  }

  // ── Extension info ─────────────────────────────────────────────────────────
  function getExtensionPath() {
    try {
      return getCS().getSystemPath(SystemPath.EXTENSION);
    } catch (_) {
      return '';
    }
  }

  function getHostEnvironment() {
    try {
      return getCS().getHostEnvironment();
    } catch (_) {
      return null;
    }
  }

  // No-op. MachiCut ships its own design-system palette and does not
  // inherit Premiere's host theme. Previously this set an inline
  // background-color on document.body from appSkinInfo, which silently
  // overrode the CSS --bg-base token (inline styles win specificity).
  function applyHostTheme() { /* intentionally no-op */ }

  // ── Exports ────────────────────────────────────────────────────────────────
  global.CEP = {
    evalScript: evalScript,
    launchNodeServer: launchNodeServer,
    getExtensionPath: getExtensionPath,
    getHostEnvironment: getHostEnvironment,
    applyHostTheme: applyHostTheme
  };

}(window));
