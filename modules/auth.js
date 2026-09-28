/**
 * auth.js — MachiCut plugin auth client.
 *
 * Responsibilities:
 *   • Persist the access token + refresh token + session id to disk
 *     (in the user-data folder, NOT localStorage — survives panel
 *     reloads and tracks the OS user).
 *   • Run a verify loop: on launch, then every 7 days, call
 *     verify_session() and lock the panel if it fails.
 *   • Open a Supabase Realtime subscription on the session row so
 *     "kicked from another device" locks the panel within seconds.
 *   • Expose `AuthAPI` (start, verify, sign out, get state, listen).
 *
 * Browser-login + loopback callback happens in loginFlow.js.
 *
 * Wire order in index.html (must come before authGate.js):
 *   <script src="utils/supabaseJs.js"></script>   (vendored client)
 *   <script src="modules/auth.js"></script>
 *   <script src="modules/loginFlow.js"></script>
 *   <script src="modules/authGate.js"></script>
 */
(function (global) {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────
  // Mirror the values used by client/utils/supabase.js (legacy preflight
  // call site). The licensing layer talks to the same project.
  var SUPABASE_URL      = 'https://fwblhtzkddywrqouqyyt.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3YmxodHprZGR5d3Jxb3VxeXl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NTkzOTAsImV4cCI6MjA5MDQzNTM5MH0.YgiwKCDazAMQ2jJ5oGSi6uXaKURNKBW7adEho7QFcCQ';
  var PRODUCT_ID        = 'machicut';

  // Session verify interval — Realtime WS is the primary channel for
  // revocation events, this is the backstop for when the WS is down or
  // misses a message. 15 minutes gives a bounded "shared-seat" window
  // while adding negligible load (1 RPC / user / 15 min).
  var VERIFY_INTERVAL_MS = 15 * 60 * 1000;

  // ── CEP / Node access ────────────────────────────────────────────────
  var _req = (typeof require !== 'undefined') ? require
           : (typeof window !== 'undefined' && window.require) ? window.require
           : null;
  if (!_req) {
    global.AuthAPI = { _disabled: 'No Node available — outside CEP?' };
    return;
  }
  var fs   = _req('fs');
  var path = _req('path');
  var os   = _req('os');

  // ── Token storage ────────────────────────────────────────────────────
  // Persist tokens in the OS user-data folder rather than localStorage
  // so a panel reload (or a clean of Premiere's cache) doesn't sign
  // the user out. The file is the canonical store.
  function _userDataDir() {
    var base;
    if (process.platform === 'darwin') {
      base = path.join(os.homedir(), 'Library', 'Application Support');
    } else if (process.platform === 'win32') {
      base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    } else {
      base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    }
    var dir = path.join(base, 'MachiCut');
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
  }
  var TOKEN_FILE = path.join(_userDataDir(), 'auth.json');

  function _loadTokens() {
    try {
      if (!fs.existsSync(TOKEN_FILE)) return null;
      var raw = fs.readFileSync(TOKEN_FILE, 'utf8');
      var obj = JSON.parse(raw);
      if (!obj || !obj.access_token || !obj.session_id) return null;
      return obj;
    } catch (_) { return null; }
  }
  function _saveTokens(obj) {
    try {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) { console.warn('[auth] could not persist tokens:', e.message); }
  }
  function _clearTokens() {
    try { if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE); } catch (_) {}
  }

  // ── Token refresh ────────────────────────────────────────────────────
  // Use the access token as long as it's not visibly expired (we know
  // expires_at from the handoff). Below ~3 minutes of remaining life,
  // hit Supabase's /auth/v1/token endpoint to swap the refresh token
  // for a fresh access token.
  function _accessTokenIsFresh(tokens) {
    if (!tokens || !tokens.expires_at) return false;
    var skewMs = 3 * 60 * 1000;
    var expiresMs = Number(tokens.expires_at) * 1000;
    return (expiresMs - Date.now()) > skewMs;
  }

  // Refresh failures come in two species and MUST be told apart:
  //   * fatal     — Supabase judged the refresh token dead (400/401/403,
  //                 e.g. invalid_grant after revocation). The session is
  //                 truly over; sign the user out.
  //   * transient — network unreachable, 5xx, 429. Supabase never saw or
  //                 never rejected the token; the session is still valid
  //                 server-side. Keep it and retry later. Treating these
  //                 as fatal (the old behavior) force-signed users out on
  //                 any connectivity blip even though their server session
  //                 was alive.
  // Errors are tagged err.fatal = true|false for callers.
  function _refreshTokens(tokens) {
    if (!tokens || !tokens.refresh_token) {
      var eNo = new Error('no refresh token');
      eNo.fatal = true;
      return Promise.reject(eNo);
    }
    return fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
      method:  'POST',
      headers: {
        'apikey':       SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refresh_token: tokens.refresh_token })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var e = new Error('refresh failed: ' + (body.error || body.error_code || res.status));
          e.status = res.status;
          e.fatal  = (res.status === 400 || res.status === 401 || res.status === 403);
          throw e;
        }
        var merged = Object.assign({}, tokens, {
          access_token:  body.access_token,
          refresh_token: body.refresh_token,
          expires_at:    body.expires_at  // unix seconds
        });
        _saveTokens(merged);
        // Hand the fresh JWT to the joined Realtime channel so it keeps
        // dispatching postgres_changes past the old JWT's exp. No-op if
        // WS not open yet — the next _openWs will carry the new token
        // via URL + phx_join.
        try { _pushWsAccessToken(merged.access_token); } catch (_) {}
        return merged;
      });
    }).catch(function (err) {
      if (err && err.fatal === undefined) err.fatal = false; // fetch/network error
      throw err;
    });
  }

  function _withFreshAccessToken(tokens) {
    if (_accessTokenIsFresh(tokens)) return Promise.resolve(tokens);
    return _refreshTokens(tokens);
  }

  // ── RPC: verify_session ──────────────────────────────────────────────
  // Returns { result, tokens } — tokens is the (possibly rotated) bag
  // that came back from _withFreshAccessToken. Callers MUST assign it
  // back into _currentTokens, otherwise a refresh done inside this call
  // is discarded and the next getAccessToken() reuses the rotated
  // refresh_token, hits Supabase with invalid_grant, and locks the panel.
  function _verifySession(tokens) {
    return _withFreshAccessToken(tokens).then(function (t) {
      return fetch(SUPABASE_URL + '/rest/v1/rpc/verify_session', {
        method:  'POST',
        headers: {
          'apikey':         SUPABASE_ANON_KEY,
          'Authorization':  'Bearer ' + t.access_token,
          'Content-Type':   'application/json'
        },
        body: JSON.stringify({ p_session_id: t.session_id })
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error('verify_session HTTP ' + res.status);
          return { result: body, tokens: t };
        });
      });
    });
  }

  // ── Realtime subscription (kick-on-newer-login) ──────────────────────
  // Supabase Realtime uses a WebSocket. CEP's Chromium has WebSocket
  // support, so we just open one to /realtime/v1/websocket with our
  // anon key and subscribe to changes on our specific session row.
  var _ws = null;
  var _wsHeartbeat = null;
  var _stateListeners = [];

  function _emitState(state) {
    _stateListeners.forEach(function (cb) {
      try { cb(state); } catch (_) {}
    });
  }

  function _closeWs() {
    if (_wsHeartbeat) { clearInterval(_wsHeartbeat); _wsHeartbeat = null; }
    if (_ws) {
      try { _ws.close(); } catch (_) {}
      _ws = null;
    }
  }

  // Track the joined topic + join ref so we can push access_token events
  // to it after a mid-connection refresh (Supabase Realtime v2 protocol).
  var _wsJoinedTopic = null;

  function _openWs(tokens, onRevoked) {
    _closeWs();
    // The WS MUST carry the user's JWT — the anon role has no read on
    // public.sessions (sessions_self_read RLS requires auth.uid() =
    // user_id), so postgres_changes UPDATEs on our session row would be
    // filtered out at the Realtime dispatcher. Send it BOTH as a URL
    // query param and in the phx_join payload.config.access_token so
    // either surface's checks pass.
    var accessToken = tokens.access_token;
    var wsUrl = SUPABASE_URL.replace(/^http/, 'ws') +
                '/realtime/v1/websocket?apikey=' + encodeURIComponent(SUPABASE_ANON_KEY) +
                '&access_token=' + encodeURIComponent(accessToken) +
                '&vsn=1.0.0';
    try {
      _ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[auth] WebSocket open failed:', e.message);
      return;
    }
    _ws.addEventListener('open', function () {
      // Subscribe to UPDATEs on our session row. access_token in
      // config.private / config.access_token is what Realtime uses to
      // evaluate RLS for the postgres_changes stream.
      var topic = 'realtime:public:sessions:id=eq.' + tokens.session_id;
      _wsJoinedTopic = topic;
      var join = {
        topic:   topic,
        event:   'phx_join',
        payload: {
          config: {
            access_token: accessToken,
            postgres_changes: [
              { event: 'UPDATE', schema: 'public', table: 'sessions',
                filter: 'id=eq.' + tokens.session_id }
            ]
          }
        },
        ref: 'join_' + Date.now()
      };
      _ws.send(JSON.stringify(join));

      // Heartbeat every 25s.
      _wsHeartbeat = setInterval(function () {
        if (_ws && _ws.readyState === 1) {
          _ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'hb_' + Date.now() }));
        }
      }, 25000);
    });
    _ws.addEventListener('message', function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }
      if (!data) return;
      // postgres_changes envelope (Realtime v2):
      //   { event:'postgres_changes',
      //     payload:{ data:{ schema, table, type:'UPDATE',
      //                     record:{...}, old_record:{...} } } }
      // Old code read data.payload.record which never populates — the
      // event was never handled and single-seat kick was silently broken.
      if (data.event !== 'postgres_changes') return;
      var p = data.payload && data.payload.data;
      var rec = p && (p.record || p['new']);
      if (rec && rec.revoked_at) {
        try { onRevoked(rec.revoked_reason || 'unknown'); } catch (_) {}
      }
    });
    _ws.addEventListener('close', function () {
      _wsJoinedTopic = null;
      // Reconnect after a delay using the CURRENT (possibly refreshed)
      // tokens so the new WS carries a valid JWT.
      if (_currentTokens) {
        setTimeout(function () {
          if (_currentTokens) _openWs(_currentTokens, onRevoked);
        }, 5000);
      }
    });
    _ws.addEventListener('error', function (e) {
      console.warn('[auth] WS error:', e && e.message);
    });
  }

  // Hand the joined channel a fresh JWT after a token refresh so
  // Realtime keeps dispatching postgres_changes past the old JWT's exp.
  // No-op if the WS isn't open or hasn't joined the topic yet.
  function _pushWsAccessToken(accessToken) {
    if (!_ws || _ws.readyState !== 1 || !_wsJoinedTopic) return;
    try {
      _ws.send(JSON.stringify({
        topic:   _wsJoinedTopic,
        event:   'access_token',
        payload: { access_token: accessToken },
        ref:     'tok_' + Date.now()
      }));
    } catch (_) { /* non-fatal */ }
  }

  // ── Public API ───────────────────────────────────────────────────────
  // States:
  //   'pending'   — initial, no decision yet
  //   'locked'    — no valid session; UI shows the lock screen
  //   'unlocked'  — verified; UI is usable
  //   'kicked'    — was unlocked, lost due to remote revocation
  var _state         = 'pending';
  var _currentTokens = null;
  var _verifyTimer   = null;

  function _setState(state) {
    if (_state === state) return;
    _state = state;
    _emitState(state);
  }

  function _scheduleVerifyTimer() {
    if (_verifyTimer) clearInterval(_verifyTimer);
    _verifyTimer = setInterval(function () {
      if (!_currentTokens) return;
      _verifySession(_currentTokens).then(function (out) {
        // Propagate any rotation done inside _verifySession.
        _currentTokens = out.tokens;
        var result = out.result;
        if (!result.valid) {
          _setState(result.reason === 'revoked' ? 'kicked' : 'locked');
          _clearTokens(); _currentTokens = null; _closeWs();
        }
      }).catch(function (err) {
        if (err && err.fatal) {
          // Refresh token definitively dead — end the session properly
          // instead of leaving a zombie unlocked panel.
          _setState('locked');
          _clearTokens(); _currentTokens = null; _closeWs();
          return;
        }
        /* transient — let the next tick retry */
      });
    }, VERIFY_INTERVAL_MS);
  }

  function start() {
    _setState('pending');
    var tokens = _loadTokens();
    if (!tokens) { _setState('locked'); return Promise.resolve('locked'); }
    _currentTokens = tokens;
    return _verifySession(tokens).then(function (out) {
      // Capture the rotated tokens — startup verify commonly triggers a
      // refresh because the disk copy is >1h old. Without this line the
      // in-memory refresh_token stays pre-rotation and the next
      // getAccessToken() hits Supabase invalid_grant, locking the panel.
      var result      = out.result;
      var freshTokens = out.tokens;
      _currentTokens  = freshTokens;
      if (result.valid) {
        _setState('unlocked');
        _openWs(freshTokens, function (reason) {
          _setState(reason === 'newer_login' ? 'kicked' : 'locked');
          _clearTokens(); _currentTokens = null; _closeWs();
        });
        _scheduleVerifyTimer();
        return 'unlocked';
      }
      _setState(result.reason === 'revoked' ? 'kicked' : 'locked');
      _clearTokens(); _currentTokens = null;
      return _state;
    }).catch(function (err) {
      console.warn('[auth] startup verify failed:', err && err.message);
      if (err && err.fatal) {
        // Refresh token definitively rejected — session is over.
        _clearTokens(); _currentTokens = null;
        _setState('locked');
        return 'locked';
      }
      // Transient failure (offline launch, Supabase blip): we HAVE
      // tokens on disk and the server never rejected them — unlock
      // optimistically. The old behavior showed the lock screen here,
      // which pushed users into a needless re-sign-in that revoked
      // their perfectly valid session (newer_login churn). Backend
      // calls will fail softly until connectivity returns, and the
      // 15-min verify timer re-checks legitimacy.
      _setState('unlocked');
      _openWs(_currentTokens, function (reason) {
        _setState(reason === 'newer_login' ? 'kicked' : 'locked');
        _clearTokens(); _currentTokens = null; _closeWs();
      });
      _scheduleVerifyTimer();
      return 'unlocked';
    });
  }

  // Called by loginFlow.js after the loopback callback receives the
  // handoff payload from the landing page.
  function adopt(payload) {
    if (!payload || !payload.access_token || !payload.session_id) {
      throw new Error('adopt: invalid payload');
    }
    _currentTokens = {
      access_token:  payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at:    payload.expires_at,
      session_id:    payload.session_id,
      user_id:       payload.user_id,
      email:         payload.email
    };
    _saveTokens(_currentTokens);
    _setState('unlocked');
    _openWs(_currentTokens, function (reason) {
      _setState(reason === 'newer_login' ? 'kicked' : 'locked');
      _clearTokens(); _currentTokens = null; _closeWs();
    });
    _scheduleVerifyTimer();
  }

  function signOut() {
    _closeWs();
    _clearTokens();
    _currentTokens = null;
    if (_verifyTimer) { clearInterval(_verifyTimer); _verifyTimer = null; }
    _setState('locked');
  }

  function getState() { return _state; }
  function getUser()  {
    if (!_currentTokens) return null;
    return { email: _currentTokens.email, user_id: _currentTokens.user_id };
  }
  // Exposed so downstream modules (autoCaptions, checkout preflight, etc.)
  // can present the Supabase session JWT to backend endpoints as
  // Authorization: Bearer <token>.
  //
  // Returns a Promise<string|null>. Refreshes the access token if it
  // is expired or within EXP_MARGIN_MS of expiry, using the stored
  // refresh_token. On refresh failure the session is downgraded to
  // 'locked' and null is returned so the caller can surface a
  // sign-in-required error rather than a 401 from the backend.
  //
  // The synchronous surface used to return the stale in-memory token
  // directly, which meant any downstream call more than an hour after
  // sign-in would 401 on Modal / Edge Functions — the refresh
  // machinery below existed but was only triggered by the weekly
  // _verifyTimer.
  function getAccessToken() {
    if (!_currentTokens) return Promise.resolve(null);
    return _withFreshAccessToken(_currentTokens).then(function (fresh) {
      _currentTokens = fresh;
      return fresh.access_token || null;
    }).catch(function (err) {
      if (err && err.fatal) {
        // Supabase judged the refresh token dead (revoked / rotated
        // away). The session is truly over — sign out explicitly so
        // the user doesn't chase silent 401s.
        _clearTokens();
        _currentTokens = null;
        _setState('locked');
        return null;
      }
      // Transient failure (network blip, Supabase 5xx): the server
      // session is still alive — DON'T destroy it. Hand back the
      // current token if it hasn't hard-expired (the margin check is
      // conservative; the token may still be accepted), else null so
      // the caller shows a soft "try again" instead of a sign-out.
      console.warn('[auth] token refresh failed transiently:', err && err.message);
      var t = _currentTokens;
      if (t && Number(t.expires_at) * 1000 > Date.now()) return t.access_token;
      return null;
    });
  }
  function onStateChange(cb) {
    if (typeof cb !== 'function') return function () {};
    _stateListeners.push(cb);
    return function () {
      _stateListeners = _stateListeners.filter(function (x) { return x !== cb; });
    };
  }

  global.AuthAPI = {
    start:          start,
    adopt:          adopt,
    signOut:        signOut,
    getState:       getState,
    getUser:        getUser,
    getAccessToken: getAccessToken,
    onStateChange:  onStateChange,
    _config:        { SUPABASE_URL: SUPABASE_URL, PRODUCT_ID: PRODUCT_ID }
  };

}(window));
