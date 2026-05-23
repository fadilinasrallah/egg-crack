"use strict";

const fs   = require("fs");
const path = require("path");

let ptyLib = null;
try { ptyLib = require("node-pty"); } catch { }

const MAX_RESTARTS  = 10;
const RESTART_DELAY = 3000;
const BUF_LIMIT     = 100_000; // bytes of scrollback kept in memory per process

// ── Event line format ─────────────────────────────────────────────────────────
// Written into the PTY stream and log file. xterm.js renders the ANSI colours.
// Plain-text log readers see: ◆ EVENT — detail [timestamp]
const EVT_COLORS = {
  STARTED:      32, // green
  STOPPED:      33, // yellow
  CRASHED:      31, // red
  RESTARTING:   36, // cyan
  MAX_RESTARTS: 31, // red
};

function _eventLine(type, detail = "") {
  const ts  = new Date().toISOString().replace("T", " ").slice(0, 19);
  const col = EVT_COLORS[type] || 37;
  return (
    `\r\n\x1b[${col};1m◆ ${type}\x1b[0m` +
    `\x1b[${col}m${detail ? ` — ${detail}` : ""} [${ts}]\x1b[0m\r\n`
  );
}

// ── Tokenise a shell-like command ─────────────────────────────────────────────
function _splitCmd(cmd) {
  const tokens = [];
  const re = /(?:[^\s"'\\]+|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    let t = m[0];
    if (t.length >= 2 &&
       ((t[0] === '"' && t[t.length - 1] === '"') ||
        (t[0] === "'" && t[t.length - 1] === "'"))) {
      t = t.slice(1, -1);
    }
    tokens.push(t);
  }
  return tokens;
}

// ── PtyProcess ────────────────────────────────────────────────────────────────

class PtyProcess {
  constructor({ name, command, cwd, env, root, logFile }) {
    this.name    = name;
    this.command = command;
    this.cwd     = cwd;
    this.env     = env;
    this.root    = root;
    this.logFile = logFile;

    this.status   = "stopped";
    this.restarts = 0;
    this._uptime  = null;
    this._pid     = null;
    this._pty     = null;
    this._buf     = "";
    this._clients = new Set();

    this._stopping   = false;
    this._restarting = false;
    this._destroyed  = false;
    this._restartTimer = null;
  }

  spawn() {
    if (this._destroyed) return;
    this._stopping   = false;
    this._restarting = false;

    // On first spawn, pre-load the log file into the scrollback buffer so
    // reconnecting attach clients (e.g. after npm install) see install output.
    if (!this._buf) {
      try {
        const raw = fs.readFileSync(this.logFile, "utf8");
        if (raw) this._buf = raw.slice(-BUF_LIMIT);
      } catch { }
    }

    const parts = _splitCmd(this.command);
    let ptyProc;
    try {
      ptyProc = ptyLib.spawn(parts[0], parts.slice(1), {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        cwd:  this.cwd,
        env:  this.env,
      });
    } catch (err) {
      this.status = "errored";
      this._broadcast(_eventLine("CRASHED", `spawn failed: ${err.message}`));
      return;
    }

    this._pty    = ptyProc;
    this._pid    = ptyProc.pid;
    this.status  = "online";
    this._uptime = Date.now();

    this._broadcast(_eventLine("STARTED", `pid=${this._pid}`));

    ptyProc.onData(data => this._broadcast(data));

    ptyProc.onExit(({ exitCode }) => {
      this._pid = null;
      try { if (this._pty) this._pty.kill(); } catch { }
      this._pty = null;

      // ── Intentional stop ──
      if (this._stopping || this._destroyed) {
        this.status  = "stopped";
        this._uptime = null;
        this._broadcast(_eventLine("STOPPED", `exit=${exitCode}`));
        return;
      }

      // ── Manual restart triggered via restart() ──
      if (this._restarting) {
        this._broadcast(_eventLine("RESTARTING", "manual restart"));
        this.spawn();
        return;
      }

      // ── Crash ──
      this.restarts++;
      if (this.restarts > MAX_RESTARTS) {
        this.status  = "errored";
        this._uptime = null;
        this._broadcast(_eventLine("MAX_RESTARTS",
          `stopped after ${MAX_RESTARTS} failed attempts (exit=${exitCode})`));
        return;
      }

      this.status = "errored";
      this._broadcast(_eventLine("CRASHED",
        `exit=${exitCode}, restarting in ${RESTART_DELAY / 1000}s` +
        ` (attempt ${this.restarts}/${MAX_RESTARTS})`));

      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        this.spawn();
      }, RESTART_DELAY);
    });
  }

  // ── Broadcast data to log file + all attached WS clients ─────────────────
  _broadcast(data) {
    // Append to in-memory scrollback
    this._buf += data;
    if (this._buf.length > BUF_LIMIT) this._buf = this._buf.slice(-BUF_LIMIT);

    // Persist to log file (sync write keeps ordering with PTY output)
    try { fs.appendFileSync(this.logFile, data); } catch { }

    // Forward to connected WebSocket clients
    const dead = [];
    for (const ws of this._clients) {
      try {
        if (ws.readyState === 1) ws.send(Buffer.from(data), { binary: true });
        else dead.push(ws);
      } catch { dead.push(ws); }
    }
    for (const ws of dead) this._clients.delete(ws);
  }

  stop() {
    this._stopping = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._pty) {
      try { this._pty.kill("SIGTERM"); } catch { }
    } else {
      this.status  = "stopped";
      this._uptime = null;
    }
  }

  restart() {
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (this._pty) {
      this._restarting = true;
      try { this._pty.kill("SIGTERM"); } catch { }
    } else {
      this.spawn();
    }
  }

  destroy() {
    this._destroyed = true;
    this.stop();
  }

  // ── Attach a WebSocket client to this process ─────────────────────────────
  addClient(ws) {
    this._clients.add(ws);

    // Replay scrollback so the client sees existing output immediately
    if (this._buf && ws.readyState === 1) {
      try { ws.send(Buffer.from(this._buf), { binary: true }); } catch { }
    }

    ws.on("message", raw => {
      if (!this._pty) return;
      try {
        const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const msg = JSON.parse(str);
        if (msg.t === "i" && typeof msg.d === "string") {
          this._pty.write(msg.d);
        } else if (msg.t === "resize") {
          const cols = Math.max(1, Math.min(Number(msg.cols) || 80, 500));
          const rows = Math.max(1, Math.min(Number(msg.rows) || 24, 200));
          this._pty.resize(cols, rows);
        }
      } catch { }
    });

    ws.on("close",  () => this._clients.delete(ws));
    ws.on("error",  () => this._clients.delete(ws));
  }

  tailLog(lines) {
    try {
      // Strip ANSI escape codes so the plain-text log view is readable.
      // Raw terminal output (cursor moves, colour codes) is preserved in the
      // log file itself for the live Attach terminal.
      const raw = fs.readFileSync(this.logFile, "utf8");
      const text = raw
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // CSI sequences
        .replace(/\x1b[()][0-9A-Za-z]/g, "")     // charset designators
        .replace(/\r/g, "");
      return text.split("\n").filter(Boolean).slice(-lines).join("\n");
    } catch { return ""; }
  }

  shape() {
    // Read memory directly from /proc — no shell wrapper, so the spawned PID
    // is the app process itself.
    let memory = 0;
    if (this._pid && process.platform === "linux") {
      try {
        const statm = fs.readFileSync(`/proc/${this._pid}/statm`, "utf8").split(" ");
        memory = Number(statm[1]) * 4096;
      } catch { }
    }
    return {
      name:        this.name,
      pid:         this._pid,
      status:      this.status,
      restarts:    this.restarts,
      uptime:      this._uptime,
      cwd:         path.relative(this.root, this.cwd) || ".",
      port:        "",
      cpu:         0,
      memory,
      outLog:      this.logFile,
      errLog:      "",
      dirSize:     0,
      interactive: true,
    };
  }
}

// ── PtyManager ────────────────────────────────────────────────────────────────

class PtyManager {
  constructor({ root, logsDir }) {
    this.root    = root;
    this.logsDir = logsDir;
    this._procs  = new Map();
    fs.mkdirSync(logsDir, { recursive: true });
  }

  static available() { return Boolean(ptyLib); }

  _resolve(p = ".") {
    const full = path.resolve(this.root, p);
    const rel  = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the workspace.");
    return full;
  }

  list() {
    return [...this._procs.values()]
      .map(p => p.shape())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name) { return this._procs.has(name); }

  start(def) {
    if (!ptyLib) throw new Error("node-pty is unavailable — run npm install.");

    const name    = String(def.name || "").trim();
    if (!name) throw new Error("Process name is required.");

    const cwd     = this._resolve(def.cwd || ".");
    fs.mkdirSync(cwd, { recursive: true });
    const command = String(def.command || "").trim();
    if (!command) throw new Error(`No start command for "${name}".`);

    const appEnv = { ...process.env, BASE_DIR: cwd };
    if (def.port) appEnv.PORT = String(def.port);
    if (def.env && typeof def.env === "object") {
      for (const [k, v] of Object.entries(def.env)) { if (k) appEnv[k] = String(v); }
    }

    const existing = this._procs.get(name);
    // Grab WS clients from the old process BEFORE destroying it so we can
    // transfer them to the new process. They stay connected and automatically
    // see the new session without requiring the user to re-attach.
    const orphanedClients = existing ? new Set(existing._clients) : new Set();
    if (existing) existing.destroy();

    const proc = new PtyProcess({
      name, command, cwd, env: appEnv,
      root:    this.root,
      logFile: path.join(this.logsDir, `${name}-out.log`),
    });
    this._procs.set(name, proc);
    proc.spawn(); // populates _buf from log file, broadcasts STARTED

    // Transfer orphaned clients to the new process. addClient() replays the
    // new _buf (current session only) and registers fresh input handlers.
    // Old handlers bound to the destroyed process are harmless no-ops.
    for (const ws of orphanedClients) {
      if (ws.readyState === 1) proc.addClient(ws);
    }

    return proc.shape();
  }

  stop(name) {
    const proc = this._procs.get(name);
    if (!proc) throw new Error(`Process "${name}" not found.`);
    proc.stop();
    return proc.shape();
  }

  restart(name) {
    const proc = this._procs.get(name);
    if (!proc) throw new Error(`Process "${name}" not found.`);
    proc.restart();
    return proc.shape();
  }

  remove(name) {
    const proc = this._procs.get(name);
    if (proc) { proc.destroy(); this._procs.delete(name); }
  }

  logs(name, lines = 150) {
    const proc = this._procs.get(name);
    if (!proc) throw new Error(`Process "${name}" not found.`);
    return { stdout: proc.tailLog(lines), stderr: "", interactive: true };
  }

  attach(name, ws) {
    const proc = this._procs.get(name);
    if (!proc) throw new Error(`Process "${name}" not found.`);
    proc.addClient(ws);
  }
}

module.exports = { PtyManager };
