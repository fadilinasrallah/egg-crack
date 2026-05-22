"use strict";

const fs           = require("fs");
const http         = require("http");
const https        = require("https");
const path         = require("path");
const { spawn, execSync } = require("child_process");

class CloudflareManager {
  constructor({ binDir, logsDir, token, autoRestart = true, onLog = null }) {
    this._token       = token;
    this._binPath     = path.join(binDir, "cloudflared");
    this._logPath     = path.join(logsDir, "cloudflared.log");
    this._autoRestart = autoRestart;
    this._onLog       = onLog;
    this._proc        = null;
    this._downloading = false;
    fs.mkdirSync(binDir,  { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
  }

  status() {
    const managed  = this._isRunning();
    const external = !managed && _detectSystem();
    return {
      configured:   Boolean(this._token),
      running:      managed || external,
      managed,
      external,
      downloading:  this._downloading,
      binaryReady:  fs.existsSync(this._binPath)
    };
  }

  recentLogs(lines = 60) {
    if (!fs.existsSync(this._logPath)) return "";
    return fs.readFileSync(this._logPath, "utf8")
      .split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  }

  async start() {
    if (!this._token) throw new Error("CF_TUNNEL_TOKEN is not set.");
    // Strip accidental surrounding whitespace/quotes that Pterodactyl panels sometimes add.
    const token = this._token.replace(/^[\s"']+|[\s"']+$/g, "");
    if (!token) throw new Error("CF_TUNNEL_TOKEN is blank after stripping whitespace/quotes.");
    if (this._isRunning()) return this.status();
    if (!fs.existsSync(this._binPath)) await this._download();

    // Pre-flight: make sure the binary can actually execute in this container.
    const ver = await this._runCmd(["version"], 5000);
    if (ver.out) this._log(`cloudflared binary ok — ${ver.out.split("\n")[0]}`);
    else         this._log(`WARN: cloudflared version produced no output (exit ${ver.code}) — binary may be incompatible with this container's glibc/architecture`);

    this._log("Starting cloudflared tunnel.");
    const startedAt = Date.now();
    const child = spawn(
      this._binPath,
      ["tunnel", "--token", token],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this._proc = child;
    child.stdout.on("data", d => this._log(d));
    child.stderr.on("data", d => this._log(d));
    child.on("close", code => {
      const ms = Date.now() - startedAt;
      if (ms < 3000) {
        this._log(`cloudflared exited after only ${ms}ms (code ${code}) with no output. Likely causes:`);
        this._log("  1. CF_TUNNEL_TOKEN is invalid, expired, or has extra characters — re-copy it from the Cloudflare dashboard");
        this._log("  2. Binary is incompatible with this container (wrong glibc / seccomp policy)");
        this._log("  3. Outbound internet access is blocked from this container");
      } else {
        this._log(`cloudflared exited (code ${code}).`);
      }
      this._proc = null;
      if (this._autoRestart && token) {
        setTimeout(() => this.start().catch(e => this._log(e.message)), 10000).unref();
      }
    });
    return this.status();
  }

  // Run a cloudflared sub-command and return its combined output + exit code.
  _runCmd(args, timeoutMs = 5000) {
    return new Promise(resolve => {
      let out = "";
      const child = spawn(this._binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", d => out += d);
      child.stderr.on("data", d => out += d);
      child.on("close", code => resolve({ code, out: out.trim() }));
      setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -1, out: out.trim() }); }, timeoutMs);
    });
  }

  stop() {
    if (this._proc) {
      this._log("Stopping cloudflared.");
      this._proc.kill("SIGTERM");
      this._proc = null;
    }
    return this.status();
  }

  _isRunning() {
    return Boolean(this._proc && !this._proc.killed);
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${String(msg).trim()}\n`;
    try { fs.appendFileSync(this._logPath, line); } catch { }
    if (this._onLog) try { this._onLog(String(msg).trim()); } catch { }
  }

  async _download() {
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const url  = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
    this._downloading = true;
    this._log(`Downloading cloudflared (${arch})…`);
    try {
      await this._fetch(url, this._binPath);
      fs.chmodSync(this._binPath, 0o755);
      this._log("cloudflared binary ready.");
    } finally {
      this._downloading = false;
    }
  }

  _fetch(url, dest) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest, { mode: 0o755 });

      // Overall 120 s hard timeout.
      let timer = setTimeout(() => {
        out.destroy();
        fs.unlink(dest, () => {});
        reject(new Error("Download timed out after 120 s — check network connectivity"));
      }, 120_000);

      const get = u => (u.startsWith("https:") ? https : http).get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, u).toString());
        }
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          out.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const total    = parseInt(res.headers["content-length"] || "0", 10);
        let received   = 0;
        let lastLogPct = -1;

        res.on("data", chunk => {
          received += chunk.length;
          // Reset stall timer on each chunk.
          clearTimeout(timer);
          timer = setTimeout(() => {
            out.destroy();
            fs.unlink(dest, () => {});
            reject(new Error("Download stalled — no data received for 30 s"));
          }, 30_000);

          if (total > 0) {
            const pct = Math.floor((received / total) * 100);
            if (pct >= lastLogPct + 20) {
              lastLogPct = pct;
              this._log(`Download: ${pct}% (${(received / 1_048_576).toFixed(1)} / ${(total / 1_048_576).toFixed(1)} MB)`);
            }
          }
        });

        res.pipe(out);
        out.on("finish", () => { clearTimeout(timer); out.close(resolve); });
        out.on("error",  err => { clearTimeout(timer); fs.unlink(dest, () => {}); reject(err); });
      }).on("error", err => { clearTimeout(timer); reject(err); });

      get(url);
    });
  }
}

// Detect a cloudflared process started outside of WispNodes.
function _detectSystem() {
  try {
    if (process.platform === "win32") {
      const out = execSync('tasklist /FI "IMAGENAME eq cloudflared.exe" /NH', {
        encoding: "utf8", timeout: 2000, stdio: "pipe"
      });
      return out.toLowerCase().includes("cloudflared.exe");
    } else {
      execSync("pgrep -f cloudflared", { encoding: "utf8", timeout: 2000, stdio: "pipe" });
      return true;
    }
  } catch {
    return false;
  }
}

module.exports = { CloudflareManager };
