/* ============================================================
 * Wires the license gate overlay to CompXLicense.
 * Load AFTER compx-license.js and BEFORE main.js.
 *
 * Per-extension config — change these two lines only:
 *   Orbit Studio (AE):  slug 'orbit-studio',   hostApp 'AEFT'
 *   Orbit Premiere:     slug 'orbit-premiere', hostApp 'PPRO'
 * ============================================================ */
(function () {
  "use strict";

  var CONFIG = {
    slug: "orbit-premiere",
    hostApp: "PPRO",
    appVersion: "2.5.0",
    productName: "Orbit Premiere",
    siteUrl: "https://compxorbit.com"
  };

  var $ = function (id) { return document.getElementById(id); };
  var gate, input, btn, msg, deviceEl, graceEl, graceText;

  function show(text, kind) {
    msg.textContent = text || "";
    msg.className = "cx-gate__msg" + (kind ? " is-" + kind : "");
    input.classList.toggle("is-error", kind === "error" && !!text);
  }

  function openGate() {
    gate.hidden = false;
    document.body.classList.add("cx-locked");
    setTimeout(function () { input.focus(); }, 50);
  }

  function closeGate() {
    gate.hidden = true;
    document.body.classList.remove("cx-locked");
    document.dispatchEvent(new CustomEvent("compx:licensed", {
      detail: CompXLicense.claims()
    }));
  }

  function renderGrace() {
    var g = CompXLicense.graceInfo();
    if (!g) { graceEl.hidden = true; return; }
    graceEl.hidden = false;
    graceText.textContent = g.days > 0
      ? "Offline mode — " + g.days + " day" + (g.days === 1 ? "" : "s") + " of grace remaining"
      : "Offline grace has ended. Reconnect to keep using the panel.";
  }

  /* --------- pretty-print the key while typing --------- */
  function formatKey(raw) {
    var clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    var head = clean.slice(0, 2);
    var rest = clean.slice(2).match(/.{1,4}/g) || [];
    return rest.length ? head + "-" + rest.join("-") : head;
  }

  async function submit() {
    var key = input.value.trim();
    if (!key) { show("Please enter your license key.", "error"); return; }

    btn.disabled = true;
    btn.textContent = "Activating\u2026";
    show("Checking your license\u2026", "info");

    var res = await CompXLicense.activate(key);

    btn.disabled = false;
    btn.textContent = "Activate";

    if (res.ok) {
      show("Activated. Loading the panel\u2026", "ok");
      setTimeout(closeGate, 500);
      return;
    }

    show(res.error || "Activation failed.", "error");

    if (res.code === "DEVICE_LIMIT") {
      $("cx-gate-release").style.fontWeight = "600";
    }
  }

  async function releaseDevice() {
    if (!confirm(
      "Release this computer from your license?\n\n" +
      "You can activate on another computer straight away, but the next " +
      "device change will only be possible after 24 hours."
    )) return;

    show("Releasing\u2026", "info");
    var res = await CompXLicense.deactivate();
    if (res.ok) {
      input.value = "";
      show(res.message || "Device released.", "ok");
      openGate();
    } else {
      show(res.error || "Could not release this device.", "error");
    }
  }

  function openExternal(url) {
    try { global_cs().openURLInDefaultBrowser(url); }
    catch (e) { window.open(url, "_blank"); }
  }
  function global_cs() {
    return window.csInterface || new CSInterface();
  }

  /* ---------------------- boot ---------------------- */
  document.addEventListener("DOMContentLoaded", async function () {
    gate = $("cx-gate"); input = $("cx-gate-key"); btn = $("cx-gate-submit");
    msg = $("cx-gate-msg"); deviceEl = $("cx-gate-device");
    graceEl = $("cx-grace"); graceText = $("cx-grace-text");
    if (!gate) return;
    document.addEventListener("compx:tamper-detected", function (ev) {
      openGate();
      show((ev && ev.detail && ev.detail.message) || "Security check failed. Please reinstall the extension.", "error");
    });

    $("cx-gate-title").textContent = CONFIG.productName;

    CompXLicense.init(CONFIG);
    deviceEl.textContent = "This device: " + CompXLicense.deviceLabel();

    input.addEventListener("input", function () {
      var pos = input.selectionStart === input.value.length;
      input.value = formatKey(input.value);
      if (pos) input.setSelectionRange(input.value.length, input.value.length);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
    });

    btn.addEventListener("click", submit);
    $("cx-gate-release").addEventListener("click", function (e) {
      e.preventDefault(); releaseDevice();
    });
    $("cx-gate-buy").addEventListener("click", function (e) {
      e.preventDefault(); openExternal(CONFIG.siteUrl + "/#pricing");
    });
    $("cx-gate-dashboard").addEventListener("click", function (e) {
      e.preventDefault(); openExternal(CONFIG.siteUrl + "/dashboard");
    });
    $("cx-grace-retry").addEventListener("click", async function () {
      graceText.textContent = "Reconnecting\u2026";
      var r = await CompXLicense.heartbeat();
      if (r.revoked) { openGate(); show(r.error || "License no longer valid.", "error"); }
      renderGrace();
    });

    // ---- startup check (offline-first, so the panel opens instantly) ----
    var status = await CompXLicense.check();

    if (!status.licensed) {
      openGate();
      if (status.reason === "EXPIRED") {
        show("Your offline grace period ended. Please reconnect and activate again.", "info");
      } else if (status.reason === "CLOCK_TAMPER") {
        show("This computer's date and time look wrong, so we could not confirm " +
             "your licence offline. Please correct the clock or reconnect to the " +
             "internet, then try again.", "info");
      }
      return;
    }

    closeGate();
    renderGrace();
    CompXLicense.startHeartbeatTimer();

    // silent update check
    var update = await CompXLicense.checkForUpdate();
    if (update) {
      document.dispatchEvent(new CustomEvent("compx:update-available", { detail: update }));
    }
  });
})();
