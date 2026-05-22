# WispNodes

Standalone PM2-backed Node app manager. This app is separate from the web terminal and is meant to run as its own server.

## Features

- Discovers app folders under `./apps`
- Starts, stops, restarts, and deletes PM2-managed processes
- Persists app definitions in `./data/manager-config.json`
- Tails per-process PM2 logs in the dashboard
- Optionally downloads and runs `cloudflared` with a token
- Supports optional HTTP Basic Auth for the dashboard

## Quick Start

```bash
cd wispnodes
npm install
npm start
```

Then open the server on the configured port.

## Pterodactyl Deployment

For Wispbyte-style panels where you do not control the startup shell, use only this layout:

1. Upload the **contents** of `wispnodes/` as the server root.
   This means `/home/container/package.json` must be the `wispnodes/package.json` file.
2. Set:

```text
JS_FILE=src/server.js
```

Do not upload the parent repo and point `JS_FILE` into `wispnodes/src/server.js`. The default Node egg will still run `npm install` against `/home/container/package.json`, which would install the wrong dependency set.

## Wispbyte Recovery

If the server root already looks correct but startup throws module or function errors, treat it as a mixed deployment and replace the app files cleanly.

Keep these:

- `/home/container/.env`
- `/home/container/apps`
- `/home/container/data`

Replace these from a fresh copy of `wispnodes/`:

- `/home/container/package.json`
- `/home/container/package-lock.json`
- `/home/container/src`
- `/home/container/public`

Delete before reinstalling:

- `/home/container/node_modules`

Expected file checks:

- local `wispnodes/.env.example` is `253` bytes
- local `wispnodes/package.json` is `438` bytes
- local `wispnodes/src/pm2-manager.js` starts with:

```js
"use strict";

const fs = require("fs");
const path = require("path");

const pm2 = require("pm2");
```

- local `wispnodes/src/server.js` starts with:

```js
"use strict";

require("dotenv").config();
```

If `/home/container/src/pm2-manager.js` contains `createPm2Manager(` near the top level, that file is wrong. That line belongs in `src/server.js`, not `src/pm2-manager.js`.

## Environment

```bash
SERVER_PORT=3000
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=change-this-password
WISPNODES_APPS_DIR=./apps
WISPNODES_DATA_DIR=./data
PM2_HOME=./data/.pm2
PM2_USE_USERLAND=0
USERLAND_DIR=/home/container/.userland
CF_TUNNEL_TOKEN=
CF_TUNNEL_AUTO_START=1
```

## App Discovery

WispNodes scans `./apps` and tries to infer a start command in this order:

1. `npm start` if `package.json` has a `start` script
2. `node <main>` if `package.json` has a `main`
3. `node index.js`
4. `node src/index.js`

You can override the command from the dashboard when starting a process.

## Example Apps

`wispnodes/apps` now includes six minimal Node examples:

- `hello-index`: plain `index.js`
- `hello-start`: `package.json` with `scripts.start`
- `hello-main`: `package.json` with `main`
- `hello-src`: `src/index.js`
- `env-viewer`: shows key runtime env values from WispNodes
- `json-api`: small API with `/health` and `/echo`

These are dependency-free. Upload them as part of `wispnodes` and WispNodes will discover them automatically.

Suggested ports:

- `hello-index` -> `4101`
- `hello-start` -> `4102`
- `hello-main` -> `4103`
- `hello-src` -> `4104`
- `env-viewer` -> `4105`
- `json-api` -> `4106`

WispNodes now shows the configured port and a suggested tunnel origin like `http://127.0.0.1:4101` in the dashboard. That value is only reliable if the app is started with a port or exports `PORT` in its PM2 environment.

## Notes

- `PM2_USE_USERLAND=0` is the safer default for Node apps in Pterodactyl because Node and npm usually exist in the host container, not inside the Debian or Alpine userland.
- Cloudflare support here is token-based `cloudflared tunnel run --token ...`, not a full named-tunnel config manager.
- The dashboard uses Basic Auth only if both `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` are set.
