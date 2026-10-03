const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const dotenv = require("dotenv");
const express = require("express");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const { Client, GatewayIntentBits, ChannelType } = require("discord.js");
const {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus
} = require("@discordjs/voice");

dotenv.config();

if (ffmpegPath) {
  process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH || ""}`;
}

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "bots.config.json"), "utf8"));
if (!Array.isArray(config.bots) || config.bots.length !== 15) {
  throw new Error("bots.config.json must contain exactly 15 bot entries.");
}

const audioDirectory = path.resolve(__dirname, process.env.AUDIO_UPLOAD_DIR || "uploads");
fs.mkdirSync(audioDirectory, { recursive: true });
const allowedAudioExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"]);
const audioFiles = new Map();
const sessions = new Map();
const loginAttempts = new Map();
const clients = [];
const bots = new Map();
const app = express();
const port = Number(process.env.PORT || 3000);
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === "production";

function readAudioFiles() {
  for (const fileName of fs.readdirSync(audioDirectory)) {
    if (!allowedAudioExtensions.has(path.extname(fileName).toLowerCase())) continue;
    const filePath = path.join(audioDirectory, fileName);
    if (fs.statSync(filePath).isFile()) {
      audioFiles.set(fileName, {
        id: fileName,
        name: fileName.replace(/^[0-9a-f-]{36}-/i, ""),
        filePath
      });
    }
  }
}

readAudioFiles();

for (const bot of config.bots) {
  bots.set(bot.id, {
    config: bot,
    client: null,
    status: process.env[bot.tokenEnv] ? "connecting" : "token_missing",
    voiceConnection: null,
    player: null,
    guildId: bot.guildId || "",
    channelId: bot.voiceChannelId || "",
    muted: false,
    deafened: false,
    playing: false,
    currentAudio: null,
    error: null
  });
}

function safeFileBaseName(originalName) {
  const base = path.parse(originalName).name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || "audio";
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, audioDirectory),
    filename: (_request, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      callback(null, `${crypto.randomUUID()}-${safeFileBaseName(file.originalname)}${extension}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedAudioExtensions.has(extension)) {
      callback(new Error("Unsupported audio file. Upload MP3, WAV, OGG, OPUS, M4A, AAC, FLAC, or WEBM."));
      return;
    }
    if (!file.mimetype.startsWith("audio/") && file.mimetype !== "application/octet-stream") {
      callback(new Error("The uploaded file must be recognized as audio."));
      return;
    }
    callback(null, true);
  }
});

app.disable("x-powered-by");
app.set("trust proxy", isProduction ? 1 : false);
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

function getSession(request) {
  const cookie = request.headers.cookie || "";
  const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("soundbot_session="))?.slice("soundbot_session=".length);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
}

function requireAuth(request, response, next) {
  if (!process.env.DASHBOARD_PASSWORD) {
    response.status(503).json({ error: "Dashboard password is not configured. Set DASHBOARD_PASSWORD in the service environment." });
    return;
  }
  if (!getSession(request)) {
    response.status(401).json({ error: "Log in to control the bots." });
    return;
  }
  next();
}

function sendError(response, error, status = 400) {
  response.status(status).json({ error: error.message || String(error) });
}

function getBot(botId) {
  const runtime = bots.get(botId);
  if (!runtime) throw Object.assign(new Error("Unknown bot."), { status: 404 });
  return runtime;
}

function botSummary(runtime) {
  return {
    id: runtime.config.id,
    name: runtime.config.name,
    status: runtime.status,
    guildId: runtime.guildId,
    channelId: runtime.channelId,
    botName: runtime.client?.user?.username || null,
    muted: runtime.muted,
    deafened: runtime.deafened,
    playing: runtime.playing,
    audioName: runtime.currentAudio?.name || null,
    error: runtime.error
  };
}

app.get("/health", (_request, response) => {
  response.json({ status: "ok", configuredBots: config.bots.length });
});

app.post("/api/login", (request, response) => {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    response.status(503).json({ error: "Set DASHBOARD_PASSWORD in the service environment before logging in." });
    return;
  }

  const ip = request.ip || request.socket.remoteAddress || "unknown";
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.blockedUntil > Date.now()) {
    response.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
    return;
  }

  const candidate = typeof request.body?.password === "string" ? request.body.password : "";
  const matches = crypto.timingSafeEqual(
    crypto.createHash("sha256").update(candidate).digest(),
    crypto.createHash("sha256").update(password).digest()
  );
  if (!matches) {
    const failures = (attempt?.failures || 0) + 1;
    loginAttempts.set(ip, {
      failures: failures >= 10 ? 0 : failures,
      blockedUntil: failures >= 10 ? Date.now() + 5 * 60 * 1000 : 0
    });
    response.status(401).json({ error: "Incorrect password." });
    return;
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { expiresAt: Date.now() + sessionLifetimeMs });
  response.setHeader("Set-Cookie", `soundbot_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetimeMs / 1000}${request.secure || isProduction ? "; Secure" : ""}`);
  response.json({ ok: true });
});

app.post("/api/logout", requireAuth, (request, response) => {
  const current = getSession(request);
  if (current) sessions.delete(current.token);
  response.setHeader("Set-Cookie", "soundbot_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  response.json({ ok: true });
});

app.get("/api/status", requireAuth, (_request, response) => {
  response.json({
    bots: [...bots.values()].map(botSummary),
    audio: [...audioFiles.values()].map(({ id, name }) => ({ id, name }))
  });
});

app.post("/api/audio", requireAuth, (request, response, next) => {
  upload.single("audio")(request, response, (error) => {
    if (error) {
      sendError(response, error, error instanceof multer.MulterError ? 413 : 400);
      return;
    }
    if (!request.file) {
      response.status(400).json({ error: "Choose an audio file to upload." });
      return;
    }
    const record = {
      id: request.file.filename,
      name: request.file.originalname,
      filePath: request.file.path
    };
    audioFiles.set(record.id, record);
    response.status(201).json({ audio: { id: record.id, name: record.name } });
  });
});

app.get("/api/bots/:botId/guilds", requireAuth, async (request, response) => {
  try {
    const runtime = getBot(request.params.botId);
    if (!runtime.client?.isReady()) {
      response.status(409).json({ error: "This bot is not online. Check its token and invite it to a server." });
      return;
    }
    const guilds = runtime.client.guilds.cache;
    response.json({
      guilds: [...guilds.values()].map((guild) => ({ id: guild.id, name: guild.name }))
    });
  } catch (error) {
    sendError(response, error, error.status || 502);
  }
});

app.get("/api/bots/:botId/channels", requireAuth, async (request, response) => {
  try {
    const runtime = getBot(request.params.botId);
    if (!runtime.client?.isReady()) {
      response.status(409).json({ error: "This bot is not online." });
      return;
    }
    const guildId = request.query.guildId;
    if (typeof guildId !== "string" || !guildId) {
      response.status(400).json({ error: "Select a server first." });
      return;
    }
    const guild = await runtime.client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    response.json({
      channels: [...channels.values()]
        .filter((channel) => channel && channel.type === ChannelType.GuildVoice)
        .map((channel) => ({ id: channel.id, name: channel.name, parentName: channel.parent?.name || null }))
    });
  } catch (error) {
    sendError(response, error, error.status || 502);
  }
});

app.put("/api/bots/:botId/channel", requireAuth, async (request, response) => {
  try {
    const runtime = getBot(request.params.botId);
    if (!runtime.client?.isReady()) throw new Error("This bot is not online.");
    const { guildId, channelId } = request.body || {};
    if (typeof guildId !== "string" || typeof channelId !== "string" || !guildId) {
      throw new Error("Select a server and voice channel.");
    }
    const guild = await runtime.client.guilds.fetch(guildId);
    if (!channelId) {
      if (runtime.voiceConnection) stopBot(runtime);
      runtime.guildId = guild.id;
      runtime.channelId = "";
      runtime.error = null;
      response.json({ bot: botSummary(runtime) });
      return;
    }
    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      throw new Error("Select a valid voice channel.");
    }
    if (runtime.voiceConnection) stopBot(runtime);
    runtime.guildId = guild.id;
    runtime.channelId = channel.id;
    runtime.error = null;
    response.json({ bot: botSummary(runtime) });
  } catch (error) {
    sendError(response, error, error.status || 400);
  }
});

async function startBot(runtime, audio) {
  if (!runtime.client?.isReady()) throw new Error(`${runtime.config.name} is not online.`);
  if (!runtime.guildId || !runtime.channelId) throw new Error(`${runtime.config.name}: select a server and voice channel first.`);
  if (!audio || !fs.existsSync(audio.filePath)) throw new Error("Upload or select an audio file first.");

  const guild = await runtime.client.guilds.fetch(runtime.guildId);
  const channel = await guild.channels.fetch(runtime.channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error(`${runtime.config.name}: the selected voice channel is no longer available.`);
  }

  stopBot(runtime);
  const joinOptions = {
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: runtime.deafened,
    selfMute: runtime.muted
  };
  const connection = joinVoiceChannel(joinOptions);
  runtime.voiceConnection = connection;
  runtime.status = "connecting";
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    const player = createAudioPlayer();
    const volume = runtime.config.volume ?? config.defaults?.volume ?? 0.5;
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new Error(`${runtime.config.name}: volume must be between 0 and 1.`);
    }

    const resource = createAudioResource(audio.filePath, { inlineVolume: true });
    resource.volume.setVolume(volume);
    connection.subscribe(player);
    player.play(resource);
    runtime.player = player;
    runtime.currentAudio = audio;
    runtime.playing = true;
    runtime.status = "connected";
    runtime.error = null;

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (runtime.voiceConnection === connection) {
        runtime.status = "disconnected";
        runtime.playing = false;
        runtime.voiceConnection = null;
        runtime.player = null;
      }
    });
    player.on(AudioPlayerStatus.Idle, () => {
      if (runtime.player === player) runtime.playing = false;
    });
    player.on("error", (error) => {
      runtime.error = error.message;
      runtime.playing = false;
      console.error(`${runtime.config.id}: audio playback failed:`, error);
    });
  } catch (error) {
    connection.destroy();
    runtime.voiceConnection = null;
    runtime.status = runtime.client?.isReady() ? "ready" : "error";
    throw error;
  }
}

function stopBot(runtime) {
  if (runtime.player) {
    runtime.player.stop(true);
    runtime.player = null;
  }
  if (runtime.voiceConnection) {
    runtime.voiceConnection.destroy();
    runtime.voiceConnection = null;
  }
  runtime.playing = false;
  runtime.status = runtime.client?.isReady() ? "ready" : runtime.status;
  runtime.muted = false;
  runtime.deafened = false;
}

function setVoiceFlags(runtime, change) {
  if (!runtime.voiceConnection) return false;
  const muted = change.muted ?? runtime.muted;
  const deafened = change.deafened ?? runtime.deafened;
  const accepted = runtime.voiceConnection.rejoin({
    channelId: runtime.channelId,
    selfMute: muted,
    selfDeaf: deafened
  });
  if (!accepted) throw new Error(`${runtime.config.name}: Discord rejected the voice state update.`);
  runtime.muted = muted;
  runtime.deafened = deafened;
  return true;
}

app.post("/api/control", requireAuth, async (request, response) => {
  const { action, botIds, audioId } = request.body || {};
  const allowedActions = new Set(["start", "start-all", "stop", "stop-all", "mute-all", "unmute-all", "deafen-all", "undeafen-all"]);
  if (!allowedActions.has(action)) {
    response.status(400).json({ error: "Choose a valid bot action." });
    return;
  }

  let targets;
  if (action === "start-all") {
    targets = [...bots.values()];
  } else if (action.endsWith("-all")) {
    targets = [...bots.values()].filter((bot) => bot.voiceConnection);
  } else {
    if (!Array.isArray(botIds) || botIds.length === 0) {
      response.status(400).json({ error: "Select at least one bot." });
      return;
    }
    try {
      targets = [...new Set(botIds)].map(getBot);
    } catch (error) {
      sendError(response, error, error.status || 400);
      return;
    }
  }

  let audio = null;
  if (action === "start" || action === "start-all") {
    audio = typeof audioId === "string" ? audioFiles.get(audioId) : null;
    if (!audio) {
      response.status(400).json({ error: "Upload or select an audio file before starting." });
      return;
    }
  }

  const results = await Promise.all(targets.map(async (runtime) => {
    try {
      if (action === "start" || action === "start-all") await startBot(runtime, audio);
      if (action === "stop" || action === "stop-all") stopBot(runtime);
      if (action === "mute-all") setVoiceFlags(runtime, { muted: true });
      if (action === "unmute-all") setVoiceFlags(runtime, { muted: false });
      if (action === "deafen-all") setVoiceFlags(runtime, { deafened: true });
      if (action === "undeafen-all") setVoiceFlags(runtime, { deafened: false });
      return { id: runtime.config.id, ok: true, bot: botSummary(runtime) };
    } catch (error) {
      runtime.error = error.message;
      return { id: runtime.config.id, ok: false, error: error.message, bot: botSummary(runtime) };
    }
  }));
  response.json({ results });
});

app.use((error, _request, response, _next) => {
  console.error("Request failed:", error);
  if (response.headersSent) return;
  sendError(response, error, error.status || 500);
});

const server = http.createServer(app);
server.on("error", (error) => {
  console.error("Web server failed:", error);
  process.exitCode = 1;
});
server.listen(port, "0.0.0.0", () => {
  console.log(`Dashboard listening on port ${port}.`);
  if (!process.env.DASHBOARD_PASSWORD) {
    console.error("DASHBOARD_PASSWORD is missing; dashboard control remains locked until it is set.");
  }
});

function connectDiscordBot(runtime) {
  const token = process.env[runtime.config.tokenEnv];
  if (!token) return;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  runtime.client = client;
  clients.push(client);
  client.once("ready", () => {
    runtime.status = "ready";
    runtime.error = null;
    console.log(`${runtime.config.name} logged in as ${client.user.tag}.`);
    if (runtime.config.enabled ?? config.defaults?.enabled) {
      const initialAudio = runtime.config.soundFile
        ? audioFiles.get(path.basename(runtime.config.soundFile)) || {
          id: runtime.config.soundFile,
          name: path.basename(runtime.config.soundFile),
          filePath: path.resolve(__dirname, runtime.config.soundFile)
        }
        : null;
      startBot(runtime, initialAudio).catch((error) => {
        runtime.error = error.message;
        runtime.status = "error";
        console.error(`${runtime.config.name} could not auto-start:`, error);
      });
    }
  });
  client.on("error", (error) => {
    runtime.status = "error";
    runtime.error = error.message;
    console.error(`${runtime.config.name}: Discord client error:`, error);
  });
  client.login(token).catch((error) => {
    runtime.status = "error";
    runtime.error = error.message;
    console.error(`${runtime.config.name}: Discord login failed:`, error);
  });
}

for (const runtime of bots.values()) connectDiscordBot(runtime);

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  for (const runtime of bots.values()) stopBot(runtime);
  await Promise.allSettled(clients.map((client) => client.destroy()));
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
