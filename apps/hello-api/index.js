"use strict";

const express = require("express");
const app = express();
const PORT = process.env.PORT || 3001;

app.get("/", (_req, res) => res.json({ app: "hello-api", status: "ok", time: new Date().toISOString() }));
app.get("/ping", (_req, res) => res.send("pong"));

app.listen(PORT, () => console.log(`hello-api listening on port ${PORT}`));
