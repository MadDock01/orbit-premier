/**
 * authGate.js — full-panel lock overlay that subscribes to AuthAPI.
 *
 * Renders one of three views over the panel:
 *
 *   'pending'   — invisible (no overlay yet, AuthAPI hasn't decided)
 *   'locked'    — sign-in prompt
 *   'kicked'    — "you signed in on another device" panel
 *
 * 'unlocked' removes the overlay entirely so the rest of MachiCut is
 * usable. The overlay is its own DOM tree appended to <body>, sits at
 * z-index 9999, and absorbs all pointer events so the user can't
 * accidentally click through into the still-rendered panel below.
 */
(function () {
  'use strict';

  function _ensureOverlay() {
    var el = document.getElementById('mc-auth-gate');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'mc-auth-gate';
    el.setAttribute('style',
      'position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 9999; display: none;' +  // top/right/bottom/left, not inset: CEP 9 (Chromium 61) ignores inset
      'background: rgba(8, 8, 11, 0.92);' +
      'backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);' +
      'align-items: center; justify-content: center; padding: 24px;' +
      'font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;' +
      'color: var(--text-1, #e2e2e8);'
    );
    document.body.appendChild(el);
    return el;
  }

  function _renderLocked(el, opts) {
    var headline = (opts && opts.headline) || 'Sign in to CompX Orbit';
    var subline  = (opts && opts.subline)  ||
      'Use your CompX Orbit account to unlock captions and silence cutting.';
    var btnLabel = (opts && opts.btnLabel) || 'Sign in';

    el.innerHTML =
      '<div style="background: var(--bg-modal, #151518); border: 1px solid #252530; ' +
      'border-radius: 14px; padding: 26px 24px; width: 100%; max-width: 340px; text-align: center;">' +
        '<div style="font-size: 28px; margin-bottom: 10px;">🔒</div>' +
        '<div style="font-size: 16px; font-weight: 600; margin-bottom: 6px;">' + headline + '</div>' +
        '<div style="font-size: 12px; color: #9899a3; margin-bottom: 18px;">' + subline + '</div>' +
        '<button id="mc-auth-signin-btn" style="' +
          'width: 100%; padding: 10px 14px; border: 0; border-radius: 8px; cursor: pointer; ' +
          'background: linear-gradient(180deg,#4A8FE3,#2A6BC5); color: #fff; ' +
          'font-size: 13px; font-weight: 500;">' + btnLabel + '</button>' +
        '<div id="mc-auth-status" style="margin-top: 12px; font-size: 11px; color: #9899a3;"></div>' +
        '<div style="margin-top: 16px; font-size: 11px; color: #68686f;">' +
          'No account? <a href="#" id="mc-auth-buy" style="color:#9bb9ef; text-decoration: underline;">Get CompX Orbit</a>' +
        '</div>' +
      '</div>';

    el.style.display = 'flex';

    var btn       = document.getElementById('mc-auth-signin-btn');
    var statusEl  = document.getElementById('mc-auth-status');
    var buyLink   = document.getElementById('mc-auth-buy');

    btn.addEventListener('click', function () {
      if (!window.LoginFlow || typeof window.LoginFlow.startLogin !== 'function') {
        statusEl.textContent = 'Login module not loaded — try a full panel reload.';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Opening browser…';
      statusEl.textContent = 'Complete sign-in in your browser. This window will unlock automatically.';
      window.LoginFlow.startLogin()
        .then(function () {
          // AuthAPI state listener will swap to unlocked → overlay hides.
          statusEl.textContent = 'Signed in.';
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Sign in';
          statusEl.textContent = 'Sign-in failed: ' + (err && err.message || err);
        });
    });

    if (buyLink) {
      buyLink.addEventListener('click', function (e) {
        e.preventDefault();
        // Open the public landing site so they can buy / sign up.
        try {
          var req = (typeof require !== 'undefined') ? require : null;
          if (req) {
            var cp = req('child_process');
            var url = 'https://machicut.store/';
            if (process.platform === 'darwin') cp.spawn('open', [url], { detached:true, stdio:'ignore' }).unref();
            else if (process.platform === 'win32') cp.spawn('cmd', ['/c', 'start', '""', url], { detached:true, stdio:'ignore' }).unref();
            else cp.spawn('xdg-open', [url], { detached:true, stdio:'ignore' }).unref();
          }
        } catch (_) {}
      });
    }
  }

  function _renderKicked(el) {
    _renderLocked(el, {
      headline: 'Signed in on another device',
      subline:  'CompX Orbit only allows one device at a time. ' +
                'Sign in here to take the seat back.',
      btnLabel: 'Sign in again'
    });
  }

  function _renderHidden(el) {
    el.style.display = 'none';
    el.innerHTML = '';
  }

  function _onState(state) {
    // Freemium: the panel is NEVER blocked. Silence cutting and manual/
    // SRT captions work with no account at all; AI transcription gates
    // itself at the Generate button (sign-in + free/paid + upgrade).
    // So the full-panel overlay is retired — we only keep AuthAPI's
    // verify cycle running (init() below) for token management. The
    // 'kicked' case is surfaced non-blockingly by the header account
    // chip instead of a wall.
    _renderHidden(_ensureOverlay());
  }

  function init() {
    if (!window.AuthAPI || typeof window.AuthAPI.onStateChange !== 'function') {
      console.warn('[authGate] AuthAPI not available — bypassing the gate.');
      return;
    }
    window.AuthAPI.onStateChange(_onState);
    _onState(window.AuthAPI.getState());
    // Kick off the verify cycle.
    if (typeof window.AuthAPI.start === 'function') {
      window.AuthAPI.start();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
