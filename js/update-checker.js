/**
 * CompX Orbit Premiere — Intelligent Auto-Update Checker
 * Automatically checks for extension updates and notifies the user in-app.
 */
(function (window) {
  "use strict";

  const CONFIG = {
    currentVersion: "2.5.0",
    slug: "orbit-premiere",
    apiEndpoint: "https://compxorbit.com/api/extension/update-check",
    checkIntervalMs: 6 * 60 * 60 * 1000, // Check every 6 hours
    dismissCooldownMs: 24 * 60 * 60 * 1000, // 24 hours dismissal cooldown
  };

  class OrbitPremiereUpdateChecker {
    constructor() {
      this.csInterface = window.__adobe_cep__ ? new CSInterface() : null;
      this.updateData = null;
    }

    async checkForUpdates(force = false) {
      try {
        const lastCheck = parseInt(localStorage.getItem("compx_pr_last_update_check") || "0", 10);
        const dismissedUntil = parseInt(localStorage.getItem("compx_pr_update_dismissed_until") || "0", 10);
        const now = Date.now();

        if (!force) {
          if (now < dismissedUntil) return;
          if (now - lastCheck < CONFIG.checkIntervalMs) return;
        }

        localStorage.setItem("compx_pr_last_update_check", now.toString());

        const res = await fetch(
          `${CONFIG.apiEndpoint}?slug=${CONFIG.slug}&version=${CONFIG.currentVersion}&hostApp=PPRO`,
          {
            method: "GET",
            headers: { "Content-Type": "application/json" },
          }
        );

        if (!res.ok) return;
        const data = await res.json();

        if (data && data.hasUpdate) {
          this.updateData = data;
          this.showUpdateBanner(data);
        }
      } catch (err) {
        console.warn("[OrbitPremiereUpdateChecker] Check failed:", err);
      }
    }

    showUpdateBanner(data) {
      const existing = document.getElementById("orbit-pr-update-banner");
      if (existing) existing.remove();

      const banner = document.createElement("div");
      banner.id = "orbit-pr-update-banner";
      banner.style.cssText = `
        position: fixed;
        top: 8px;
        left: 8px;
        right: 8px;
        z-index: 999999;
        background: linear-gradient(135deg, rgba(7, 19, 11, 0.95), rgba(15, 35, 20, 0.98));
        border: 1px solid rgba(69, 198, 109, 0.5);
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.6), 0 0 15px rgba(69, 198, 109, 0.2);
        border-radius: 10px;
        padding: 10px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        backdrop-filter: blur(8px);
        animation: orbitSlideDown 0.3s ease-out;
      `;

      banner.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
          <span style="font-size: 14px;">🚀</span>
          <div style="min-width: 0;">
            <div style="font-weight: 800; color: #45c66d; letter-spacing: 0.3px;">
              Orbit Premiere Update: v${data.latestVersion}
            </div>
            <div style="color: #aab0bd; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              Faster cuts, typography presets & workflow improvements.
            </div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
          <button id="orbit-pr-btn-update" style="
            background: #45c66d;
            color: #041008;
            font-weight: 800;
            font-size: 10px;
            border: none;
            border-radius: 6px;
            padding: 5px 10px;
            cursor: pointer;
            transition: all 0.2s;
          ">Update Now ⬇</button>
          <button id="orbit-pr-btn-dismiss" style="
            background: transparent;
            color: #717682;
            font-size: 12px;
            border: none;
            padding: 4px;
            cursor: pointer;
          ">✕</button>
        </div>
      `;

      document.body.prepend(banner);

      document.getElementById("orbit-pr-btn-update")?.addEventListener("click", () => {
        const targetUrl = data.downloadUrl || data.dashboardUrl || "https://compxorbit.com/dashboard";
        if (window.cep && cep.util && cep.util.openURLInDefaultBrowser) {
          cep.util.openURLInDefaultBrowser(targetUrl);
        } else {
          window.open(targetUrl, "_blank");
        }
      });

      document.getElementById("orbit-pr-btn-dismiss")?.addEventListener("click", () => {
        localStorage.setItem("compx_pr_update_dismissed_until", (Date.now() + CONFIG.dismissCooldownMs).toString());
        banner.remove();
      });
    }
  }

  window.OrbitPremiereUpdateChecker = new OrbitPremiereUpdateChecker();
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(() => window.OrbitPremiereUpdateChecker.checkForUpdates(), 2000);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(() => window.OrbitPremiereUpdateChecker.checkForUpdates(), 2000);
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
