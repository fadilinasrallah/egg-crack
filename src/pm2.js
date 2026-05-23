"use strict";

const fs     = require("fs");
const path   = require("path");
const cp     = require("child_process");
const pm2lib = require("pm2");

class Pm2Manager {
  constructor({ root, appsDir, pm2Home, logsDir, useUserland = false, userlandDir = "" }) {
    this.root        = root;
    this.appsDir     = appsDir;
    this.pm2Home     = pm2Home;
    this.logsDir     = logsDir;
    this.useUserland = useUserland;
    this.userlandDir = userlandDir;
    process.env.PM2_HOME = pm2Home;   // PM2 reads this at connect time
    fs.mkdirSync(pm2Home, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
  }

  _connect() {
    if (this._conn) return this._conn;
    this._conn = new Promise((res, rej) => {
      const t = setTimeout(() => { this._conn = null; rej(new Error("PM2 connect timeout")); }, 8000);
      pm2lib.connect(true, err => {
        clearTimeout(t);
        if (err) { this._conn = null; rej(err); return; }
        // PM2 has stored PM2_HOME internally — remove it from process.env so
        // managed child processes cannot reach the PM2 daemon socket.
        delete process.env.PM2_HOME;
        res();
      });
    });
    return this._conn;
  }

  async _use(fn) {
    await this._connect();
    return fn();
  }

  _call(method, ...args) {
    return new Promise((res, rej) =>
      pm2lib[method](...args, (err, result) => err ? rej(err) : res(result))
    );
  }

  _rel(p)  { return path.relative(this.root, p) || "."; }

  _resolve(p = ".") {
    const full = path.resolve(this.root, p);
    const rel  = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path is outside the workspace.");
    return full;
  }

  _shape(raw) {
    const env = raw.pm2_env || {};
    const pid = raw.pid || null;

    let portStr = "";
    let memory  = raw.monit ? raw.monit.memory : 0;

    if (pid && process.platform === "linux") {
      const tree = _procTree(pid);
      portStr = _portsForTree(tree).join(", ");
      const treeMem = _memForTree(tree);
      if (treeMem > 0) memory = treeMem;
    }

    return {
      name:     raw.name,
      pid,
      status:   env.status || "unknown",
      restarts: env.restart_time || 0,
      uptime:   env.pm_uptime || null,
      cwd:      env.pm_cwd ? this._rel(env.pm_cwd) : "",
      port:     portStr,
      cpu:      raw.monit ? raw.monit.cpu : 0,
      memory,
      outLog:   env.pm_out_log_path || "",
      errLog:   env.pm_err_log_path || "",
      dirSize:  env.pm_cwd ? _dirSize(env.pm_cwd) : 0
    };
  }

  // Returns a launch spec: { script, args, cwd, env }.
  // On Linux (no userland): parses the command and launches the binary directly —
  // no shell wrapper, so PM2 manages the actual process and gets native CPU/memory.
  // process.env has already been stripped of secrets by server.js at startup,
  // so inheritance is safe. Per-app vars arrive via the returned env object,
  // which is passed to PM2's env field (isolated per process, not shared).
  _launchSpec(command, cwd, appEnv) {
    // ── Userland / proot ──────────────────────────────────────────────────────
    if (this.useUserland) {
      const enter = path.join(this.userlandDir, "enter.sh");
      if (!fs.existsSync(enter)) throw new Error("Userland enter.sh not found.");
      const rel  = this._rel(cwd);
      const wd   = rel === "." ? "/host" : `/host/${rel.replace(/\\/g, "/")}`;
      const safe = wd.replace(/'/g, "'\\''");
      // Userland still needs a shell wrapper to enter the proot environment.
      return { script: enter, args: ["-c", `cd '${safe}' && exec ${command}`], cwd: this.root, env: appEnv };
    }

    // ── Windows (dev environment only) ───────────────────────────────────────
    if (process.platform === "win32") {
      return { script: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command], cwd, env: appEnv };
    }

    // ── Linux: direct launch ─────────────────────────────────────────────────
    // Avoid a shell wrapper whenever possible so PM2 tracks the real process PID.
    if (_needsShell(command)) {
      const sh = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
      return { script: sh, args: ["-c", command], cwd, env: appEnv };
    }
    const parts = _splitCmd(command);
    return { script: parts[0], args: parts.slice(1), cwd, env: appEnv };
  }

  _infer(dir) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (p.scripts?.start) {
          const s = p.scripts.start.trim();
          // If scripts.start is a plain node command, use it directly so PM2
          // manages node (not npm), giving native memory/CPU tracking.
          if (/^node\s/.test(s) && !_needsShell(s)) return s;
          return "npm start";
        }
        if (typeof p.main === "string" && p.main.trim()) return `node ${p.main.trim()}`;
      } catch { }
    }
    if (fs.existsSync(path.join(dir, "index.js")))        return "node index.js";
    if (fs.existsSync(path.join(dir, "src", "index.js"))) return "node src/index.js";
    return "";
  }

  // logFile is the process outLog — npm install output streams there so the
  // user sees it live in the attach tab while the HTTP start request is pending.
  async _autoInstall(dir, logFile) {
    const hasPkg = fs.existsSync(path.join(dir, "package.json"));
    if (!hasPkg) return;
    // Always run npm install — fast when deps are current, rebuilds missing
    // native modules (e.g. sqlite3) that were interrupted or never compiled.

    const ts    = () => new Date().toISOString().slice(11, 19);
    const write = chunk => {
      if (logFile) try { fs.appendFileSync(logFile, chunk); } catch { }
    };

    write(`\r\n\x1b[36;1m◆ INSTALLING DEPENDENCIES [${ts()}]\x1b[0m\r\n`);
    console.log(`[wispnodes] auto-installing deps in ${this._rel(dir)}`);

    await new Promise((resolve, reject) => {
      const child = cp.spawn(
        "npm",
        ["install", "--omit=dev", "--no-fund", "--no-audit", "--loglevel=warn"],
        {
          cwd:   dir,
          stdio: logFile ? ["ignore", "pipe", "pipe"] : "inherit",
          shell: process.platform === "win32",
        }
      );
      if (logFile) {
        child.stdout.on("data", d => write(d));
        child.stderr.on("data", d => write(d));
      }
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) {
          write(`\r\n\x1b[32;1m✓ install complete [${ts()}]\x1b[0m\r\n\r\n`);
          resolve();
        } else {
          const msg = `npm install exited with code ${code} in ${this._rel(dir)}`;
          write(`\r\n\x1b[31;1m✗ ${msg}\x1b[0m\r\n`);
          reject(new Error(msg));
        }
      });
    });
  }

  discover() {
    if (!fs.existsSync(this.appsDir)) return [];
    return fs.readdirSync(this.appsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const dir = path.join(this.appsDir, e.name);
        return { name: e.name, cwd: this._rel(dir), command: this._infer(dir) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async list() {
    return this._use(async () => {
      const list = await this._call("list");
      return list.map(p => this._shape(p)).sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async start(def) {
    const name = String(def.name || "").trim();
    if (!name) throw new Error("Process name is required.");
    const cwd = this._resolve(def.cwd || ".");

    // Compute log paths before _autoInstall so install output goes to the same file
    // the logstream WS is already tailing.
    const outLog = path.join(this.logsDir, `${name}-out.log`);
    const errLog = path.join(this.logsDir, `${name}-err.log`);

    await this._autoInstall(cwd, outLog);

    const command = String(def.command || this._infer(cwd)).trim();
    if (!command) throw new Error(`No start command for "${name}". Add a package.json start script or specify a command.`);

    // Build per-app environment: clean system base + app-specific vars.
    // process.env has already been hardened at startup — this just adds app vars on top.
    const appEnv = _appEnv({ BASE_DIR: cwd });
    if (def.port) appEnv.PORT = String(def.port);
    if (def.env && typeof def.env === "object") {
      for (const [k, v] of Object.entries(def.env)) { if (k) appEnv[k] = String(v); }
    }

    const spec = this._launchSpec(command, cwd, appEnv);

    return this._use(async () => {
      const existing = await this._call("describe", name);
      if (existing.length) await this._call("delete", name);
      await this._call("start", {
        name,
        script:        spec.script,
        args:          spec.args,
        cwd:           spec.cwd,
        env:           spec.env,     // per-app env passed via PM2 field, not shell args
        interpreter:   "none",
        out_file:      outLog,
        error_file:    errLog,
        merge_logs:    false,
        autorestart:   true,
        restart_delay: 3000,
        max_restarts:  10,
        treekill:      true,         // kill entire process tree on stop/restart
      });

      // Write a LAUNCHED line immediately so the logstream shows feedback even
      // when the process itself doesn't produce stdout right away.
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      try { fs.appendFileSync(outLog, `\r\n\x1b[32;1m◆ LAUNCHED [${ts}]\x1b[0m\r\n`); } catch { }

      const desc = await this._call("describe", name);
      return desc.map(p => this._shape(p))[0] || null;
    });
  }

  async stop(name) {
    return this._use(async () => {
      await this._call("stop", name);
      const desc = await this._call("describe", name);
      return desc.map(p => this._shape(p))[0] || null;
    });
  }

  async restart(name) {
    return this._use(async () => {
      await this._call("restart", name);
      const desc = await this._call("describe", name);
      return desc.map(p => this._shape(p))[0] || null;
    });
  }

  async remove(name) {
    return this._use(() => this._call("delete", name));
  }

  async logs(name, lines = 150) {
    return this._use(async () => {
      const desc = await this._call("describe", name);
      const info = desc.map(p => this._shape(p))[0];
      if (!info) throw new Error(`Process "${name}" not found.`);
      return {
        stdout: this._tail(info.outLog, lines),
        stderr: this._tail(info.errLog, lines)
      };
    });
  }

  _tail(file, n) {
    if (!file || !fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
  }
}

// ── Command parsing ────────────────────────────────────────────────────────────

// Tokenise a shell-like command string respecting quoted strings.
function _splitCmd(cmd) {
  const tokens = [];
  const re = /(?:[^\s"'\\]+|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    // Strip outer quotes from each token.
    let t = m[0];
    if (t.length >= 2) {
      if ((t[0] === '"' && t[t.length - 1] === '"') ||
          (t[0] === "'" && t[t.length - 1] === "'")) {
        t = t.slice(1, -1);
      }
    }
    tokens.push(t);
  }
  return tokens;
}

// Returns true if the command requires a shell interpreter to run correctly.
function _needsShell(cmd) {
  // Operators, redirections, glob patterns, variable substitution.
  if (/[|&;<>$`*?[\]{}()!\\]/.test(cmd)) return true;
  // VAR=value prefix pattern (e.g. "NODE_ENV=production node server.js").
  const first = _splitCmd(cmd)[0] || "";
  return first.includes("=");
}

// ── Environment ────────────────────────────────────────────────────────────────

// Whitelist of process.env keys that are safe to pass to managed apps.
// After server.js calls hardenEnv() at startup, process.env only contains
// these (plus anything explicitly set by managers like PM2_HOME, which is
// deleted from process.env after PM2 connects). This whitelist is a second
// line of defence in case a var slips through.
const _APP_ENV_PASSTHROUGH = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ",
  "TERM", "NODE_ENV", "NODE_PATH", "NODE_VERSION",
  "npm_config_cache", "npm_config_prefix",
  "TMPDIR", "TEMP", "TMP"
]);

function _appEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (_APP_ENV_PASSTHROUGH.has(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

// ── /proc helpers ──────────────────────────────────────────────────────────────

// Walk /proc to collect all descendant PIDs of rootPid (handles npm → node, etc.).
function _procTree(rootPid) {
  const tree = new Set([rootPid]);
  try {
    const all = fs.readdirSync("/proc").filter(d => /^\d+$/.test(d)).map(Number);
    let changed = true;
    while (changed) {
      changed = false;
      for (const pid of all) {
        if (tree.has(pid)) continue;
        try {
          const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
          const m = status.match(/^PPid:\s*(\d+)/m);
          if (m && tree.has(Number(m[1]))) { tree.add(pid); changed = true; }
        } catch { }
      }
    }
  } catch { }
  return tree;
}

// Sum RSS across the entire process tree — gives real memory even when PM2
// manages a launcher (e.g. npm) whose children do the actual work.
function _memForTree(tree) {
  let total = 0;
  for (const pid of tree) {
    try {
      const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ");
      total += Number(statm[1]) * 4096; // RSS pages → bytes
    } catch { }
  }
  return total;
}

// Collect all listening TCP ports for a process tree via /proc.
function _portsForTree(tree) {
  const inodes = new Set();
  for (const p of tree) {
    try {
      for (const fd of fs.readdirSync(`/proc/${p}/fd`)) {
        try {
          const link = fs.readlinkSync(`/proc/${p}/fd/${fd}`);
          const m = link.match(/^socket:\[(\d+)\]$/);
          if (m) inodes.add(m[1]);
        } catch { }
      }
    } catch { }
  }
  if (!inodes.size) return [];
  const ports = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const line of fs.readFileSync(f, "utf8").split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 10 || cols[3] !== "0A") continue; // 0A = TCP_LISTEN
        if (!inodes.has(cols[9])) continue;
        const port = parseInt(cols[1].split(":").pop(), 16);
        if (port > 0 && !ports.includes(port)) ports.push(port);
      }
    } catch { }
  }
  return ports;
}

// ── Directory size ─────────────────────────────────────────────────────────────

const _dsc = new Map();
function _dirSize(dir) {
  const now = Date.now();
  const hit = _dsc.get(dir);
  if (hit && now - hit.ts < 60_000) return hit.v;
  let total = 0, count = 0;
  try {
    const walk = d => {
      if (count > 50_000) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else { try { total += fs.statSync(full).size; } catch { } count++; }
      }
    };
    walk(dir);
  } catch { }
  _dsc.set(dir, { v: total, ts: now });
  return total;
}

module.exports = { Pm2Manager };
