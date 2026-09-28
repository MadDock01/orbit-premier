/* CompX diagnostics — sanitized local logging and copyable reports. */
(function (root) {
  "use strict";
  const req = typeof require === "function" ? require : (typeof root.require === "function" ? root.require : null);
  const fs = req ? req("fs") : null;
  const path = req ? req("path") : null;
  const os = req ? req("os") : null;
  const entries = [];
  const summary = { applied: 0, skipped: 0, failed: 0, optionalFallbacks: 0 };
  const fallbackCounts = Object.create(null);
  let hostAudit = null;
  let healthChecks = [];
  let writeChain = Promise.resolve();

  function redact(value) {
    let text = String(value == null ? "" : value);
    if (os) {
      const home = os.homedir();
      if (home) text = text.split(home).join("~");
    }
    text = text.replace(/([A-Za-z]:\\|\/Users\/|\/home\/)[^\s"']+/g, "[local-path]");
    return text.slice(0, 4000);
  }

  function logFilePath() {
    if (!fs || !path || !os) return null;
    const day = new Date().toISOString().slice(0, 10);
    return path.join(os.homedir(), "Documents", "CompX", "Logs", "compx-" + day + ".log");
  }

  function persist(entry) {
    const file = logFilePath();
    if (!file || !fs.promises) return;
    const line = JSON.stringify(entry) + "\n";
    writeChain = writeChain.then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.appendFile(file, line, "utf8");
    }).catch(() => {});
  }

  function record(level, code, message, detail, outcome) {
    const entry = {
      time: new Date().toISOString(),
      level: level || "info",
      code: String(code || "GENERAL").slice(0, 80),
      message: redact(message),
      detail: redact(detail),
    };
    entries.push(entry);
    if (entries.length > 500) entries.shift();
    if (outcome && Object.prototype.hasOwnProperty.call(summary, outcome)) summary[outcome]++;
    persist(entry);
    return entry;
  }

  function getSummary() {
    return { applied: summary.applied, skipped: summary.skipped, failed: summary.failed, optionalFallbacks: summary.optionalFallbacks };
  }

  function fallback(code, error) {
    const key = String(code || "OPTIONAL_FALLBACK").slice(0, 100);
    summary.optionalFallbacks++;
    fallbackCounts[key] = (fallbackCounts[key] || 0) + 1;
    // Record only the first occurrence of each expected compatibility fallback
    // to avoid turning high-frequency Adobe API probes into noisy disk logs.
    if (fallbackCounts[key] === 1) {
      entries.push({
        time: new Date().toISOString(),
        level: "debug",
        code: key,
        message: "Expected optional compatibility fallback",
        detail: redact(error && error.message ? error.message : error),
      });
      if (entries.length > 500) entries.shift();
    }
  }

  function setHostAudit(data) {
    hostAudit = data && typeof data === "object" ? data : null;
  }

  function setHealthChecks(checks) {
    healthChecks = Array.isArray(checks) ? checks.map(function (check) {
      return {
        name: redact(check && check.name),
        status: /^(pass|warn|fail)$/.test(check && check.status) ? check.status : "warn",
        detail: redact(check && check.detail),
      };
    }) : [];
    return healthChecks.slice();
  }

  function getHealthChecks() {
    return healthChecks.slice();
  }

  function reportText() {
    const lines = [
      "CompX Diagnostic Report",
      "Generated: " + new Date().toISOString(),
      "Applied: " + summary.applied + " | Skipped: " + summary.skipped + " | Failed: " + summary.failed + " | Optional fallbacks: " + summary.optionalFallbacks,
      "Entries: " + entries.length,
      "",
    ];
    if (healthChecks.length) {
      lines.push("System check:");
      healthChecks.forEach(function (check) {
        lines.push("- [" + check.status.toUpperCase() + "] " + check.name + (check.detail ? ": " + check.detail : ""));
      });
      lines.push("");
    }
    const fallbackKeys = Object.keys(fallbackCounts).sort();
    if (fallbackKeys.length) {
      lines.push("Panel optional fallbacks:");
      fallbackKeys.forEach((key) => lines.push("- " + key + ": " + fallbackCounts[key]));
      lines.push("");
    }
    if (hostAudit) {
      lines.push("Adobe host optional fallbacks: " + Number(hostAudit.total || 0));
      (hostAudit.codes || []).forEach((item) => lines.push("- " + item.code + ": " + item.count));
      lines.push("");
    }
    entries.forEach((entry) => {
      lines.push("[" + entry.time + "] " + entry.level.toUpperCase() + " " + entry.code + " — " + entry.message + (entry.detail ? " | " + entry.detail : ""));
    });
    return lines.join("\n");
  }

  async function copyReport() {
    const text = reportText();
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      await root.navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }

  root.CompXDiagnostics = { record, fallback, setHostAudit, setHealthChecks, getHealthChecks, getSummary, reportText, copyReport };
})(window);
