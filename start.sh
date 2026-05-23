#!/bin/sh
# ── WispNodes startup ─────────────────────────────────────────────────────────
# Pterodactyl containers often inherit broken DNS from the Docker host.
# Writing 1.1.1.1 / 8.8.8.8 fixes node-gyp's node-header download
# (needed to compile node-pty when no pre-built binary matches the Node ABI).
# The write is silently ignored if /etc/resolv.conf is read-only.

printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\n" > /etc/resolv.conf 2>/dev/null || true

# Install / rebuild native deps.
# node_modules persists across restarts in Pterodactyl, so this is fast
# on second launch (npm will just verify everything is current).
npm install --no-audit --no-fund

exec node src/server.js
