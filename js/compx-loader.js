/* Orbit Premiere secure bootstrap. Release builds update HASHES below. */
(function (window) {
  'use strict';
  var ENTRY_SCRIPTS = ['js/main.js', 'js/premiere-edition.js'];
  var HOST_FILE = '/jsx/hostscript.jsx';
  var HASHES = {
    "/jsx/hostscript.jsx": "64f2d7527c4ece6cf082db65746d25c2cc6aab5b98d65596250357f454456bba",
    "js/compx-license.js": "d36f4798facc9b0582e3568d9ab7187af6f2faa9cc07b457d8bfb0b7d1bc0b60",
    "js/license-gate.js": "a5029a09abfee9deeed588153cbd6e5484cad1dbc0e5ee26e1ebacdee5cec26e",
    "js/compxlib.js": "b11b7c15b37bbd4bca4508daa8a2a7b250b663e0529809917607378847f58512",
    "js/diagnostics.js": "b81888c6a2eee667e50b2dfa09c1eaa1445b4dfa620cce77a062370a58e9f335",
    "js/main.js": "a37bf9614bf37ca568182f01638d56b93a0728bf221f1db98c0f26c589889c53",
    "js/premiere-edition.js": "146632a93df4e88f12be50465a7f146d5a34bb1bfc6401b61a67e38c78813c53",
    "js/storage.js": "40f2540d6a13fe120daede55d620f4842e4baa458a576aac6820286d85c4bc96",
    "js/update-checker.js": "f24fd0f95f373cae17d0e5451a58347c7ba734d6ba857c6ef5cba5a78de9523d"
};
  var booted = false, blocked = false, bootPromise = null, bootNonce = Date.now();
  var nodeFs = null, nodePath = null, nodeCrypto = null;
  try { var nodeRequire = typeof require === 'function' ? require : window.require; if (typeof nodeRequire === 'function') { nodeFs = nodeRequire('fs'); nodePath = nodeRequire('path'); nodeCrypto = nodeRequire('crypto'); } } catch (ignore) {}
  function log(message) { try { console.log('[Orbit Loader] ' + message); } catch (ignore) {} }
  function fail(message) { if (blocked) return; blocked = true; try { document.dispatchEvent(new CustomEvent('integrity-error-detected', { detail: { message: message } })); } catch (ignore) {} log(message); if (typeof window.showLicenseError === 'function') window.showLicenseError('ERROR: ' + message, true); else alert('Orbit Studio Integrity Error:\n' + message); }
  function extensionPath() { try { var cs = window.csInterface || new CSInterface(); return cs.getSystemPath(SystemPath.EXTENSION); } catch (ignore) { return ''; } }
  function absolutePath(relativePath) { var root = extensionPath(); if (!root) return null; var cleaned = String(relativePath || '').replace(/^[/\\]+/, ''); return nodePath ? nodePath.join(root, cleaned) : root + '/' + cleaned; }
  function sha256(relativePath) { if (!nodeFs || !nodeCrypto) return null; var filePath = absolutePath(relativePath); if (!filePath || !nodeFs.existsSync(filePath)) return null; return nodeCrypto.createHash('sha256').update(nodeFs.readFileSync(filePath)).digest('hex'); }
  function verifyIntegrity() { if (!nodeFs || !nodeCrypto) return true; var failed = []; Object.keys(HASHES).forEach(function (relativePath) { var actual = sha256(relativePath); if (actual === null || actual !== HASHES[relativePath]) failed.push(relativePath); }); if (failed.length) { fail('Integrity check failed for: ' + failed.join(', ') + '. Reinstall this extension from a trusted package.'); return false; } return true; }
  function hasActiveLicense() {
    // Use the same verified status API as license-gate.js. The shipped
    // CompXLicense module does not expose an isActivated() method.
    return Promise.resolve().then(function () {
      if (!window.CompXLicense || typeof window.CompXLicense.check !== 'function') return false;
      return window.CompXLicense.check();
    }).then(function (status) {
      return !!(status && status.licensed === true);
    }).catch(function (error) { log('License check failed: ' + error); return false; });
  }
  function loadHostScript() {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { finish(false, 'Premiere host loading timed out.'); }, 20000);
      function finish(ok, detail) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (detail) log(detail);
        resolve(ok);
      }
      try {
        var cs = window.csInterface || new CSInterface();
        var filePath = absolutePath(HOST_FILE);
        if (!filePath) return finish(false, 'Extension path is unavailable.');
        var pathLiteral = JSON.stringify(filePath.replace(/\\/g, '/')).replace(/[\u007f-\uffff]/g, function (ch) {
          return '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4);
        });
        // evalFile inherits the caller's scope in ExtendScript. Keep it at
        // engine top level, not inside an IIFE whose declarations disappear.
        var script = 'try{$.evalFile(' + pathLiteral + ');"__ORBIT_HOST_LOADED__";}' +
          'catch(e){"Host load error: "+e.message;}';
        cs.evalScript(script, function (result) {
          if (settled) return;
          if (result !== '__ORBIT_HOST_LOADED__') return finish(false, String(result || 'No host response.'));
          // A separate bridge call proves the endpoints survived file loading.
          // Testing inside evalFile's calling scope can falsely report ready.
          try {
            cs.evalScript('(function(){return typeof orbitGetTrackList==="function"&&typeof getSequenceInfo==="function"?' +
              '"__ORBIT_HOST_READY__":"Host endpoints unavailable after loading";})()', function (probe) {
              finish(probe === '__ORBIT_HOST_READY__', probe === '__ORBIT_HOST_READY__' ? '' : String(probe || 'No host probe response.'));
            });
          } catch (error) { finish(false, 'Host probe failed: ' + error); }
        });
      } catch (error) { finish(false, 'Host script load failed: ' + error); }
    });
  }
  function injectScript(source) { return new Promise(function (resolve) { var script = document.createElement('script'); script.async = false; script.onload = function () { resolve(true); }; script.onerror = function () { log('Failed to load ' + source); resolve(false); }; script.src = source + (source.indexOf('?') >= 0 ? '&' : '?') + 't=' + bootNonce; document.head.appendChild(script); }); }
  function boot() {
    if (booted) return Promise.resolve(true);
    if (blocked) return Promise.resolve(false);
    if (bootPromise) return bootPromise;
    if (!verifyIntegrity()) return Promise.resolve(false);
    bootPromise = hasActiveLicense().then(function (licensed) {
      if (!licensed) { log('Waiting for license gate…'); return false; }
      return loadHostScript().then(function (loaded) {
        if (!loaded) { fail('Host script could not be loaded.'); return false; }
        return ENTRY_SCRIPTS.reduce(function (chain, source) {
          return chain.then(function (ok) { return ok ? injectScript(source) : false; });
        }, Promise.resolve(true));
      });
    }).then(function (ok) {
      booted = ok === true;
      bootPromise = null;
      if (booted) { document.dispatchEvent(new CustomEvent('host-loader-ready')); log('Panel ready'); }
      return booted;
    }).catch(function (error) { bootPromise = null; fail('Panel startup failed: ' + error); return false; });
    return bootPromise;
  }
  // license-gate initializes the service at DOMContentLoaded, then notifies us.
  // Do not race its initialization or treat an event alone as authorization.
  document.addEventListener('compx:licensed', boot);
  window.HostLoader = { boot: boot };
}(window));
