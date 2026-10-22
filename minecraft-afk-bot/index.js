"use strict";

const crypto = require("node:crypto");
const express = require("express");
const mineflayer = require("mineflayer");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8kb" }));

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const controlToken = process.env.CONTROL_TOKEN || "";

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

if (!isLoopback(host) && !controlToken) {
  throw new Error("Set CONTROL_TOKEN before binding the control API to a non-local address.");
}

let bot = null;
let state = "idle";
let lastError = null;
let connectedAt = null;

function isAuthorized(req) {
  if (isLoopback(host)) return true;

  const authorization = req.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedBuffer = Buffer.from(controlToken);
  const suppliedBuffer = Buffer.from(supplied);

  return (
    suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function requireControlAuthorization(req, res, next) {
  if (isAuthorized(req)) return next();
  return res.status(401).json({ error: "Unauthorized." });
}

function publicStatus() {
  return {
    state,
    connectedAt,
    lastError,
    username: process.env.MC_USERNAME || null,
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/status", (_req, res) => {
  res.json(publicStatus());
});

app.post("/api/start", requireControlAuthorization, (_req, res) => {
  if (bot) {
    return res.status(409).json({ error: "The bot is already connecting or connected." });
  }

  const serverHost = process.env.MC_HOST;
  const username = process.env.MC_USERNAME;

  if (!serverHost || !username) {
    return res.status(400).json({
      error: "Set MC_HOST and MC_USERNAME before starting the bot.",
    });
  }

  const serverPort = Number(process.env.MC_PORT || 25565);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    return res.status(400).json({ error: "MC_PORT must be between 1 and 65535." });
  }

  const auth = process.env.MC_AUTH || "offline";
  if (!["offline", "microsoft"].includes(auth)) {
    return res.status(400).json({ error: "MC_AUTH must be offline or microsoft." });
  }

  state = "connecting";
  lastError = null;
  connectedAt = null;

  try {
    bot = mineflayer.createBot({
      host: serverHost,
      port: serverPort,
      username,
      auth,
      ...(process.env.MC_VERSION ? { version: process.env.MC_VERSION } : {}),
    });

    bot.once("login", () => {
      state = "online";
      connectedAt = new Date().toISOString();
    });

    bot.on("error", (error) => {
      lastError = error.message;
      if (state !== "stopping") state = "error";
    });

    bot.once("kicked", (reason) => {
      lastError = typeof reason === "string" ? reason : JSON.stringify(reason);
    });

    bot.once("end", (reason) => {
      if (reason && !lastError) lastError = String(reason);
      bot = null;
      connectedAt = null;
      if (state !== "stopping") state = "disconnected";
    });
  } catch (error) {
    bot = null;
    state = "error";
    lastError = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: "Could not start the bot.", ...publicStatus() });
  }

  return res.status(202).json(publicStatus());
});

app.post("/api/stop", requireControlAuthorization, (_req, res) => {
  if (!bot) {
    state = "idle";
    return res.json(publicStatus());
  }

  state = "stopping";
  try {
    bot.quit("Bot stopped by operator");
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    bot = null;
    state = "error";
  }

  return res.json(publicStatus());
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  return res.status(500).json({ error: "Internal server error." });
});

app.listen(port, host, () => {
  process.stdout.write(`Minecraft bot control API listening on ${host}:${port}\n`);
});
