/**
 * loginFlow.js — browser-handoff sign-in via Supabase Realtime Broadcast.
 *
 * Why Broadcast and not loopback:
 *   The earlier version of this file ran a local HTTP server on
 *   127.0.0.1 and had the landing page POST sign-in results to it.
 *   That triggers Chrome's Private Network Access permission prompt
 *   ("Allow machicut.store to access apps on this device?") AND on
 *   first run a Windows Defender Firewall prompt. Both are
 *   conversion-killers and confusing for non-technical editors.
 *
 *   Server-relay via Supabase Realtime Broadcast solves both at once:
 *   the plugin and the landing page join the same ephemeral channel
 *   named after a random state token; the landing page broadcasts
 *   the sign-in tokens to it; the plugin receives the broadcast as
 *   a Realtime event over its existing WebSocket. No localhost
 *   socket = no PNA prompt, no firewall.
 *
 * Flow:
 *   1. startLogin() generates a 32-char hex `state`.
 *   2. Opens a Supabase Realtime WebSocket and joins channel
 *      `realtime:plugin-signin:<state>` configured for broadcast.
 *   3. Launches the system browser at
 *      https://machicut.store/login?state=<state>.
 *   4. Landing page completes auth, calls mint-plugin-token to get
 *      a session_id, then broadcasts {access_token, refresh_token,
 *      session_id, ...} on the same channel.
 *   5. Plugin receives the broadcast → AuthAPI.adopt() → close
 *      channel → resolve.
 *
 * Security:
 *   - `state` is 128-bit cryptographic random — not enumerable.
 *   - The Realtime channel is ephemeral; the plugin closes it the
 *     instant tokens arrive. Anyone who later snoops the state can
 *     only join an empty channel.
 *   - Anyone who DOES intercept state during the ~30 s sign-in
 *     window (e.g. shoulder-surfing the URL) could subscribe to the
 *     channel and receive the same broadcast — same threat model as
 *     intercepting a magic-link URL itself.
 */
(function (global) {
  'use strict';

  var _req = (typeof require !== 'undefined') ? require
           : (typeof window !== 'undefined' && window.require) ? window.require
           : null;
  if (!_req) {
    global.LoginFlow = { _disabled: 'No Node available' };
    return;
  }
  var cp     = _req('child_process');
  var crypto = (function () { try { return _req('crypto'); } catch (_) { return null; } })();

  // ── Config — must match the values in auth.js / supabase.js ──────────
  var SUPABASE_URL      = 'https://fwblhtzkddywrqouqyyt.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3YmxodHprZGR5d3Jxb3VxeXl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NTkzOTAsImV4cCI6MjA5MDQzNTM5MH0.YgiwKCDazAMQ2jJ5oGSi6uXaKURNKBW7adEho7QFcCQ';

  var LANDING_LOGIN_URL   = 'https://machicut.store/login';
  // 15 minutes: the magic-link path involves email delivery + inbox
  // hunting (sometimes on a different device) — 5 min timed real users
  // out mid-flow.
  var CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;
  var BROADCAST_EVENT     = 'tokens';
  var POLL_INTERVAL_MS    = 4000;

  // ── State token ──────────────────────────────────────────────────────
  function _randomState() {
    if (crypto && crypto.randomBytes) {
      return crypto.randomBytes(16).toString('hex');
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // ── Browser launch (Win = rundll32, Mac = open, Linux = xdg-open) ────
  function _openInBrowser(url) {
    console.log('[loginFlow] opening browser at:', url);
    var platform = process.platform;
    try {
      if (platform === 'darwin') {
        cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else if (platform === 'win32') {
        // rundll32 is bulletproof — no shell, no quoting, no PATH lookup.
        try {
          cp.spawn('rundll32', ['url.dll,FileProtocolHandler', url],
            { detached: true, stdio: 'ignore' }).unref();
          return;
        } catch (e1) {
          console.warn('[loginFlow] rundll32 launch failed:', e1.message);
        }
        // Fallback for stripped-down Windows envs (rundll32 missing).
        try {
          cp.spawn(process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', 'start "" "' + url + '"'],
            { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }
          ).unref();
        } catch (e2) {
          console.warn('[loginFlow] cmd start fallback failed:', e2.message);
        }
      } else {
        cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (e) {
      console.warn('[loginFlow] could not launch browser:', e.message);
    }
  }

  // ── Realtime channel subscriber ──────────────────────────────────────
  // Opens a Supabase Realtime WebSocket and joins a broadcast channel
  // named after the state token. Resolves with the broadcast payload
  // the landing page sends after sign-in. Rejects on timeout.
  function _waitForBroadcast(state) {
    return new Promise(function (resolve, reject) {
      var topic = 'realtime:plugin-signin:' + state;
      var wsUrl = SUPABASE_URL.replace(/^http/, 'ws') +
                  '/realtime/v1/websocket?apikey=' + encodeURIComponent(SUPABASE_ANON_KEY) +
                  '&vsn=1.0.0';
      var ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        reject(new Error('Realtime connect failed: ' + e.message));
        return;
      }

      var settled = false;
      var heartbeat = null;
      var timeoutId = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Login timed out. Try again from the plugin.'));
      }, CALLBACK_TIMEOUT_MS);

      function cleanup() {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        clearTimeout(timeoutId);
        try { if (ws && ws.readyState !== 3) ws.close(); } catch (_) {}
      }

      ws.addEventListener('open', function () {
        // Join the broadcast channel. `self: false` means we don't
        // receive our own broadcasts (we never send any from here
        // anyway). `ack: false` means we don't wait for ack.
        var join = {
          topic:   topic,
          event:   'phx_join',
          payload: {
            config: {
              broadcast: { ack: false, self: false }
            }
          },
          ref: 'join_' + Date.now()
        };
        ws.send(JSON.stringify(join));

        // Heartbeat every 25 s so the connection stays open.
        heartbeat = setInterval(function () {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'hb_' + Date.now()
            }));
          }
        }, 25000);
      });

      ws.addEventListener('message', function (ev) {
        var data;
        try { data = JSON.parse(ev.data); } catch (_) { return; }
        // Broadcast events arrive with event='broadcast' on the outer
        // envelope; the user payload is nested inside.
        if (data.topic !== topic) return;
        if (data.event !== 'broadcast') return;
        var inner = data.payload || {};
        if (inner.event !== BROADCAST_EVENT) return;
        var payload = inner.payload || {};
        if (settled) return;
        settled = true;
        cleanup();
        resolve(payload);
      });

      ws.addEventListener('error', function () {
        if (settled) return;
        // Don't reject immediately — the close handler will fire and
        // we want a single failure path. The timeout still applies.
      });
      ws.addEventListener('close', function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Realtime channel closed unexpectedly.'));
      });
    });
  }

  // ── Polling fallback ─────────────────────────────────────────────────
  // The landing page stashes the token payload server-side (keyed by the
  // state secret) right before broadcasting. Polling claim_login_handoff
  // delivers sign-in even when this machine's websocket is blocked
  // (antivirus/proxy) or the user completed sign-in on ANOTHER device.
  // The claim is one-shot server-side; a null response means "not yet".
  function _claimHandoff(state) {
    return fetch(SUPABASE_URL + '/rest/v1/rpc/claim_login_handoff', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ p_state: state })
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    });
  }

  // ── Public ───────────────────────────────────────────────────────────
  // Two delivery paths race: the Realtime broadcast (instant when the
  // websocket works) and the claim poller (survives blocked websockets
  // and cross-device sign-ins). First payload wins; a websocket failure
  // is no longer fatal while the poller is alive — only the overall
  // timeout rejects.
  // ── Waiting modal ─────────────────────────────────────────────────────
  // Shown for the whole sign-in lifecycle so the user knows the browser
  // opened and what to do there (the button alone left them staring at a
  // spinner). Reopen re-launches the browser; Cancel aborts the wait.
  var _modalEl = null;
  function _showSigninModal(url, onReopen, onCancel) {
    _hideSigninModal();
    var el = document.createElement('div');
    el.id = 'mc-signin-modal';
    el.setAttribute('style',
      'position:fixed;top:0;right:0;bottom:0;left:0;z-index:10000;' +
      'display:flex;align-items:center;justify-content:center;padding:22px;' +
      'background:rgba(8,8,11,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6e6ea;');
    el.innerHTML =
      '<div style="background:#17171b;border:1px solid #2a2a33;border-radius:14px;' +
        'padding:24px 22px;width:100%;max-width:330px;text-align:center;">' +
        '<div class="mc-signin-spinner" style="width:34px;height:34px;margin:2px auto 14px;' +
          'border:3px solid #333;border-top-color:#4A8FE3;border-radius:50%;' +
          'animation:mc-spin 0.8s linear infinite;"></div>' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:8px;">Finish signing in</div>' +
        '<div style="font-size:12px;color:#9899a3;line-height:1.7;margin-bottom:16px;">' +
          'We opened MachiCut in your browser. Enter the <b>6-digit code</b> from your email — ' +
          'it works on any device. This panel unlocks by itself.</div>' +
        '<button id="mc-signin-reopen" style="width:100%;padding:9px 12px;margin-bottom:8px;' +
          'border:1px solid #333;border-radius:8px;background:transparent;color:#cfd0d6;' +
          'font-size:12px;cursor:pointer;">Reopen browser</button>' +
        '<button id="mc-signin-cancel" style="width:100%;padding:9px 12px;border:0;border-radius:8px;' +
          'background:transparent;color:#8a8a92;font-size:12px;cursor:pointer;">Cancel</button>' +
      '</div>';
    document.body.appendChild(el);
    _modalEl = el;
    // Keyframes (injected once).
    if (!document.getElementById('mc-signin-kf')) {
      var st = document.createElement('style');
      st.id = 'mc-signin-kf';
      st.textContent = '@keyframes mc-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    var reopen = document.getElementById('mc-signin-reopen');
    var cancel = document.getElementById('mc-signin-cancel');
    if (reopen) reopen.addEventListener('click', function () { if (onReopen) onReopen(); });
    if (cancel) cancel.addEventListener('click', function () { if (onCancel) onCancel(); });
  }
  function _hideSigninModal() {
    if (_modalEl && _modalEl.parentNode) _modalEl.parentNode.removeChild(_modalEl);
    _modalEl = null;
  }

  var _abortCurrent = null;

  function startLogin() {
    var state = _randomState();
    var url   = LANDING_LOGIN_URL + '?state=' + encodeURIComponent(state);

    var wait = new Promise(function (resolve, reject) {
      var settled   = false;
      var pollTimer = null;

      function stop() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        clearTimeout(timeoutId);
      }
      function finish(payload) {
        if (settled) return;
        settled = true;
        stop();
        resolve(payload);
      }
      // Exposed so the modal's Cancel (and cancelLogin()) can abort.
      _abortCurrent = function () {
        if (settled) return;
        settled = true;
        stop();
        var e = new Error('Sign-in cancelled.');
        e.cancelled = true;
        reject(e);
      };

      var timeoutId = setTimeout(function () {
        if (settled) return;
        settled = true;
        stop();
        reject(new Error('Login timed out. Try again from the plugin.'));
      }, CALLBACK_TIMEOUT_MS);

      // Path 1: Realtime broadcast. Subscribe FIRST, then open the
      // browser — the already-signed-in fast path could otherwise race
      // the subscription. Failure here is logged, not fatal.
      _waitForBroadcast(state).then(finish).catch(function (e) {
        console.warn('[loginFlow] realtime path failed (poller still active):', e.message);
      });

      // Path 2: claim poller.
      pollTimer = setInterval(function () {
        if (settled) return;
        _claimHandoff(state).then(function (payload) {
          if (payload && payload.access_token) finish(payload);
        }).catch(function () {});
      }, POLL_INTERVAL_MS);

      // Give the WebSocket a beat to join the channel before the page
      // could possibly broadcast — small but cheap insurance against
      // the already-signed-in fast path.
      setTimeout(function () { _openInBrowser(url); }, 250);
    });

    // Modal covers the whole wait.
    _showSigninModal(url,
      function () { _openInBrowser(url); },       // reopen
      function () { if (_abortCurrent) _abortCurrent(); });  // cancel

    return wait.then(function (payload) {
      _hideSigninModal();
      _abortCurrent = null;
      if (global.AuthAPI && typeof global.AuthAPI.adopt === 'function') {
        global.AuthAPI.adopt(payload);
      }
      return payload;
    }).catch(function (err) {
      _hideSigninModal();
      _abortCurrent = null;
      throw err;
    });
  }

  function cancelLogin() {
    if (_abortCurrent) _abortCurrent();
  }

  global.LoginFlow = {
    startLogin:  startLogin,
    cancelLogin: cancelLogin
  };

}(window));
