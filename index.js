const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
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
  StreamType,
  createAudioPlayer,
  createAudioResource,
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
const opusCacheDirectory = path.join(audioDirectory, ".opus-cache");
fs.mkdirSync(audioDirectory, { recursive: true });
const allowedAudioExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".webm"]);
const audioFiles = new Map();
const audioPreparations = new WeakMap();
const audioVariantPreparations = new WeakMap();
let masterAudioGain = 1;
const sessions = new Map();
const loginAttempts = new Map();
const clients = [];
const bots = new Map();
const tokenOwners = new Map();
const observedVoiceNetworks = new WeakSet();
const app = express();
const port = Number(process.env.PORT || 3000);
const sessionLifetimeMs = 12 * 60 * 60 * 1000;
const voiceReadyTimeoutMs = 45_000;
const audioProgressTimeoutMs = 30_000;
const voiceNetworkStages = [
  "opening voice WebSocket",
  "identifying with voice server",
  "performing UDP discovery",
  "selecting voice protocol",
  "voice network ready",
  "resuming voice session",
  "voice network closed"
];
const isProduction = process.env.NODE_ENV === "production";
const configuredChannelIds = [...new Set(config.bots.map((bot) => bot.voiceChannelId).filter(Boolean))];
let fleetChannelId = process.env.VOICE_CHANNEL_ID || (configuredChannelIds.length === 1 ? configuredChannelIds[0] : "");

function readAudioFiles() {
  for (const fileName of fs.readdirSync(audioDirectory)) {
    if (!allowedAudioExtensions.has(path.extname(fileName).toLowerCase())) continue;
    const filePath = path.join(audioDirectory, fileName);
    if (fs.statSync(filePath).isFile()) {
      audioFiles.set(fileName, {
        id: fileName,
        name: fileName.replace(/^[0-9a-f-]{36}-/i, ""),
        filePath,
        preparation: {
          state: "idle",
          progress: 0,
          processedSeconds: 0,
          durationSeconds: null,
          stage: "Select this track to prepare it for playback.",
          error: null,
          gain: null
        }
      });
    }
  }
}

readAudioFiles();

async function prepareAudioForPlayback(audio, volume, onProgress = () => {}) {
  if (!audio || !fs.existsSync(audio.filePath)) {
    throw new Error("Upload or select an audio file first.");
  }
  if (!ffmpegPath) {
    throw new Error("Audio conversion is unavailable because FFmpeg is not installed.");
  }
  let preparations = audioPreparations.get(audio);
  if (!preparations) {
    preparations = new Map();
    audioPreparations.set(audio, preparations);
  }
  const inProgress = preparations.get(volume);
  if (inProgress) {
    onProgress({ progress: 0, processedSeconds: 0, durationSeconds: null });
    return inProgress;
  }

  const sourceStats = fs.statSync(audio.filePath);
  const cacheId = crypto.createHash("sha256")
    .update(`${audio.id}:${sourceStats.size}:${sourceStats.mtimeMs}:${volume}`)
    .digest("hex");
  const outputPath = path.join(opusCacheDirectory, `${cacheId}.ogg`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    onProgress({ progress: 1, processedSeconds: 0, durationSeconds: null });
    return outputPath;
  }

  const preparation = new Promise((resolve, reject) => {
    fs.mkdirSync(opusCacheDirectory, { recursive: true });
    const temporaryPath = path.join(opusCacheDirectory, `${cacheId}-${crypto.randomUUID()}.tmp.ogg`);
    const ffmpeg = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "info",
      "-stats_period", "0.5",
      "-progress", "pipe:1",
      "-nostats",
      "-nostdin",
      "-y",
      "-i", audio.filePath,
      "-map", "0:a:0",
      "-vn",
      "-ac", "2",
      "-ar", "48000",
      "-af", `volume=${volume}:precision=float,alimiter=limit=0.95:attack=5:release=50`,
      "-c:a", "libopus",
      "-threads", "1",
      "-b:a", "128k",
      "-application", "audio",
      "-f", "ogg",
      temporaryPath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let ffmpegError = "";
    let progressOutput = "";
    let durationSeconds = null;
    let settled = false;
    let progressTimeout;
    const refreshProgressTimeout = () => {
      clearTimeout(progressTimeout);
      progressTimeout = setTimeout(() => {
        ffmpeg.kill();
        fail(new Error("Audio conversion stopped reporting progress for 30 seconds. Try a shorter or standard MP3/WAV file."));
      }, audioProgressTimeoutMs);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(progressTimeout);
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        error = new Error(`${error.message}; temporary audio cleanup failed: ${cleanupError.message}`);
      }
      reject(error);
    };

    ffmpeg.stdout.setEncoding("utf8");
    ffmpeg.stdout.on("data", (chunk) => {
      refreshProgressTimeout();
      progressOutput += chunk;
      const lines = progressOutput.split(/\r?\n/);
      progressOutput = lines.pop() || "";
      for (const line of lines) {
        const [key, value] = line.split("=", 2);
        if (key === "out_time_ms" && durationSeconds) {
          const processedSeconds = Number(value) / 1_000_000;
          if (Number.isFinite(processedSeconds)) {
            onProgress({
              progress: Math.min(0.99, processedSeconds / durationSeconds),
              processedSeconds,
              durationSeconds
            });
          }
        }
      }
    });
    ffmpeg.stderr.setEncoding("utf8");
    ffmpeg.stderr.on("data", (chunk) => {
      ffmpegError = `${ffmpegError}${chunk}`.slice(-4000);
      const duration = ffmpegError.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
      if (duration) {
        durationSeconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
      }
    });
    ffmpeg.once("error", (error) => {
      fail(new Error(`FFmpeg could not prepare this audio file: ${error.message}`));
    });
    ffmpeg.once("close", (code) => {
      if (settled) return;
      clearTimeout(progressTimeout);
      if (code !== 0) {
        fail(new Error(`FFmpeg could not convert this audio file${ffmpegError.trim() ? `: ${ffmpegError.trim()}` : ` (exit code ${code})`}`));
        return;
      }
      try {
        if (!fs.existsSync(temporaryPath) || fs.statSync(temporaryPath).size === 0) {
          throw new Error("FFmpeg produced an empty audio stream.");
        }
        fs.renameSync(temporaryPath, outputPath);
        settled = true;
        onProgress({ progress: 1, processedSeconds: durationSeconds || 0, durationSeconds });
        resolve(outputPath);
      } catch (error) {
        fail(new Error(`Could not cache the converted audio file: ${error.message}`));
      }
    });
    refreshProgressTimeout();
  });
  preparations.set(volume, preparation);
  try {
    return await preparation;
  } finally {
    preparations.delete(volume);
    if (preparations.size === 0) audioPreparations.delete(audio);
  }
}

for (const bot of config.bots) {
  bots.set(bot.id, {
    config: bot,
    client: null,
    gatewayState: process.env[bot.tokenEnv] ? "connecting" : "token_missing",
    gatewayError: null,
    status: process.env[bot.tokenEnv] ? "connecting" : "token_missing",
    voiceConnection: null,
    player: null,
    voiceNetworkStage: null,
    voiceNetworkCloseCode: null,
    guildId: bot.guildId || "",
    channelId: fleetChannelId || bot.voiceChannelId || "",
    muted: false,
    deafened: false,
    playing: false,
    currentAudio: null,
    voiceHandshake: null,
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

function explainDiscordAccessError(runtime, error) {
  if (error.code === 50001 || error.code === "50001" || error.message === "Missing Access") {
    return `${runtime.config.name}: this bot has Missing Access to the selected channel. Invite this bot to the server and grant View Channel and Connect on the channel/category.`;
  }
  return error.message || String(error);
}

function botSummary(runtime) {
  const networkStatus = runtime.voiceConnection?.state?.networking?.state?.code;
  return {
    id: runtime.config.id,
    name: runtime.config.name,
    hasToken: Boolean(process.env[runtime.config.tokenEnv]),
    online: Boolean(runtime.client?.isReady()),
    gatewayState: runtime.gatewayState,
    gatewayError: runtime.gatewayError,
    status: runtime.status,
    guildId: runtime.guildId,
    channelId: runtime.channelId,
    botName: runtime.client?.user?.username || null,
    muted: runtime.muted,
    deafened: runtime.deafened,
    playing: runtime.playing,
    audioName: runtime.currentAudio?.name || null,
    voiceState: runtime.voiceConnection?.state?.status || null,
    voiceHandshake: runtime.voiceHandshake,
    voiceNetworkCloseCode: runtime.voiceNetworkCloseCode,
    voiceNetworkStage: runtime.voiceNetworkStage ||
      (Number.isInteger(networkStatus) ? voiceNetworkStages[networkStatus] || "unknown voice network stage" : null),
    error: runtime.error
  };
}

app.get("/health", (_request, response) => {
  response.json({ status: "ok", configuredBots: config.bots.length, audioFormat: "Ogg Opus" });
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
    fleetChannelId,
    masterAudioGain,
    bots: [...bots.values()].map(botSummary),
    audio: [...audioFiles.values()].map(({ id, name, preparation }) => ({ id, name, preparation }))
  });
});

app.put("/api/audio/gain", requireAuth, (request, response) => {
  const gain = request.body?.multiplier;
  if (typeof gain !== "number" || !Number.isFinite(gain) || gain < 0 || gain > 1000) {
    response.status(400).json({ error: "Master audio gain must be a number between 0 and 1000×." });
    return;
  }

  if (gain !== masterAudioGain) {
    masterAudioGain = gain;
    for (const audio of audioFiles.values()) {
      audio.preparation.state = "idle";
      audio.preparation.progress = 0;
      audio.preparation.processedSeconds = 0;
      audio.preparation.durationSeconds = null;
      audio.preparation.stage = `Gain changed to ${gain}×; select or play this track to prepare it.`;
      audio.preparation.error = null;
      audio.preparation.gain = null;
    }
  }
  response.json({ masterAudioGain });
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
      filePath: request.file.path,
      preparation: {
        state: "preparing",
        progress: 0,
        processedSeconds: 0,
        durationSeconds: null,
        stage: "Preparing audio for all configured bot volumes.",
        error: null,
        gain: masterAudioGain
      }
    };
    audioFiles.set(record.id, record);
    response.status(201).json({ audio: { id: record.id, name: record.name } });
    setImmediate(() => prepareAudioVariants(record).catch((error) => {
      if (record.preparation.gain === masterAudioGain) {
        record.preparation.state = "error";
        record.preparation.stage = "Audio preparation failed.";
        record.preparation.error = error.message;
      }
      console.error(`Could not prepare audio ${record.name}:`, error);
    }));
  });
});

function prepareAudioVariants(audio) {
  if (!audio.preparation) {
    audio.preparation = {
      state: "idle",
      progress: 0,
      processedSeconds: 0,
      durationSeconds: null,
      stage: "Preparing audio for playback.",
      error: null,
      gain: null
    };
  }
  const gain = masterAudioGain;
  if (audio.preparation.state === "ready" && audio.preparation.gain === gain) return Promise.resolve();
  let preparations = audioVariantPreparations.get(audio);
  if (!preparations) {
    preparations = new Map();
    audioVariantPreparations.set(audio, preparations);
  }
  const activePreparation = preparations.get(gain);
  if (activePreparation) return activePreparation;
  const preparation = prepareAudioVariantsNow(audio, gain);
  preparations.set(gain, preparation);
  return preparation.finally(() => {
    preparations.delete(gain);
    if (preparations.size === 0) audioVariantPreparations.delete(audio);
  });
}

async function prepareAudioVariantsNow(audio, gain) {
  const baseVolumes = [...bots.values()].map((runtime) =>
    runtime.config.volume ?? config.defaults?.volume ?? 0.5
  );
  if (baseVolumes.some((volume) => !Number.isFinite(volume) || volume < 0 || volume > 1)) {
    throw new Error("Every configured bot volume must be between 0 and 1.");
  }
  const volumes = [...new Set(baseVolumes.map((volume) => volume * gain))];
  if (volumes.some((volume) => !Number.isFinite(volume) || volume < 0 || volume > 1000)) {
    throw new Error("Configured bot volume multiplied by master gain must be between 0 and 1000×.");
  }

  if (gain === masterAudioGain) {
    audio.preparation.state = "preparing";
    audio.preparation.error = null;
    audio.preparation.gain = gain;
  }
  for (const [index, volume] of volumes.entries()) {
    if (gain === masterAudioGain) {
      audio.preparation.stage = volumes.length > 1
        ? `Preparing volume ${index + 1} of ${volumes.length} at ${gain}× gain.`
        : `Optimizing audio for playback at ${gain}× gain.`;
    }
    const outputPath = await prepareAudioForPlayback(audio, volume, (progress) => {
      if (gain !== masterAudioGain) return;
      audio.preparation.progress = Math.floor(((index + progress.progress) / volumes.length) * 100);
      audio.preparation.processedSeconds = progress.processedSeconds;
      audio.preparation.durationSeconds = progress.durationSeconds;
    });
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error("Audio preparation finished without a playable output file.");
    }
  }
  if (gain === masterAudioGain) {
    audio.preparation.state = "ready";
    audio.preparation.progress = 100;
    audio.preparation.stage = `Ready to play at ${gain}× gain.`;
  }
}

app.post("/api/audio/:audioId/prepare", requireAuth, (request, response) => {
  const audio = audioFiles.get(request.params.audioId);
  if (!audio) {
    response.status(404).json({ error: "The selected audio file is no longer available." });
    return;
  }
  if (audio.preparation.state === "ready" && audio.preparation.gain === masterAudioGain) {
    response.json({ preparation: audio.preparation });
    return;
  }
  if (audio.preparation.state !== "preparing" || audio.preparation.gain !== masterAudioGain) {
    audio.preparation.error = null;
    audio.preparation.state = "preparing";
    audio.preparation.progress = 0;
    audio.preparation.processedSeconds = 0;
    audio.preparation.durationSeconds = null;
    audio.preparation.gain = masterAudioGain;
  }
  const preparationGain = masterAudioGain;
  prepareAudioVariants(audio).catch((error) => {
    if (preparationGain !== masterAudioGain) return;
    audio.preparation.state = "error";
    audio.preparation.stage = "Audio preparation failed.";
    audio.preparation.error = error.message;
    console.error(`Could not prepare audio ${audio.name}:`, error);
  });
  response.status(202).json({ preparation: audio.preparation });
});

app.put("/api/fleet/channel", requireAuth, async (request, response) => {
  try {
    const { channelId } = request.body || {};
    if (typeof channelId !== "string" || !/^\d{17,20}$/.test(channelId)) {
      throw new Error("Enter a valid Discord voice channel ID (17–20 digits).");
    }

    fleetChannelId = channelId;
    for (const runtime of bots.values()) {
      runtime.channelId = channelId;
      runtime.guildId = "";
      runtime.error = null;
    }

    const results = await Promise.all([...bots.values()].map(async (runtime) => {
      try {
        await joinBot(runtime);
        return { id: runtime.config.id, name: runtime.config.name, ok: true, bot: botSummary(runtime) };
      } catch (error) {
        const message = explainDiscordAccessError(runtime, error);
        runtime.error = message;
        console.error(`${runtime.config.id}: could not join voice channel ${channelId}:`, error);
        return { id: runtime.config.id, name: runtime.config.name, ok: false, error: message, bot: botSummary(runtime) };
      }
    }));
    const joined = results.filter((result) => result.ok).length;
    response.json({
      channelId: fleetChannelId,
      joined,
      total: results.length,
      results
    });
  } catch (error) {
    sendError(response, error, error.status || 400);
  }
});

async function waitForBotReady(runtime) {
  if (runtime.client?.isReady()) return;
  if (!runtime.client) {
    throw new Error(`${runtime.config.name}: bot token is missing; add ${runtime.config.tokenEnv} in Render.`);
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${runtime.config.name}: Discord login timed out. Check the bot token and Render logs.`));
    }, 30_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      runtime.client.removeListener("ready", onReady);
    };
    runtime.client.once("ready", onReady);
    if (runtime.client.isReady()) onReady();
  });
}

function waitForVoiceReady(connection, runtime) {
  if (connection.state.status === VoiceConnectionStatus.Ready) return Promise.resolve(connection);

  return new Promise((resolve, reject) => {
    let watchedNetworking = null;
    const timeout = setTimeout(() => {
      cleanup();
      const state = connection.state.status;
      const missing = [];
      if (!runtime.voiceHandshake?.voiceStateUpdateReceived) missing.push("bot voice-state update");
      if (!runtime.voiceHandshake?.voiceStateSessionReceived) missing.push("bot voice session ID");
      if (!runtime.voiceHandshake?.voiceServerUpdateReceived) missing.push("voice-server update");
      if (!runtime.voiceHandshake?.voiceServerEndpointReceived) missing.push("a valid voice-server endpoint");
      if (
        runtime.voiceHandshake?.voiceStateSessionReceived &&
        runtime.voiceHandshake?.voiceServerEndpointReceived
      ) missing.push("voice network to become ready");
      const detail = missing.length ? ` Still waiting for ${missing.join(", ")}.` : "";
      const received = runtime.voiceHandshake?.voiceStateUpdateReceived &&
        runtime.voiceHandshake?.voiceServerEndpointReceived
        ? ` Received voice state for channel ${runtime.voiceHandshake.voiceStateChannelId || "unknown"} and voice endpoint ${runtime.voiceHandshake.voiceServerEndpointHost || "unknown"}.`
        : "";
      const stage = connection.state.networking?.state?.code;
      const networkStage = Number.isInteger(stage) ? voiceNetworkStages[stage] : runtime.voiceNetworkStage;
      const network = networkStage ? ` Voice network stage: ${networkStage}.` : "";
      const closeCode = runtime.voiceNetworkCloseCode === null
        ? ""
        : ` Voice WebSocket close code: ${runtime.voiceNetworkCloseCode}.`;
      const daveFailure = runtime.voiceNetworkCloseCode === 4017
        ? " Discord requires DAVE end-to-end encryption for this voice channel. Confirm Render deployed the DAVE-capable @discordjs/voice version from package-lock.json and is running Node.js 22.12.0 or newer."
        : "";
      const transportFailure = state === VoiceConnectionStatus.Signalling &&
        networkStage === "voice network closed"
        ? ` Discord may list the bot in the channel, but its voice network closed before media became ready.${closeCode}${daveFailure} Audio cannot play until the voice status is Ready. This is a voice transport failure, not a channel-permission failure.`
        : "";
      reject(new Error(
        `${runtime.config.name}: voice connection stayed in ${state} for ${Math.round(voiceReadyTimeoutMs / 1000)} seconds.${detail}${received}${network}${transportFailure}`
      ));
    }, voiceReadyTimeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      connection.removeListener("stateChange", onStateChange);
      watchedNetworking?.removeListener("close", onNetworkClose);
    };

    const onNetworkClose = (code) => {
      runtime.voiceNetworkCloseCode = code;
      runtime.voiceNetworkStage = "voice network closed";
      if (code !== 4017) return;
      cleanup();
      reject(new Error(
        `${runtime.config.name}: Discord closed the voice connection with code 4017 because this channel requires DAVE end-to-end encryption. ` +
        "Ensure Render deployed @discordjs/voice 0.19.2 and is running Node.js 22.12.0 or newer."
      ));
    };

    const onStateChange = (_oldState, newState) => {
      const networking = newState.networking;
      if (networking !== watchedNetworking) {
        watchedNetworking?.removeListener("close", onNetworkClose);
        watchedNetworking = networking || null;
        watchedNetworking?.once("close", onNetworkClose);
      }
      if (newState.status === VoiceConnectionStatus.Ready) {
        cleanup();
        resolve(connection);
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        cleanup();
        const gateway = runtime.gatewayError ? ` Discord gateway: ${runtime.gatewayError}.` : "";
        const network = runtime.voiceNetworkStage ? ` Last voice network stage: ${runtime.voiceNetworkStage}.` : "";
        const reason = runtime.gatewayError
          ? ""
          : " No gateway disconnect was recorded before the voice connection was destroyed.";
        reject(new Error(`${runtime.config.name}: Discord voice connection changed to ${newState.status}.${reason}${gateway}${network}`));
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        cleanup();
        reject(new Error(`${runtime.config.name}: Discord could not start the voice connection (adapter unavailable).`));
      }
    };

    connection.on("stateChange", onStateChange);
    onStateChange(null, connection.state);
  });
}

async function joinBot(runtime) {
  await waitForBotReady(runtime);
  if (!runtime.channelId) throw new Error(`${runtime.config.name}: set the shared voice channel ID first.`);

  const channel = await runtime.client.channels.fetch(runtime.channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error(`${runtime.config.name}: the selected voice channel is no longer available.`);
  }
  const guild = channel.guild;
  const permissions = channel.permissionsFor(runtime.client.user);
  if (!permissions?.has(["ViewChannel", "Connect"])) {
    throw new Error(`${runtime.config.name}: the bot needs View Channel and Connect permissions in the selected channel.`);
  }

  if (runtime.voiceConnection?.joinConfig?.channelId === channel.id) {
    if (runtime.voiceConnection.state.status === VoiceConnectionStatus.Ready) {
      runtime.guildId = guild.id;
      runtime.status = "connected";
      return runtime.voiceConnection;
    }
    if (
      runtime.voiceConnection.state.status === VoiceConnectionStatus.Signalling ||
      runtime.voiceConnection.state.status === VoiceConnectionStatus.Connecting
    ) {
      const pendingConnection = runtime.voiceConnection;
      await waitForVoiceReady(pendingConnection, runtime);
      if (runtime.voiceConnection !== pendingConnection) {
        throw new Error(`${runtime.config.name}: the pending voice connection was cancelled.`);
      }
      runtime.guildId = guild.id;
      runtime.status = "connected";
      runtime.error = null;
      return pendingConnection;
    }
  }

  stopBot(runtime);
  const joinOptions = {
    channelId: channel.id,
    guildId: guild.id,
    group: runtime.config.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: runtime.deafened,
    selfMute: runtime.muted
  };
  runtime.voiceHandshake = {
    voiceStateUpdateReceived: false,
    voiceServerUpdateReceived: false,
    voiceServerEndpointReceived: false,
    voiceServerEndpointHost: null,
    voiceStateChannelId: null,
    voiceStateSessionReceived: false,
    voiceStateUpdateAt: null,
    voiceServerUpdateAt: null
  };
  runtime.guildId = guild.id;
  runtime.voiceNetworkCloseCode = null;
  runtime.voiceNetworkStage = "waiting for Discord gateway voice updates";
  const connection = joinVoiceChannel(joinOptions);
  runtime.voiceConnection = connection;
  runtime.status = "connecting";
  if (connection.state.status === VoiceConnectionStatus.Destroyed) {
    const error = new Error(
      `${runtime.config.name}: Discord rejected the initial voice join because its gateway adapter could not send the request. ` +
      "Check the bot's Discord gateway connection, then click Join VC again."
    );
    runtime.voiceConnection = null;
    runtime.voiceNetworkStage = null;
    runtime.status = runtime.client?.isReady() ? "ready" : "error";
    runtime.error = error.message;
    throw error;
  }
  connection.on("stateChange", (_oldState, newState) => {
    if (runtime.voiceConnection !== connection) return;
    console.info(`${runtime.config.id}: voice connection state is ${newState.status}.`);
    if (newState.networking) {
      const networking = newState.networking;
      const setNetworkStage = (networkState) => {
        if (connection.state.networking !== networking) return;
        runtime.voiceNetworkStage = voiceNetworkStages[networkState.code] || "unknown voice network stage";
        console.info(`${runtime.config.id}: ${runtime.voiceNetworkStage}.`);
      };
      setNetworkStage(networking.state);
      if (!observedVoiceNetworks.has(networking)) {
        observedVoiceNetworks.add(networking);
        runtime.voiceNetworkCloseCode = null;
        networking.on("stateChange", (_oldNetworkState, newNetworkState) => setNetworkStage(newNetworkState));
        networking.on("close", (code) => {
          if (runtime.voiceConnection !== connection || connection.state.networking !== networking) return;
          runtime.voiceNetworkCloseCode = code;
          runtime.voiceNetworkStage = "voice network closed";
          console.error(`${runtime.config.id}: Discord voice WebSocket closed with code ${code}.`);
        });
        networking.on("error", (error) => {
          if (runtime.voiceConnection !== connection) return;
          runtime.error = `${runtime.config.name}: Discord voice network failed: ${error.message}`;
          console.error(`${runtime.config.id}: voice network error:`, error);
        });
      }
    }
    if (newState.status === VoiceConnectionStatus.Ready) {
      runtime.status = "connected";
      runtime.error = null;
    } else if (newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling) {
      runtime.status = "connecting";
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      runtime.status = runtime.client?.isReady() ? "ready" : "error";
      runtime.playing = false;
      runtime.error = `${runtime.config.name}: Discord voice connection was destroyed. ${runtime.gatewayError || "Check the Discord gateway connection."}`;
    } else if (newState.status === VoiceConnectionStatus.Disconnected) {
      runtime.status = "disconnected";
      runtime.playing = false;
      const closeCode = newState.closeCode ? ` Voice WebSocket close code: ${newState.closeCode}.` : "";
      runtime.error = `${runtime.config.name}: Discord disconnected the voice session.${closeCode} Click Join to reconnect.`;
    }
  });
  connection.on("error", (error) => {
    if (runtime.voiceConnection !== connection) return;
    runtime.error = `Voice connection error: ${error.message}`;
    console.error(`${runtime.config.id}: voice connection error:`, error);
  });
  try {
    await waitForVoiceReady(connection, runtime);
    runtime.guildId = guild.id;
    runtime.status = "connected";
    runtime.error = null;
    return connection;
  } catch (error) {
    const stillNegotiating = connection.state.status === VoiceConnectionStatus.Signalling ||
      connection.state.status === VoiceConnectionStatus.Connecting;
    const daveFailure = runtime.voiceNetworkCloseCode === 4017;
    const connectionError = stillNegotiating
      ? new Error(error.message)
      : new Error(`${error.message} Check the bot's server access, channel permissions, and Discord voice connectivity.`);
    if (stillNegotiating && !daveFailure) {
      runtime.status = "connecting";
    } else {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      if (runtime.voiceConnection === connection) {
        runtime.voiceConnection = null;
        runtime.voiceHandshake = null;
        runtime.status = runtime.client?.isReady() ? "ready" : "error";
      }
    }
    if (runtime.voiceConnection === connection) runtime.error = connectionError.message;
    throw connectionError;
  }
}

async function prepareBotPlayback(runtime, audio) {
  if (!audio || !fs.existsSync(audio.filePath)) throw new Error("Upload or select an audio file first.");
  const connection = runtime.voiceConnection;
  if (connection?.state.status !== VoiceConnectionStatus.Ready) {
    const state = connection?.state.status || "not connected";
    throw new Error(
      `${runtime.config.name}: voice media is not ready (state: ${state}). Discord may show the bot in the channel, ` +
      "but audio cannot play until the voice connection reaches Ready. Check the voice-network error and reconnect after resolving it."
    );
  }
  const channel = await runtime.client.channels.fetch(runtime.channelId);
  if (!channel?.permissionsFor(runtime.client.user)?.has("Speak")) {
    throw new Error(`${runtime.config.name}: the bot needs Speak permission in the selected channel to play audio.`);
  }
  const volume = runtime.config.volume ?? config.defaults?.volume ?? 0.5;
  const gain = masterAudioGain;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1 || !Number.isFinite(gain) || gain < 0 || gain > 1000) {
    throw new Error(`${runtime.config.name}: bot volume must be between 0 and 1 and master gain between 0 and 1000×.`);
  }
  await prepareAudioVariants(audio);
  if (masterAudioGain !== gain) {
    throw new Error(`${runtime.config.name}: master gain changed during audio preparation. Click Play audio again.`);
  }
  const opusFilePath = await prepareAudioForPlayback(audio, volume * gain);
  const player = createAudioPlayer();
  const resource = createAudioResource(fs.createReadStream(opusFilePath), {
    inputType: StreamType.OggOpus
  });
  return { runtime, audio, connection, player, resource };
}

function startPreparedPlayback(prepared) {
  const { runtime, audio, connection, player, resource } = prepared;
  if (runtime.voiceConnection !== connection || connection.state.status !== VoiceConnectionStatus.Ready) {
    throw new Error(`${runtime.config.name}: voice connection changed while preparing audio. Rejoin voice and try again.`);
  }
  if (runtime.player) runtime.player.stop(true);
  connection.subscribe(player);
  runtime.player = player;
  runtime.currentAudio = audio;
  runtime.playing = false;
  runtime.status = "connected";
  runtime.error = null;
  player.on(AudioPlayerStatus.Playing, () => {
    if (runtime.player === player) runtime.playing = true;
  });
  player.on(AudioPlayerStatus.Idle, () => {
    if (runtime.player === player) {
      runtime.playing = false;
      runtime.currentAudio = null;
    }
  });
  player.on("error", (error) => {
    runtime.error = `${runtime.config.name}: audio playback failed: ${error.message}`;
    runtime.playing = false;
    console.error(`${runtime.config.id}: audio playback failed:`, error);
  });
  player.play(resource);
}

async function startBot(runtime, audio) {
  const prepared = await prepareBotPlayback(runtime, audio);
  startPreparedPlayback(prepared);
}

function stopBot(runtime) {
  stopPlayback(runtime);
  if (runtime.voiceConnection) {
    if (runtime.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
      runtime.voiceConnection.destroy();
    }
    runtime.voiceConnection = null;
  }
  runtime.playing = false;
  runtime.voiceHandshake = null;
  runtime.voiceNetworkStage = null;
  runtime.status = runtime.client?.isReady() ? "ready" : runtime.status;
  runtime.muted = false;
  runtime.deafened = false;
}

function stopPlayback(runtime) {
  if (runtime.player) {
    runtime.player.stop(true);
    runtime.player = null;
  }
  runtime.playing = false;
  runtime.currentAudio = null;
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
  const { action, audioId } = request.body || {};
  const allowedActions = new Set(["start-all", "stop-all", "disconnect-all", "mute-all", "unmute-all", "deafen-all", "undeafen-all"]);
  if (!allowedActions.has(action)) {
    response.status(400).json({ error: "Choose a valid bot action." });
    return;
  }

  let targets;
  if (action === "start-all") {
    targets = [...bots.values()].filter((bot) => bot.client && process.env[bot.config.tokenEnv]);
    if (!targets.length) {
      response.status(409).json({ error: "No bot tokens are configured. Add the DISCORD_BOT_TOKEN_XX environment variables in Render first." });
      return;
    }
  } else if (action === "stop-all") {
    targets = [...bots.values()].filter((bot) => bot.player);
  } else {
    targets = [...bots.values()].filter((bot) => bot.voiceConnection);
  }

  let audio = null;
  if (action === "start-all") {
    audio = typeof audioId === "string" ? audioFiles.get(audioId) : null;
    if (!audio) {
      response.status(400).json({ error: "Upload or select an audio file before starting." });
      return;
    }
  }

  let results;
  if (action === "start-all") {
    const prepared = await Promise.all(targets.map(async (runtime) => {
      try {
        return { runtime, playback: await prepareBotPlayback(runtime, audio) };
      } catch (error) {
        const message = explainDiscordAccessError(runtime, error);
        runtime.error = message;
        return { runtime, error: message };
      }
    }));
    results = prepared.map(({ runtime, playback, error }) => {
      if (error) return { id: runtime.config.id, ok: false, error, bot: botSummary(runtime) };
      try {
        startPreparedPlayback(playback);
        return { id: runtime.config.id, ok: true, bot: botSummary(runtime) };
      } catch (startError) {
        const message = explainDiscordAccessError(runtime, startError);
        runtime.error = message;
        return { id: runtime.config.id, ok: false, error: message, bot: botSummary(runtime) };
      }
    });
  } else {
    results = await Promise.all(targets.map(async (runtime) => {
      try {
        if (action === "stop-all") stopPlayback(runtime);
        if (action === "disconnect-all") stopBot(runtime);
        if (action === "mute-all") setVoiceFlags(runtime, { muted: true });
        if (action === "unmute-all") setVoiceFlags(runtime, { muted: false });
        if (action === "deafen-all") setVoiceFlags(runtime, { deafened: true });
        if (action === "undeafen-all") setVoiceFlags(runtime, { deafened: false });
        return { id: runtime.config.id, ok: true, bot: botSummary(runtime) };
      } catch (error) {
        const message = explainDiscordAccessError(runtime, error);
        runtime.error = message;
        return { id: runtime.config.id, ok: false, error: message, bot: botSummary(runtime) };
      }
    }));
  }
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
  console.log("Audio playback uses cached Ogg Opus streams.");
  if (!process.env.DASHBOARD_PASSWORD) {
    console.error("DASHBOARD_PASSWORD is missing; dashboard control remains locked until it is set.");
  }
});

function connectDiscordBot(runtime) {
  const token = process.env[runtime.config.tokenEnv];
  if (!token) return;
  const tokenFingerprint = crypto.createHash("sha256").update(token).digest("hex");
  const existingOwner = tokenOwners.get(tokenFingerprint);
  if (existingOwner) {
    runtime.status = "error";
    runtime.error = `${runtime.config.name}: this token is also configured for ${existingOwner}. Each bot slot needs a different Discord bot token.`;
    console.error(`${runtime.config.id}: duplicate token configuration detected; not logging this slot in.`);
    return;
  }
  tokenOwners.set(tokenFingerprint, runtime.config.name);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
  });
  runtime.client = client;
  clients.push(client);
  client.on("voiceStateUpdate", (_oldState, newState) => {
    if (newState.id !== client.user?.id || newState.guild.id !== runtime.guildId) return;
    runtime.voiceHandshake = {
      ...runtime.voiceHandshake,
      voiceStateUpdateReceived: true,
      voiceStateChannelId: newState.channelId,
      voiceStateSessionReceived: Boolean(newState.sessionId),
      voiceStateUpdateAt: new Date().toISOString()
    };
  });
  client.on("voiceServerUpdate", (update) => {
    if (update.guildId !== runtime.guildId) return;
    runtime.voiceHandshake = {
      ...runtime.voiceHandshake,
      voiceServerUpdateReceived: true,
      voiceServerEndpointReceived: Boolean(update.endpoint),
      voiceServerEndpointHost: update.endpoint || null,
      voiceServerUpdateAt: new Date().toISOString()
    };
  });
  client.once("ready", () => {
    runtime.gatewayState = "ready";
    runtime.gatewayError = null;
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
  client.on("shardDisconnect", (closeEvent, shardId) => {
    const closeDetail = closeEvent.reason
      ? `gateway shard ${shardId} disconnected (WebSocket close ${closeEvent.code}: ${closeEvent.reason})`
      : `gateway shard ${shardId} disconnected (WebSocket close ${closeEvent.code})`;
    runtime.gatewayState = "disconnected";
    runtime.gatewayError = closeDetail;
    if (runtime.voiceConnection) {
      runtime.status = "error";
      runtime.error = `${runtime.config.name}: ${closeDetail}; Discord destroyed the voice adapter.`;
    }
    console.error(`${runtime.config.id}: ${closeDetail}.`);
  });
  client.on("shardReconnecting", (shardId) => {
    runtime.gatewayState = "reconnecting";
    console.warn(`${runtime.config.id}: Discord gateway shard ${shardId} is reconnecting.`);
  });
  client.on("shardReady", (shardId) => {
    runtime.gatewayState = "ready";
    runtime.gatewayError = null;
    if (runtime.client?.isReady() && !runtime.voiceConnection) runtime.status = "ready";
    console.info(`${runtime.config.id}: Discord gateway shard ${shardId} is ready.`);
  });
  client.on("shardError", (error, shardId) => {
    runtime.gatewayError = `gateway shard ${shardId} error: ${error.message}`;
    runtime.error = `${runtime.config.name}: ${runtime.gatewayError}`;
    console.error(`${runtime.config.id}: ${runtime.gatewayError}`);
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
