/**
 * ux.js — lightweight, anonymous product-analytics event logger.
 *
 * window.UX.track(event, props) fires one row into the ux_events table
 * (device_id + version + optional signed-in user_id + props). Purely
 * fire-and-forget: never throws, never blocks, silently drops on any
 * failure. Dev checkouts don't log (same rule as plugin_logs) so the
 * funnel isn't polluted by in-progress work.
 *
 * Goal: understand where users click / drop off — especially the
 * free->paid wall funnel (generate -> wall -> upgrade_shown ->
 * upgrade_click -> checkout_opened).
 */
(function (global) {
  'use strict';

  var SUPABASE_URL  = 'https://fwblhtzkddywrqouqyyt.supabase.co';
  var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3YmxodHprZGR5d3Jxb3VxeXl0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NTkzOTAsImV4cCI6MjA5MDQzNTM5MH0.YgiwKCDazAMQ2jJ5oGSi6uXaKURNKBW7adEho7QFcCQ';

  function _isDev() {
    try { return !!(global.Updater && Updater.isDevInstall && Updater.isDevInstall()); }
    catch (_) { return false; }
  }
  function _deviceId() {
    try { return (global.FFmpegAPI && FFmpegAPI.getDeviceId) ? FFmpegAPI.getDeviceId() : null; }
    catch (_) { return null; }
  }
  function _version() {
    try {
      var v = global.Updater && Updater.getCurrentVersion && Updater.getCurrentVersion();
      return v ? (v.version + (v.channel === 'dev' ? '-dev' : '')) : null;
    } catch (_) { return null; }
  }
  function _userId() {
    try {
      var u = global.AuthAPI && AuthAPI.getUser && AuthAPI.getUser();
      return (u && u.user_id) ? u.user_id : null;
    } catch (_) { return null; }
  }

  function track(event, props) {
    try {
      if (!event || _isDev()) return;
      var body = {
        device_id: _deviceId(),
        user_id:   _userId(),
        event:     String(event).slice(0, 60),
        props:     props || null,
        version:   _version()
      };
      fetch(SUPABASE_URL + '/rest/v1/ux_events', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON,
          'Authorization': 'Bearer ' + SUPABASE_ANON,
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify(body)
      }).catch(function () {});
    } catch (_) {}
  }

  global.UX = { track: track };
}(window));
