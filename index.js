const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const dotenv = require("dotenv");
const { Client, GatewayIntentBits, ChannelType } = require("discord.js");
const {
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");
const { createPlayback } = require("./lib/playback");
const { destroyVoiceConnection, joinBotVoiceChannel } = require("./lib/voice-connection");
const { attachVoiceRecovery } = require("./lib/voice-recovery");

dotenv.config();

const projectRoot = __dirname;
const configPath = path.join(projectRoot, "bots.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!Array.isArray(config.bots) || config.bots.length !== 15) {
  throw new Error("bots.config.json must contain exactly 15 bot entries.");
}

const ffmpegPath = require("ffmpeg-static");
if (ffmpegPath) {
  process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH || ""}`;
}

const MAX_SOUND_MB = Math.min(90, Math.max(1, Number(process.env.MAX_SOUND_MB) || 90));
const MAX_SOUND_BYTES = MAX_SOUND_MB * 1024 * 1024;
const MAX_PLAYBACK_GAIN = 3;
const fleetAudioDirectory = path.resolve(process.env.AUDIO_UPLOAD_DIR || path.join(projectRoot, "sounds", "fleet"));
const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".mp2", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac",
  ".flac", ".webm", ".mp4", ".mkv", ".aif", ".aiff", ".wma", ".mov"
]);
const PAGE_PATH = path.join(projectRoot, "public", "index.html");
const clients = [];
const bots = new Map();
let fleetChannelId = "";
let fleetGain = 1;
let selectedFleetAudio = null;
let fleetUploadSequence = 0;

class UploadTooLargeError extends Error {}

/** Keeps the paths shown in the web page in the same style as bots.config.json. */
const toRelativePath = (value) => value.split(path.sep).join("/");

function safeProjectPath(relativePath) {
  const resolved = path.resolve(projectRoot, relativePath);
  if (resolved === projectRoot || !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}

/**
 * Resolves where a bot's sound lives. When the configured file is missing, a file
 * with the same base name but another audio extension is used, so an uploaded wav,
 * ogg or mp3 keeps working after a restart without rewriting bots.config.json.
 */
function resolveSoundFile(configuredPath) {
  const exact = safeProjectPath(configuredPath);
  if (!exact) return { relative: configuredPath, absolute: null };
  if (fs.existsSync(exact)) return { relative: configuredPath, absolute: exact };

  const extension = path.extname(configuredPath);
  const base = extension ? configuredPath.slice(0, configuredPath.length - extension.length) : configuredPath;
  const prefix = `${path.basename(base)}.`;

  try {
    const directory = path.dirname(base);
    const match = fs
      .readdirSync(path.resolve(projectRoot, directory))
      .filter((name) => name.startsWith(prefix) && AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort()[0];

    if (match) {
      const relative = toRelativePath(path.join(directory, match));
      const absolute = safeProjectPath(relative);
      if (absolute) return { relative, absolute };
    }
  } catch {
    // The folder has not been created yet.
  }

  return { relative: configuredPath, absolute: exact };
}

for (const bot of config.bots) {
  const configuredSound = typeof bot.soundFile === "string" ? bot.soundFile.trim() : "";
  const fallbackSound = `sounds/${bot.id}.mp3`;
  const wantedSound = configuredSound && safeProjectPath(configuredSound) ? configuredSound : fallbackSound;
  const sound = resolveSoundFile(wantedSound);

  const entry = {
    bot,
    enabled: Boolean(bot.enabled ?? config.defaults?.enabled),
    soundFile: sound.relative,
    soundPath: sound.absolute,
    defaultSoundFile: sound.relative,
    defaultSoundPath: sound.absolute,
    libraryPath: path.join(projectRoot, "sounds", bot.id),
    volume: bot.volume ?? config.defaults?.volume ?? 1,
    loop: Boolean(bot.loop ?? config.defaults?.loop ?? false),
    status: process.env[bot.tokenEnv] ? "starting" : "disabled",
    channelName: null,
    error: null,
    client: null,
    connection: null,
    playback: null,
    uploadSequence: 0,
    joining: false,
    guildId: null,
    muted: false,
    deafened: false,
    recoveryPromise: null
  };

  if (!entry.enabled) entry.status = "disabled";
  bots.set(bot.id, entry);
}

function describeBot(entry) {
  let soundBytes = 0;
  let soundUpdatedAt = null;

  try {
    const stats = fs.statSync(entry.soundPath);
    soundBytes = stats.size;
    soundUpdatedAt = stats.mtimeMs;
  } catch {
    // The sound has not been added yet.
  }

  return {
    id: entry.bot.id,
    name: entry.bot.name || entry.bot.id,
    enabled: Boolean(entry.client && entry.client.isReady()),
    status: entry.status,
    channelName: entry.channelName,
    soundFile: entry.soundFile,
    soundBytes,
    soundUpdatedAt,
    sounds: listSounds(entry),
    volume: entry.volume,
    loop: entry.loop,
    playing: entry.playback ? entry.playback.isPlaying() : false,
    muted: entry.muted,
    deafened: entry.deafened,
    error: entry.error
  };
}

function listSounds(entry) {
  const sounds = new Map();
  const addSound = (file, absolute) => {
    if (!absolute || !fs.existsSync(absolute)) return;
    const stats = fs.statSync(absolute);
    if (!stats.isFile()) return;
    sounds.set(file, { file, name: path.basename(file), bytes: stats.size });
  };

  addSound(entry.defaultSoundFile, entry.defaultSoundPath);
  if (fs.existsSync(entry.libraryPath)) {
    for (const name of fs.readdirSync(entry.libraryPath)) {
      if (!AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const file = toRelativePath(path.join("sounds", entry.bot.id, name));
      addSound(file, path.join(entry.libraryPath, name));
    }
  }
  return [...sounds.values()];
}

function validateEnvironment(entry) {
  const { bot } = entry;
  if (!bot.tokenEnv || !process.env[bot.tokenEnv]) {
    throw new Error(`${bot.id}: missing token in environment variable ${bot.tokenEnv || "(unset)"}.`);
  }
  if (!Number.isFinite(entry.volume) || entry.volume < 0 || entry.volume > MAX_PLAYBACK_GAIN) {
    throw new Error(`${bot.id}: volume must be between 0 and ${MAX_PLAYBACK_GAIN}; received ${entry.volume}.`);
  }
}

async function joinBot(entry, channelId) {
  const client = entry.client;
  if (!client?.isReady()) {
    throw new Error(`${entry.bot.id}: Discord bot is not online or its token is missing.`);
  }
  if (entry.joining) throw new Error(`${entry.bot.id}: a voice-channel connection is already being established.`);
  const channel = await client.channels.fetch(channelId);
  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
    throw new Error(`${entry.bot.id}: channel ${channelId} is not an accessible voice channel.`);
  }

  const permissions = channel.permissionsFor(client.user);
  const requiredPermissions = ["ViewChannel", "Connect", "Speak"];
  const missingPermissions = permissions
    ? requiredPermissions.filter((permission) => !permissions.has(permission))
    : requiredPermissions;
  if (missingPermissions.length > 0) {
    throw new Error(
      `${entry.bot.id}: missing ${missingPermissions.join(", ")} permission(s) for ` +
      `${channel.name} (${channel.id}). Grant them to this bot on the channel or category.`
    );
  }

  if (entry.connection && entry.connection.joinConfig.channelId === channel.id &&
      entry.connection.state.status === VoiceConnectionStatus.Ready) {
    entry.status = "connected";
    return;
  }

  entry.playback?.stop();
  if (entry.connection) {
    const previousConnection = entry.connection;
    entry.connection = null;
    destroyVoiceConnection(previousConnection);
  }
  entry.playback = createPlayback(entry);
  const connection = joinBotVoiceChannel(entry.bot.id, channel);
  entry.connection = connection;
  entry.joining = true;
  entry.status = "starting";
  entry.channelName = channel.name;
  entry.guildId = channel.guild.id;
  entry.error = null;
  connection.on("error", (error) => {
    if (entry.connection !== connection) return;
    entry.error = error.message;
    console.error(`${entry.bot.id}: voice connection error:`, error);
  });
  attachVoiceRecovery(entry, connection);
  entry.playback.attach(connection);
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 45_000);
    entry.status = "connected";
    entry.error = null;
    console.log(`${entry.bot.id} (${client.user.tag}) connected to ${channel.name}.`);
  } catch (error) {
    if (entry.connection === connection) {
      entry.playback.stop();
      entry.connection = null;
      destroyVoiceConnection(connection);
      entry.channelName = null;
      entry.guildId = null;
      entry.status = client.isReady() ? "ready" : "disabled";
    }
    throw error;
  } finally {
    entry.joining = false;
  }
}

async function startBot(entry) {
  const { bot } = entry;
  validateEnvironment(entry);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  entry.client = client;
  clients.push(client);
  entry.status = "starting";
  client.once("ready", () => {
    if (!entry.connection) entry.status = "ready";
    entry.error = null;
  });

  client.on("error", (error) => {
    entry.status = "error";
    entry.error = error.message;
    console.error(`${bot.id}: Discord client error:`, error);
  });

  await client.login(process.env[bot.tokenEnv]);
}

function listFleetAudio() {
  if (!fs.existsSync(fleetAudioDirectory)) return [];
  return fs.readdirSync(fleetAudioDirectory)
    .filter((name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => {
      const absolute = path.join(fleetAudioDirectory, name);
      const stats = fs.statSync(absolute);
      return stats.isFile()
        ? { file: toRelativePath(path.join("sounds", "fleet", name)), name, bytes: stats.size }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function selectFleetAudio(audio) {
  selectedFleetAudio = audio;
  for (const entry of bots.values()) {
    entry.soundFile = audio.file;
    entry.soundPath = audio.absolute;
    entry.error = null;
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }).end(body);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" }).end(message);
}

/** Saves each uploaded audio file in the bot's library without replacing other sounds. */
function soundTargetFor(entry, uploadedName) {
  const uploadedExtension = path.extname(uploadedName).toLowerCase();
  const extension = uploadedExtension || path.extname(entry.defaultSoundFile).toLowerCase() || ".mp3";
  if (!AUDIO_EXTENSIONS.has(extension)) {
    const error = new Error(
      `Unsupported audio type "${extension}". Use one of: ${[...AUDIO_EXTENSIONS].join(", ")}.`
    );
    error.statusCode = 415;
    throw error;
  }

  const safeName = path.basename(uploadedName)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  const baseName = safeName ? path.basename(safeName, path.extname(safeName)) : "audio";
  const name = `${baseName || "audio"}${extension}`;
  const relative = toRelativePath(path.join("sounds", entry.bot.id, name));
  const absolute = path.join(entry.libraryPath, name);
  return { relative, absolute };
}

async function replaceFile(tempPath, targetPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(tempPath, targetPath);
      return;
    } catch (error) {
      // On Windows an ffmpeg process may still hold the old file for a moment.
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
}

async function handleSoundUpload(entry, request, response, url) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOUND_BYTES) {
    request.resume();
    sendJson(response, 413, {
      error: `Audio file is larger than ${Math.round(MAX_SOUND_BYTES / (1024 * 1024))} MB.`
    });
    return;
  }

  const uploadedName = (url.searchParams.get("name") || "").trim();
  const target = soundTargetFor(entry, uploadedName);

  const sequence = ++entry.uploadSequence;
  const tempPath = path.join(
    path.dirname(target.absolute),
    `.${path.basename(target.absolute)}.${process.pid}.${sequence}.part`
  );

  await fsp.mkdir(path.dirname(target.absolute), { recursive: true });

  let written = 0;
  try {
    await pipeline(
      request,
      new Transform({
        transform(chunk, encoding, callback) {
          written += chunk.length;
          if (written > MAX_SOUND_BYTES) {
            callback(new UploadTooLargeError());
            return;
          }
          callback(null, chunk);
        }
      }),
      fs.createWriteStream(tempPath)
    );
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    if (error instanceof UploadTooLargeError) {
      sendJson(response, 413, {
        error: `Audio file is larger than ${Math.round(MAX_SOUND_BYTES / (1024 * 1024))} MB.`
      });
      return;
    }
    sendJson(response, 400, { error: `Upload failed: ${error.message}` });
    return;
  }

  if (written === 0) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    sendJson(response, 400, { error: "The uploaded file was empty." });
    return;
  }

  try {
    if (entry.soundPath === target.absolute) entry.playback?.stop();
    await replaceFile(tempPath, target.absolute);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    entry.error = `Could not save the audio file: ${error.message}`;
    sendJson(response, 500, { error: entry.error });
    return;
  }

  let played = false;
  if (url.searchParams.get("activate") !== "false") {
    entry.soundFile = target.relative;
    entry.soundPath = target.absolute;
    entry.error = null;
    if (entry.connection && entry.playback && entry.status === "connected") {
      entry.playback.stop();
      played = entry.playback.play();
    }
  }

  console.log(
    `${entry.bot.id}: saved ${target.relative} (${written} bytes)` +
    (played ? "; playing now." : ".")
  );
  sendJson(response, 200, { ok: true, played, file: target.relative, bot: describeBot(entry) });
}

async function handleFleetUpload(request, response, url) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOUND_BYTES) {
    request.resume();
    sendJson(response, 413, { error: `Audio file is larger than ${MAX_SOUND_MB} MB.` });
    return;
  }

  const uploadedName = (url.searchParams.get("name") || "").trim();
  const extension = path.extname(uploadedName).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    sendJson(response, 415, {
      error: `Unsupported audio type "${extension || "(missing)"}". Use an accepted audio format.`
    });
    request.resume();
    return;
  }

  const safeName = path.basename(uploadedName)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  const baseName = path.basename(safeName, path.extname(safeName)) || "audio";
  const name = `${baseName}${extension}`;
  const target = path.join(fleetAudioDirectory, name);
  const tempPath = path.join(fleetAudioDirectory, `.${name}.${process.pid}.${++fleetUploadSequence}.part`);
  await fsp.mkdir(fleetAudioDirectory, { recursive: true });

  let written = 0;
  try {
    await pipeline(
      request,
      new Transform({
        transform(chunk, encoding, callback) {
          written += chunk.length;
          if (written > MAX_SOUND_BYTES) {
            callback(new UploadTooLargeError());
            return;
          }
          callback(null, chunk);
        }
      }),
      fs.createWriteStream(tempPath)
    );
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    if (error instanceof UploadTooLargeError) {
      sendJson(response, 413, { error: `Audio file is larger than ${MAX_SOUND_MB} MB.` });
      return;
    }
    sendJson(response, 400, { error: `Upload failed: ${error.message}` });
    return;
  }

  if (written === 0) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    sendJson(response, 400, { error: "The uploaded file was empty." });
    return;
  }

  try {
    if (selectedFleetAudio?.absolute === target) {
      for (const entry of bots.values()) {
        if (entry.playback?.isPlaying() && entry.soundPath === target) entry.playback.stop();
      }
    }
    await replaceFile(tempPath, target);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    sendJson(response, 500, { error: `Could not save the audio file: ${error.message}` });
    return;
  }

  selectFleetAudio({
    file: toRelativePath(path.join("sounds", "fleet", name)),
    name,
    absolute: target,
    bytes: written
  });
  sendJson(response, 200, {
    ok: true,
    audio: selectedFleetAudio,
    sounds: listFleetAudio(),
    message: `${name} added. Press Play to broadcast it to connected bots.`
  });
}

function fleetSnapshot() {
  return {
    channelId: fleetChannelId,
    gain: fleetGain,
    maxUploadMb: MAX_SOUND_MB,
    maxGain: MAX_PLAYBACK_GAIN,
    selectedAudio: selectedFleetAudio
      ? { file: selectedFleetAudio.file, name: selectedFleetAudio.name, bytes: selectedFleetAudio.bytes }
      : null,
    sounds: listFleetAudio(),
    bots: [...bots.values()].map(describeBot)
  };
}

async function joinFleet(channelId) {
  if (!/^\d{5,25}$/.test(channelId)) {
    return { ok: false, error: "Enter a valid Discord voice channel ID." };
  }
  fleetChannelId = channelId;
  const results = await Promise.all([...bots.values()].map(async (entry) => {
    try {
      await joinBot(entry, channelId);
      return { id: entry.bot.id, ok: true };
    } catch (error) {
      entry.error = error.message;
      entry.status = entry.connection?.state.status === VoiceConnectionStatus.Ready
        ? "connected"
        : entry.client?.isReady() ? "ready" : "disabled";
      console.error(`${entry.bot.id} could not join ${channelId}:`, error.message);
      return { id: entry.bot.id, ok: false, error: error.message };
    }
  }));
  const joined = results.filter((result) => result.ok).length;
  return {
    ok: joined > 0,
    results,
    error: joined ? null : "No bots joined. Check that tokens are configured and each bot can access the selected channel."
  };
}

function disconnectFleet() {
  for (const entry of bots.values()) {
    entry.playback?.stop();
    if (entry.connection) {
      const connection = entry.connection;
      entry.connection = null;
      destroyVoiceConnection(connection);
    }
    entry.channelName = null;
    entry.guildId = null;
    entry.joining = false;
    entry.status = entry.client?.isReady() ? "ready" : "disabled";
    entry.error = null;
  }
  return { ok: true };
}

function playFleet() {
  if (!selectedFleetAudio || !fs.existsSync(selectedFleetAudio.absolute)) {
    return { ok: false, error: "Upload an audio file before pressing Play." };
  }
  const results = [];
  for (const entry of bots.values()) {
    if (!entry.connection || entry.status !== "connected" || !entry.playback) {
      results.push({ id: entry.bot.id, ok: false, error: "Bot is not connected to voice." });
      continue;
    }
    entry.soundFile = selectedFleetAudio.file;
    entry.soundPath = selectedFleetAudio.absolute;
    entry.volume = fleetGain;
    const ok = entry.playback.play();
    results.push({ id: entry.bot.id, ok, error: ok ? null : entry.error || "Could not start playback." });
  }
  const playing = results.filter((result) => result.ok).length;
  return {
    ok: playing > 0,
    results,
    error: playing ? null : "No connected bots could start playback."
  };
}

function stopFleet() {
  for (const entry of bots.values()) entry.playback?.stop();
  return { ok: true };
}

async function setFleetVoiceState(field, value) {
  const results = await Promise.all([...bots.values()].map(async (entry) => {
    if (!entry.connection || entry.status !== "connected" || !entry.guildId) {
      return { id: entry.bot.id, ok: false, error: "Bot is not connected to voice." };
    }
    try {
      const guild = entry.client.guilds.cache.get(entry.guildId);
      const member = guild?.members.me || await guild?.members.fetch(entry.client.user.id);
      if (!member) throw new Error("Could not find this bot in the voice channel's server.");
      if (field === "muted") await member.voice.setMute(value, "Sound Bots fleet control");
      else await member.voice.setDeaf(value, "Sound Bots fleet control");
      entry[field] = value;
      return { id: entry.bot.id, ok: true };
    } catch (error) {
      const permission = error.code === 50013
        ? `Grant this bot the ${field === "muted" ? "Mute Members" : "Deafen Members"} permission.`
        : error.message;
      entry.error = permission;
      return { id: entry.bot.id, ok: false, error: permission };
    }
  }));
  const succeeded = results.filter((result) => result.ok).length;
  return {
    ok: succeeded > 0,
    results,
    error: succeeded
      ? null
      : `No bots could be ${value ? field === "muted" ? "muted" : "deafened" : field === "muted" ? "unmuted" : "undeafened"}.`
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;

  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    try {
      const page = await fsp.readFile(PAGE_PATH, "utf8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }).end(page);
    } catch (error) {
      sendText(response, 500, `Could not read the web page: ${error.message}`);
    }
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      configuredBots: bots.size,
      enabledBots: [...bots.values()].filter((entry) => entry.client?.isReady()).length,
      bots: Object.fromEntries([...bots].map(([id, entry]) => [id, entry.status]))
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/bots") {
    sendJson(response, 200, {
      uploadLimitBytes: MAX_SOUND_BYTES,
      maxUploadMb: Math.round(MAX_SOUND_BYTES / (1024 * 1024)),
      bots: [...bots.values()].map(describeBot)
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/state") {
    sendJson(response, 200, fleetSnapshot());
    return;
  }

  if (pathname === "/api/audio" && request.method === "POST") {
    await handleFleetUpload(request, response, url);
    return;
  }

  if (pathname === "/api/audio/select" && request.method === "POST") {
    const selected = listFleetAudio().find((sound) => sound.file === url.searchParams.get("file"));
    if (!selected) {
      sendJson(response, 404, { error: "That audio file is not in the shared library." });
      return;
    }
    selectFleetAudio({
      ...selected,
      absolute: path.join(fleetAudioDirectory, selected.name)
    });
    sendJson(response, 200, { ok: true, state: fleetSnapshot() });
    return;
  }

  if (pathname.startsWith("/api/fleet/")) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST for fleet controls." });
      return;
    }
    const action = pathname.slice("/api/fleet/".length);
    if (action === "join") {
      const result = await joinFleet(url.searchParams.get("channelId") || "");
      sendJson(response, result.ok ? 200 : 409, { ...result, state: fleetSnapshot() });
      return;
    }
    if (action === "disconnect") {
      sendJson(response, 200, { ...disconnectFleet(), state: fleetSnapshot() });
      return;
    }
    if (action === "play") {
      const result = playFleet();
      sendJson(response, result.ok ? 200 : 409, { ...result, state: fleetSnapshot() });
      return;
    }
    if (action === "stop") {
      sendJson(response, 200, { ...stopFleet(), state: fleetSnapshot() });
      return;
    }
    if (["mute", "unmute", "deafen", "undeafen"].includes(action)) {
      const field = action === "mute" || action === "unmute" ? "muted" : "deafened";
      const value = action === "mute" || action === "deafen";
      const result = await setFleetVoiceState(field, value);
      sendJson(response, result.ok ? 200 : 409, { ...result, state: fleetSnapshot() });
      return;
    }
    if (action === "gain") {
      const value = Number(url.searchParams.get("value"));
      if (!Number.isFinite(value) || value < 0 || value > MAX_PLAYBACK_GAIN) {
        sendJson(response, 400, { error: `Gain must be between 0× and ${MAX_PLAYBACK_GAIN}×.` });
        return;
      }
      fleetGain = value;
      for (const entry of bots.values()) {
        entry.volume = value;
        entry.playback?.setVolume(value);
      }
      sendJson(response, 200, { ok: true, gain: fleetGain, state: fleetSnapshot() });
      return;
    }
    sendJson(response, 404, { error: "Unknown fleet control." });
    return;
  }

  const match = /^\/api\/bots\/([^/]+)\/(sound|select|play|stop)$/.exec(pathname);
  if (match) {
    const entry = bots.get(decodeURIComponent(match[1]));
    if (!entry) {
      sendJson(response, 404, { error: "Unknown bot." });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST for this endpoint." });
      return;
    }

    if (match[2] === "sound") {
      await handleSoundUpload(entry, request, response, url);
      return;
    }

    if (match[2] === "select") {
      const selectedFile = url.searchParams.get("file");
      const selected = listSounds(entry).find((sound) => sound.file === selectedFile);
      if (!selected) {
        sendJson(response, 404, { error: "That audio file is not in this bot's library." });
        return;
      }

      const absolute = safeProjectPath(selected.file);
      if (!absolute || !fs.existsSync(absolute)) {
        sendJson(response, 404, { error: "That audio file is no longer available." });
        return;
      }
      entry.playback?.stop();
      entry.soundFile = selected.file;
      entry.soundPath = absolute;
      entry.error = null;
      const played = Boolean(entry.connection && entry.playback && entry.status === "connected" && entry.playback.play());
      sendJson(response, 200, { ok: true, played, bot: describeBot(entry) });
      return;
    }

    if (match[2] === "play") {
      const started = entry.playback ? entry.playback.play() : false;
      sendJson(response, started ? 200 : 409, {
        ok: started,
        error: started ? null : (entry.error || "This bot is not connected, so it cannot play yet."),
        bot: describeBot(entry)
      });
      return;
    }

    entry.playback?.stop();
    sendJson(response, 200, { ok: true, bot: describeBot(entry) });
    return;
  }

  sendText(response, 404, "Not found");
}

function startHealthServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("Web request failed:", error);
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, { error: error.message || "Unexpected server error." });
      } else {
        response.end();
      }
    });
  });

  server.on("error", (error) => {
    console.error("Health server failed:", error);
    process.exitCode = 1;
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Web page and health server listening on port ${port}. Add sounds at http://localhost:${port}/`);
  });

  return server;
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  for (const entry of bots.values()) entry.playback?.stop();
  await Promise.allSettled(clients.map((client) => client.destroy()));
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  const firstAudio = listFleetAudio()[0];
  if (firstAudio) {
    selectedFleetAudio = {
      ...firstAudio,
      absolute: path.join(fleetAudioDirectory, firstAudio.name)
    };
  }
  const server = startHealthServer();
  const configured = [...bots.values()].filter((entry) => entry.bot.tokenEnv && process.env[entry.bot.tokenEnv]);
  if (configured.length === 0) {
    console.warn("No bot tokens are configured. Add Discord tokens to .env to use fleet controls.");
    return;
  }

  await Promise.all(configured.map(async (entry) => {
    try {
      await startBot(entry);
    } catch (error) {
      entry.status = "error";
      entry.error = error.message;
      console.error(`${entry.bot.id} could not log in:`, error);
    }
  }));
}

main().catch((error) => {
  console.error("Application startup failed:", error);
  process.exitCode = 1;
});
