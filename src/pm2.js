"use strict";

const fs   = require("fs");
const path = require("path");
const cp   = require("child_process");
const pm2lib = require("pm2");

class Pm2Manager {
  constructor({ root, appsDir, pm2Home, logsDir, useUserland = false, userlandDir = "" }) {
    this.root       = root;
    this.appsDir    = appsDir;
    this.pm2Home    = pm2Home;
    this.logsDir    = logsDir;
    this.useUserland  = useUserland;
    this.userlandDir  = userlandDir;
    process.env.PM2_HOME = pm2Home;
    fs.mkdirSync(pm2Home,  { recursive: true });
    fs.mkdirSync(logsDir,  { recursive: true });
  }

  _connect() {
    if (this._conn) return this._conn;
    this._conn = new Promise((res, rej) => {
      const t = setTimeout(() => { this._conn = null; rej(new Error("PM2 connect timeout")); }, 8000);
      pm2lib.connect(true, err => {
        clearTimeout(t);
        if (err) { this._conn = null; rej(err); } else { res(); }
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
    const env  = raw.pm2_env || {};
    const vars = (env.env && typeof env.env === "object") ? env.env : {};
    return {
      name:     raw.name,
      pid:      raw.pid || null,
      status:   env.status || "unknown",
      restarts: env.restart_time || 0,
      uptime:   env.pm_uptime || null,
      cwd:      env.pm_cwd ? this._rel(env.pm_cwd) : "",
      port:     vars.PORT ? String(vars.PORT) : "",
      cpu:      raw.monit ? raw.monit.cpu    : 0,
      memory:   raw.monit ? raw.monit.memory : 0,
      outLog:   env.pm_out_log_path || "",
      errLog:   env.pm_err_log_path || ""
    };
  }

  _shell(command, cwd) {
    if (this.useUserland) {
      const enter = path.join(this.userlandDir, "enter.sh");
      if (!fs.existsSync(enter)) throw new Error("Userland enter.sh not found.");
      const rel  = this._rel(cwd);
      const wd   = rel === "." ? "/host" : `/host/${rel.replace(/\\/g, "/")}`;
      const safe = wd.replace(/'/g, "'\\''");
      return { cwd: this.root, script: enter, args: ["-c", `cd '${safe}' && exec ${command}`] };
    }
    if (process.platform === "win32") {
      return { cwd, script: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
    }
    const sh = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    return { cwd, script: sh, args: [sh.endsWith("bash") ? "-lc" : "-c", command] };
  }

  _infer(dir) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (p.scripts && p.scripts.start) return "npm start";
        if (typeof p.main === "string" && p.main.trim()) return `node ${p.main.trim()}`;
      } catch { }
    }
    if (fs.existsSync(path.join(dir, "index.js")))         return "node index.js";
    if (fs.existsSync(path.join(dir, "src", "index.js")))  return "node src/index.js";
    return "";
  }

  // Runs npm install if package.json exists but node_modules does not.
  async _autoInstall(dir) {
    const hasPkg = fs.existsSync(path.join(dir, "package.json"));
    const hasNm  = fs.existsSync(path.join(dir, "node_modules"));
    if (!hasPkg || hasNm) return;

    const label = this._rel(dir);
    console.log(`[wispnodes] auto-installing deps in ${label}`);
    await new Promise((resolve, reject) => {
      const child = cp.spawn("npm", ["install", "--omit=dev", "--no-fund", "--no-audit", "--loglevel=error"], {
        cwd:   dir,
        stdio: "inherit",
        shell: process.platform === "win32"
      });
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`npm install exited with code ${code} in ${label}`));
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

    await this._autoInstall(cwd);

    const command = String(def.command || this._infer(cwd)).trim();
    if (!command) throw new Error(`No start command for "${name}". Add a package.json start script or specify a command.`);

    const sh     = this._shell(command, cwd);
    const outLog = path.join(this.logsDir, `${name}-out.log`);
    const errLog = path.join(this.logsDir, `${name}-err.log`);
    const env    = { ...process.env, PM2_HOME: this.pm2Home, BASE_DIR: cwd };

    if (def.port) env.PORT = String(def.port);
    if (def.env && typeof def.env === "object") {
      for (const [k, v] of Object.entries(def.env)) { if (k) env[k] = String(v); }
    }

    return this._use(async () => {
      const existing = await this._call("describe", name);
      if (existing.length) await this._call("delete", name);
      await this._call("start", {
        name,
        script:      sh.script,
        args:        sh.args,
        cwd:         sh.cwd,
        interpreter: "none",
        out_file:    outLog,
        error_file:  errLog,
        merge_logs:  false,
        autorestart: true,
        restart_delay: 3000,
        max_restarts:  10,
        env
      });
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

module.exports = { Pm2Manager };
