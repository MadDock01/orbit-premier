/**
 * supabase.js — direct (read-only) Supabase access for preflight checks.
 *
 * The anon key + the SECURITY DEFINER RPC `check_license_usage` together
 * give us: tier, expires_at, used/limit minutes, and a limit_reached flag
 * — without exposing anything else in the licenses or usage tables, and
 * without going through Modal (so no cold-start to check usage).
 */

(function (global) {
  'use strict';

  var SUPABASE_URL      = 'https://fwblhtzkddywrqouqyyt.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3YmxodHprZGR5d3Jxb3VxeXl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NTkzOTAsImV4cCI6MjA5MDQzNTM5MH0.YgiwKCDazAMQ2jJ5oGSi6uXaKURNKBW7adEho7QFcCQ';

  /**
   * Fetch the user's current license + usage state.
   *
   * Resolves with:
   *   { valid: true,  tier, expires_at, used_minutes, limit_minutes, limit_reached }
   *   { valid: false, reason: 'invalid' | 'inactive' | 'expired', expires_at? }
   *
   * Rejects on network/HTTP failure — callers should treat rejection as
   * "couldn't preflight" and proceed; Modal still enforces server-side.
   */
  /**
   * Fetch the signed-in user's transcription usage for the meter.
   *
   * Resolves with { used_day, used_month, limit_day, limit_month }
   * (numerics) or null when unauthenticated. Rejects on network/HTTP
   * failure — callers treat rejection as "couldn't preflight" and
   * proceed; Modal still enforces server-side.
   */
  function getMyUsage(authToken) {
    if (!authToken) return Promise.resolve(null);
    return fetch(SUPABASE_URL + '/rest/v1/rpc/get_my_usage', {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + authToken,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ p_product_id: 'machicut' })
    }).then(function (res) {
      if (!res.ok) throw new Error('usage preflight HTTP ' + res.status);
      return res.json();
    }).then(function (rows) {
      var r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) return null;
      return {
        used_day:    Number(r.used_day)    || 0,
        used_month:  Number(r.used_month)  || 0,
        limit_day:   Number(r.limit_day)   || 0,
        limit_month: Number(r.limit_month) || 0
      };
    });
  }

  /**
   * Tier-aware caption status for the usage meter. The server decides
   * paid vs free (via entitlement) and returns the matching used/limit,
   * so the panel renders either without knowing the user's plan.
   *
   * Resolves { tier: 'paid'|'free', used, limit } or null when
   * unauthenticated. Rejects on network/HTTP failure — callers stay
   * silent and let Modal enforce on the actual transcribe.
   */
  function getCaptionStatus(authToken, deviceId) {
    if (!authToken) return Promise.resolve(null);
    return fetch(SUPABASE_URL + '/rest/v1/rpc/get_caption_status', {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + authToken,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ p_device_id: deviceId || null })
    }).then(function (res) {
      if (!res.ok) throw new Error('caption status HTTP ' + res.status);
      return res.json();
    }).then(function (rows) {
      var r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) return null;
      return { tier: r.tier, used: Number(r.used) || 0, limit: Number(r.lim) || 0 };
    });
  }

  /**
   * Gate preflight for ANY one-time tool. Resolves { owns, freeLeft } or
   * null when unauthenticated. owns = live Pro sub (Pro includes every
   * tool) OR that tool's lifetime purchase. freeLeft comes from
   * products.free_uses metered per device.
   */
  function getToolStatus(authToken, productId, deviceId) {
    if (!authToken || !productId) return Promise.resolve(null);
    return fetch(SUPABASE_URL + '/rest/v1/rpc/tool_status', {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + authToken,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ p_product_id: productId, p_device_id: deviceId || null })
    }).then(function (res) {
      if (!res.ok) throw new Error('tool status HTTP ' + res.status);
      return res.json();
    }).then(function (rows) {
      var r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) return null;
      return { owns: !!r.owns, freeLeft: Number(r.free_left) || 0 };
    });
  }

  /** Consume one free use of a tool on this device (no-op for owners). */
  function reserveToolFree(authToken, productId, deviceId) {
    if (!authToken || !productId) return Promise.resolve(null);
    return fetch(SUPABASE_URL + '/rest/v1/rpc/tool_reserve_free', {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + authToken,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ p_product_id: productId, p_device_id: deviceId || null })
    }).then(function (res) {
      if (!res.ok) throw new Error('tool reserve HTTP ' + res.status);
      return res.json();
    }).then(function (rows) {
      var r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) return null;
      return { allowed: !!r.allowed, remaining: Number(r.remaining) || 0 };
    });
  }

  /**
   * 3D Carousel gate preflight. Resolves { owns, freeLeft } or null when
   * unauthenticated. owns = active Pro sub OR the $29 lifetime purchase.
   * (Kept for older callers — prefer getToolStatus.)
   */
  function getC3DStatus(authToken, deviceId) {
    if (!authToken) return Promise.resolve(null);
    return fetch(SUPABASE_URL + '/rest/v1/rpc/c3d_status', {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + authToken,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ p_device_id: deviceId || null })
    }).then(function (res) {
      if (!res.ok) throw new Error('c3d status HTTP ' + res.status);
      return res.json();
    }).then(function (rows) {
      var r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) return null;
      return { owns: !!r.owns, freeLeft: Number(r.free_left) || 0 };
    });
  }

  /**
   * Consume the device's single free 3D export (no-op for entitled users).
   * Resolves { allowed, remaining } or null when unauthenticated.
   */
  function reserveC3DExport(authToken, deviceId) {
    if (!authToken) return Promise.resolve(null);
    return fetch(SUPABASE_URL + '/rest/v1/rpc/c3d_reserve_export', {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + authToken,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ p_device_id: deviceId || null })
    }).then(function (res) {
      if (!res.ok) throw new Error('c3d reserve HTTP ' + res.status);
      return res.json();
    }).then(function (rows) {
      var r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) return null;
      return { allowed: !!r.allowed, remaining: Number(r.remaining) || 0 };
    });
  }

  global.SupabaseAPI = {
    getMyUsage:       getMyUsage,
    getCaptionStatus: getCaptionStatus,
    getToolStatus:    getToolStatus,
    reserveToolFree:  reserveToolFree,
    getC3DStatus:     getC3DStatus,
    reserveC3DExport: reserveC3DExport
  };

  /**
   * ToolGate — the whole paid-tool gate in one call, so a new one-time
   * tool needs no backend work and no bespoke gating code:
   *
   *   ToolGate.check('my-tool', { promoUntil: Date.parse('...') },
   *     function (proceed, usedFree) { if (proceed) run(); });
   *   ToolGate.consume('my-tool');   // after the gated action SUCCEEDS
   *
   * Rules (identical for every tool): dev installs and an active promo
   * bypass; owners proceed; otherwise spend a free use; when none remain
   * the caller's onBlocked runs (show an upgrade card). FAILS OPEN on any
   * network/auth error — a paying user must never be blocked by a
   * client-side check.
   */
  function _deviceId() {
    try { return (global.FFmpegAPI && FFmpegAPI.getDeviceId) ? FFmpegAPI.getDeviceId() : null; }
    catch (_) { return null; }
  }
  function _isDev() {
    try { return !!(global.Updater && Updater.isDevInstall && Updater.isDevInstall()); }
    catch (_) { return false; }
  }
  global.ToolGate = {
    check: function (productId, opts, cb) {
      opts = opts || {};
      if (typeof cb !== 'function') cb = function () {};
      if (_isDev() || (opts.promoUntil && Date.now() < opts.promoUntil)) { cb(true, false); return; }
      var tokenP = null;
      try { tokenP = (global.AuthAPI && AuthAPI.getAccessToken) ? AuthAPI.getAccessToken() : null; } catch (_) {}
      if (!tokenP) { cb(true, false); return; }               // no auth layer (browser preview)
      tokenP.then(function (tok) {
        if (!tok) { cb(true, false); return; }                // signed out — authGate owns that UX
        return getToolStatus(tok, productId, _deviceId()).then(function (st) {
          if (!st || st.owns) { cb(true, false); return; }
          if (st.freeLeft > 0) { cb(true, true); return; }    // spend it on SUCCESS, not now
          if (typeof opts.onBlocked === 'function') opts.onBlocked();
          cb(false, false);
        });
      }).catch(function () { cb(true, false); });             // fail open
    },
    consume: function (productId) {
      try {
        AuthAPI.getAccessToken().then(function (tok) {
          if (tok) reserveToolFree(tok, productId, _deviceId()).catch(function () {});
        }).catch(function () {});
      } catch (_) {}
    },
    // Read-only ownership check, for upsell UI that must never appear to
    // someone who already owns the thing. cb(false) on any error, so a
    // hiccup shows nothing rather than nagging a paying customer.
    owns: function (productId, cb) {
      if (typeof cb !== 'function') return;
      try {
        var tokenP = (global.AuthAPI && AuthAPI.getAccessToken) ? AuthAPI.getAccessToken() : null;
        if (!tokenP) { cb(false); return; }
        tokenP.then(function (tok) {
          if (!tok) { cb(false); return; }
          return getToolStatus(tok, productId, _deviceId())
            .then(function (st) { cb(!!(st && st.owns)); });
        }).catch(function () { cb(true); });   // unknown → treat as owner → stay quiet
      } catch (_) { cb(true); }
    }
  };

}(window));
