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
const serverHost = process.env.MC_HOST || "ICE_MC_fun.aternos.me";
const serverPort = Number(process.env.MC_PORT || 13174);

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

let bot = null;
let state = "idle";
let lastError = null;
let connectedAt = null;
let reconnectEnabled = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let stableConnectionTimer = null;
let jumpInterval = null;
let jumpPulseTimer = null;

function isAuthorized(req) {
  if (isLoopback(host)) return true;
  if (!controlToken) return false;

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

function clearJumpTimers(targetBot = bot) {
  if (jumpInterval) {
    clearInterval(jumpInterval);
    jumpInterval = null;
  }
  if (jumpPulseTimer) {
    clearTimeout(jumpPulseTimer);
    jumpPulseTimer = null;
  }
  if (targetBot) {
    try {
      targetBot.setControlState("jump", false);
    } catch {
      // The connection may already be closed.
    }
  }
}

function startJumpLoop(targetBot) {
  clearJumpTimers(targetBot);
  jumpInterval = setInterval(() => {
    if (bot !== targetBot || state !== "online") return;

    try {
      targetBot.setControlState("jump", true);
      jumpPulseTimer = setTimeout(() => {
        jumpPulseTimer = null;
        if (bot !== targetBot) return;
        try {
          targetBot.setControlState("jump", false);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }, 500);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }, 30_000);
}

function scheduleReconnect() {
  if (!reconnectEnabled || reconnectTimer) return;

  const delay = Math.min(60_000, 5_000 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (reconnectEnabled) connectBot();
  }, delay);
  reconnectTimer.unref?.();
}

function clearStableConnectionTimer() {
  if (stableConnectionTimer) {
    clearTimeout(stableConnectionTimer);
    stableConnectionTimer = null;
  }
}

function connectBot() {
  if (!reconnectEnabled || bot) return false;

  state = "connecting";
  connectedAt = null;

  try {
    const auth = process.env.MC_AUTH || "offline";
    bot = mineflayer.createBot({
      host: serverHost,
      port: serverPort,
      username: process.env.MC_USERNAME,
      auth,
      ...(process.env.MC_VERSION ? { version: process.env.MC_VERSION } : {}),
    });

    const currentBot = bot;

    currentBot.once("login", () => {
      if (bot !== currentBot) return;
      state = "online";
      connectedAt = new Date().toISOString();
      lastError = null;
      clearStableConnectionTimer();
      stableConnectionTimer = setTimeout(() => {
        reconnectAttempt = 0;
        stableConnectionTimer = null;
      }, 120_000);
      stableConnectionTimer.unref?.();
    });

    currentBot.on("spawn", () => {
      if (bot === currentBot) startJumpLoop(currentBot);
    });

    currentBot.on("error", (error) => {
      lastError = error.message;
      if (state !== "stopping") state = "error";
    });

    currentBot.once("kicked", (reason) => {
      lastError = typeof reason === "string" ? reason : String(reason);
    });

    currentBot.once("end", (reason) => {
      clearJumpTimers(currentBot);
      clearStableConnectionTimer();
      if (bot === currentBot) bot = null;
      connectedAt = null;

      if (reason && !lastError) lastError = String(reason);
      if (state === "stopping" || !reconnectEnabled) {
        state = "idle";
        return;
      }

      state = "disconnected";
      scheduleReconnect();
    });

    return true;
  } catch (error) {
    bot = null;
    state = "error";
    lastError = error instanceof Error ? error.message : String(error);
    scheduleReconnect();
    return false;
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

app.get("/api/status", requireControlAuthorization, (_req, res) => {
  res.json(publicStatus());
});

app.post("/api/start", requireControlAuthorization, (_req, res) => {
  if (bot || reconnectTimer) {
    return res.status(409).json({ error: "The bot is already active or scheduled to reconnect." });
  }

  const username = process.env.MC_USERNAME;

  if (!username) {
    return res.status(400).json({
      error: "Set MC_USERNAME before starting the bot.",
    });
  }

  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    return res.status(400).json({ error: "MC_PORT must be between 1 and 65535." });
  }

  const auth = process.env.MC_AUTH || "offline";
  if (!["offline", "microsoft"].includes(auth)) {
    return res.status(400).json({ error: "MC_AUTH must be offline or microsoft." });
  }

  reconnectEnabled = true;
  reconnectAttempt = 0;
  lastError = null;
  connectedAt = null;

  const started = connectBot();
  if (!started) {
    return res.status(500).json({ error: "Could not start the bot.", ...publicStatus() });
  }

  return res.status(202).json(publicStatus());
});

app.post("/api/stop", requireControlAuthorization, (_req, res) => {
  reconnectEnabled = false;
  reconnectAttempt = 0;
  clearStableConnectionTimer();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (!bot) {
    clearJumpTimers();
    state = "idle";
    return res.json(publicStatus());
  }

  state = "stopping";
  const currentBot = bot;
  clearJumpTimers(currentBot);
  try {
    currentBot.quit("Bot stopped by operator");
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    if (bot === currentBot) bot = null;
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
  if (process.env.MC_AUTO_START === "true" && process.env.MC_USERNAME) {
    reconnectEnabled = true;
    reconnectAttempt = 0;
    connectBot();
  }
});
