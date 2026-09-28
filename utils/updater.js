/**
 * updater.js — In-place auto-update for the MachiCut panel.
 *
 * On launch, fetches a remote manifest at UPDATE_MANIFEST_URL and compares
 * against the bundled ./version.json. If newer, downloads a patch zip,
 * extracts it over the install directory, and asks the user to reload.
 *
 * Files in the patch zip: client/, host/, CSXS/, version.json.
 * Native binaries (node/) and bundled fonts are NOT in patches — those
 * require a fresh PKG install (manifest will set requires_pkg_install=true).
 *
 * Quiet on failure: a network blip, malformed manifest, or write error
 * never breaks the panel — worst case, the user gets an updated panel
 * next time around.
 */

(function (global) {
  'use strict';

  var UPDATE_MANIFEST_URL = 'https://machicut.store/updates/latest.json';
  var LAST_CHECK_KEY      = 'machicut_last_update_check';
  // Tiny throttle (60 s) so a rapid panel close+reopen during dev/debug
  // doesn't fire two HTTP requests in a row, but every real launch checks.
  // Manifest is ~200 B, so even no throttle would be fine; this is just polite.
  var CHECK_INTERVAL_MS   = 60 * 1000;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getReq() {
    return (typeof require !== 'undefined') ? require : (window.require || null);
  }

  // Reads the current version from the latest git tag when running from a
  // dev checkout. This avoids the round-trip where tag → CI → bumped
  // version.json → git pull. The tag is the source of truth; we just ask
  // git directly. Returns e.g. "1.0.4" or null if git isn't available.
  function _versionFromGit() {
    try {
      var _req = getReq();
      if (!_req) return null;
      var cp = _req('child_process');
      var extPath = CEP.getExtensionPath();
      var out = cp.execSync('git describe --tags --abbrev=0', {
        cwd: extPath,
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return out.replace(/^v/, '') || null;
    } catch (_) { return null; }
  }

  function getCurrentVersion() {
    // Dev install: prefer the local git tag — always reflects the latest
    // tag *you* just made, no pull needed. Fall back to version.json if
    // git fails (uncommon — we already check isDevInstall first).
    if (isDevInstall()) {
      var gitVer = _versionFromGit();
      if (gitVer) return { version: gitVer, channel: 'dev' };
    }
    try {
      var _req = getReq();
      if (!_req) return null;
      var fs   = _req('fs');
      var path = _req('path');
      var p    = path.join(CEP.getExtensionPath(), 'version.json');
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) { return null; }
  }

  // Detects whether the panel is running from a dev checkout (the repo)
  // rather than a PKG-installed copy. The auto-update flow would otherwise
  // overwrite source files in the dev tree with the production zip on
  // every launch, nuking uncommitted work.
  function isDevInstall() {
    try {
      var _req = getReq();
      if (!_req) return false;
      var fs   = _req('fs');
      var path = _req('path');
      var extPath = CEP.getExtensionPath();
      return fs.existsSync(path.join(extPath, '.git')) ||
             fs.existsSync(path.join(extPath, 'brand-source'));
    } catch (_) { return false; }
  }

  // semver compare: returns 1 if a > b, -1 if a < b, 0 if equal.
  // Treats anything malformed as 0 so we never push a corrupt-version update.
  function semverCmp(a, b) {
    try {
      var pa = String(a).split('.').map(function (n) { return parseInt(n, 10) || 0; });
      var pb = String(b).split('.').map(function (n) { return parseInt(n, 10) || 0; });
      for (var i = 0; i < 3; i++) {
        var av = pa[i] || 0, bv = pb[i] || 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
      }
      return 0;
    } catch (_) { return 0; }
  }

  // Guard: only accept https URLs. We deliberately refuse plain http and
  // do NOT downgrade on redirects — an attacker who can flip the scheme
  // (or point us at http://) could feed us a tampered patch even if the
  // sha256 check is present, by racing the manifest fetch.
  function _isHttpsUrl(url) {
    return typeof url === 'string' && /^https:\/\//i.test(url);
  }

  // Build the request options. TLS validation is enforced (Node's default
  // rejectUnauthorized: true). We used to disable it to accommodate
  // AV-injected root CAs (Avast, Kaspersky, corporate MITM proxies), but
  // that also opened the door to real MITMs feeding us tampered patches.
  // Users behind such AV suites will need to trust our cert directly.
  function _httpOptionsFromUrl(_req, url) {
    var u = _req('url').parse(url);
    return {
      protocol: u.protocol,
      host:     u.hostname,
      port:     u.port,
      path:     u.path,
      method:   'GET'
    };
  }

  // GET a URL via Node https; follows up to 3 redirects. JSON-only helper.
  // Refuses non-https URLs — including on redirect targets.
  function fetchJson(url, callback, redirectsLeft) {
    var _req = getReq();
    if (!_req) { callback(new Error('no-require')); return; }
    if (redirectsLeft == null) redirectsLeft = 3;
    if (!_isHttpsUrl(url)) { callback(new Error('insecure-url')); return; }

    var lib = _req('https');
    var done = false;
    var safeCb = function (err, data) {
      if (done) return; done = true;
      callback(err, data);
    };

    var req = lib.request(_httpOptionsFromUrl(_req, url), function (res) {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        if (redirectsLeft <= 0) return safeCb(new Error('too-many-redirects'));
        return fetchJson(res.headers.location, callback, redirectsLeft - 1);
      }
      if (res.statusCode !== 200) {
        return safeCb(new Error('http-' + res.statusCode));
      }
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { body += d; });
      res.on('end', function () {
        try { safeCb(null, JSON.parse(body)); }
        catch (e) { safeCb(e); }
      });
    });
    req.setTimeout(8000, function () { req.destroy(new Error('timeout')); });
    req.on('error', safeCb);
    req.end();
  }

  // Stream a remote URL into a local file. Follows redirects.
  // Refuses non-https URLs — including on redirect targets.
  function downloadFile(url, destPath, callback, redirectsLeft) {
    var _req = getReq();
    if (!_req) { callback(new Error('no-require')); return; }
    if (redirectsLeft == null) redirectsLeft = 3;
    if (!_isHttpsUrl(url)) { callback(new Error('insecure-url')); return; }

    var fs  = _req('fs');
    var lib = _req('https');
    var done = false;
    var safeCb = function (err) { if (done) return; done = true; callback(err); };

    var req = lib.request(_httpOptionsFromUrl(_req, url), function (res) {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        if (redirectsLeft <= 0) return safeCb(new Error('too-many-redirects'));
        return downloadFile(res.headers.location, destPath, callback, redirectsLeft - 1);
      }
      if (res.statusCode !== 200) return safeCb(new Error('http-' + res.statusCode));

      var file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', function () { file.close(function () { safeCb(null); }); });
      file.on('error', function (e) {
        try { fs.unlinkSync(destPath); } catch (_) {}
        safeCb(e);
      });
    });
    req.setTimeout(60000, function () { req.destroy(new Error('timeout')); });
    req.on('error', safeCb);
    req.end();
  }

  // Extract a zip into the extension directory, overwriting existing files.
  // Uses OS-built-in commands: `unzip` on Mac, `tar` on Windows (Win 10+ ships tar).
  function extractZip(zipPath, callback) {
    var _req = getReq();
    if (!_req) { callback(new Error('no-require')); return; }
    var cp     = _req('child_process');
    var extDir = CEP.getExtensionPath();
    var isMac  = process.platform === 'darwin';

    var cmd, args;
    if (isMac) {
      cmd = 'unzip';
      args = ['-o', zipPath, '-d', extDir];
    } else {
      // tar on Windows handles zip via libarchive; works since Win 10 1803.
      cmd = 'tar';
      args = ['-xf', zipPath, '-C', extDir];
    }

    var proc = cp.spawn(cmd, args, { stdio: 'ignore' });
    var done = false;
    var safeCb = function (err) { if (done) return; done = true; callback(err); };
    proc.on('error', safeCb);
    proc.on('close', function (code) {
      safeCb(code === 0 ? null : new Error('extract-exit-' + code));
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * checkForUpdate(cb)
   *   cb(err, result)
   *     result = { available: bool, current: {...}, manifest: {...} }
   */
  function checkForUpdate(cb) {
    var current = getCurrentVersion();
    if (!current) return cb(new Error('no-version-file'));

    fetchJson(UPDATE_MANIFEST_URL, function (err, manifest) {
      if (err) return cb(err);
      if (!manifest || !manifest.version) return cb(new Error('bad-manifest'));

      try { localStorage.setItem(LAST_CHECK_KEY, String(Date.now())); } catch (_) {}

      var newer = semverCmp(manifest.version, current.version) > 0;
      cb(null, {
        available: newer,
        current:   current,
        manifest:  manifest
      });
    });
  }

  /**
   * applyUpdate(manifest, statusCb, doneCb)
   *   statusCb(message)        — progress updates ("Downloading…", "Applying…")
   *   doneCb(err, newVersion)  — final result
   */
  function applyUpdate(manifest, statusCb, doneCb) {
    if (isDevInstall()) {
      return doneCb(new Error('dev-install'));
    }
    if (!manifest || !manifest.patch_url) {
      return doneCb(new Error('no-patch-url'));
    }
    if (manifest.requires_pkg_install) {
      return doneCb(new Error('requires-pkg-install'));
    }
    // Reject non-https patch URLs — no http fallback.
    if (!_isHttpsUrl(manifest.patch_url)) {
      return doneCb(new Error('insecure-patch-url'));
    }
    // Require a well-formed sha256 in the manifest. Without it we have no
    // way to detect a tampered patch, so refuse to install rather than
    // trust the transport alone.
    var expectedSha = (typeof manifest.patch_sha256 === 'string')
      ? manifest.patch_sha256.toLowerCase()
      : '';
    if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
      return doneCb(new Error('missing-integrity-hash'));
    }

    var _req = getReq();
    if (!_req) return doneCb(new Error('no-require'));
    var os   = _req('os');
    var path = _req('path');
    var fs   = _req('fs');
    var zipPath = path.join(os.tmpdir(), 'machicut-update-' + manifest.version + '.zip');

    statusCb('Downloading v' + manifest.version + '…');
    downloadFile(manifest.patch_url, zipPath, function (err) {
      if (err) return doneCb(err);

      // Integrity check — mandatory, and must run BEFORE we hand the zip
      // to the OS extractor. A mismatched (or unreadable) archive is
      // deleted and the install aborts.
      var actual;
      try {
        var crypto = _req('crypto');
        var hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(zipPath));
        actual = hash.digest('hex').toLowerCase();
      } catch (e) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return doneCb(new Error('integrity-check-error: ' + e.message));
      }
      if (actual !== expectedSha) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return doneCb(new Error('integrity-check-failed'));
      }

      statusCb('Applying update…');
      extractZip(zipPath, function (err2) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        if (err2) return doneCb(err2);
        doneCb(null, manifest.version);
      });
    });
  }

  /**
   * checkOnLaunch()
   * Background auto-check, throttled to once per CHECK_INTERVAL_MS.
   * If newer, fires window.MachiCutUpdateAvailable event so the UI can prompt.
   * Silent on errors (bad network, etc).
   */
  function checkOnLaunch() {
    if (isDevInstall()) {
      console.log('[Updater] dev install detected — auto-update disabled');
      return;
    }
    try {
      var last = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10);
      if (Date.now() - last < CHECK_INTERVAL_MS) return;
    } catch (_) {}

    checkForUpdate(function (err, res) {
      if (err) { console.warn('[Updater] check failed:', err.message); return; }
      if (res.available) {
        try {
          window.dispatchEvent(new CustomEvent('MachiCutUpdateAvailable', { detail: res }));
        } catch (_) {}
      }
    });
  }

  // ── Exports ───────────────────────────────────────────────────────────────
  global.Updater = {
    getCurrentVersion: getCurrentVersion,
    isDevInstall:      isDevInstall,
    checkForUpdate:    checkForUpdate,
    applyUpdate:       applyUpdate,
    checkOnLaunch:     checkOnLaunch
  };

}(window));
