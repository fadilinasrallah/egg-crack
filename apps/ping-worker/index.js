"use strict";

const axios = require("axios");

const TARGET = process.env.PING_TARGET || "http://localhost:9127";
const INTERVAL_MS = Number(process.env.PING_INTERVAL || 10000);

async function ping() {
  try {
    const res = await axios.get(TARGET, { timeout: 5000 });
    console.log(`[ping-worker] ${TARGET} -> ${res.status}`);
  } catch (e) {
    console.error(`[ping-worker] ${TARGET} -> ${e.message}`);
  }
}

console.log(`[ping-worker] started, pinging ${TARGET} every ${INTERVAL_MS}ms`);
ping();
setInterval(ping, INTERVAL_MS);
