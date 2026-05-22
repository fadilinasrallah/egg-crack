"use strict";

const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");

const appsDir = path.resolve(__dirname, "..", "apps");

if (!fs.existsSync(appsDir)) {
  console.log("No apps directory found.");
  process.exit(0);
}

const apps = fs.readdirSync(appsDir, { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(path.join(appsDir, e.name, "package.json")))
  .map(e => e.name);

if (!apps.length) {
  console.log("No app folders with package.json found.");
  process.exit(0);
}

console.log(`Installing dependencies for ${apps.length} app(s)…\n`);

let ok = 0;
let fail = 0;

for (const name of apps) {
  const dir = path.join(appsDir, name);
  process.stdout.write(`  ${name.padEnd(24)} `);
  try {
    execSync("npm install --omit=dev --no-fund --no-audit --loglevel=error", {
      cwd: dir,
      stdio: "pipe"
    });
    console.log("✓");
    ok++;
  } catch (err) {
    console.log("✗  " + (err.stderr ? err.stderr.toString().trim().split("\n")[0] : err.message));
    fail++;
  }
}

console.log(`\n${ok} succeeded, ${fail} failed.`);
if (fail) process.exit(1);
