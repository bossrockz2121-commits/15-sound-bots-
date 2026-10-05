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
  joinVoiceChannel,
  VoiceConnectionStatus
} = require("@discordjs/voice");
const { createPlayback } = require("./lib/playback");

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

const MAX_SOUND_BYTES = Math.max(1, Number(process.env.MAX_SOUND_MB) || 25) * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".mp2", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac",
  ".flac", ".webm", ".mp4", ".mkv", ".aif", ".aiff", ".wma", ".mov"
]);
const PAGE_PATH = path.join(projectRoot, "public", "index.html");
const clients = [];
const bots = new Map();

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
    status: "disabled",
    channelName: null,
    error: null,
    client: null,
    connection: null,
    playback: null,
    uploadSequence: 0
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
    enabled: entry.enabled,
    status: entry.status,
    channelName: entry.channelName,
    soundFile: entry.soundFile,
    soundBytes,
    soundUpdatedAt,
    sounds: listSounds(entry),
    volume: entry.volume,
    loop: entry.loop,
    playing: entry.playback ? entry.playback.isPlaying() : false,
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
  if (!bot.guildId || !bot.voiceChannelId) {
    throw new Error(`${bot.id}: set guildId and voiceChannelId in bots.config.json.`);
  }
  if (!Number.isFinite(entry.volume) || entry.volume < 0 || entry.volume > 1) {
    throw new Error(`${bot.id}: volume must be a number between 0 and 1; received ${entry.volume}.`);
  }
}

async function joinAndPlay(entry) {
  const { bot } = entry;
  const client = entry.client;

  let guild;
  try {
    guild = await client.guilds.fetch(bot.guildId);
  } catch (error) {
    if (error.code === 50001 || error.code === 10004) {
      throw new Error(
        `${bot.id}: this bot cannot access server ${bot.guildId}. ` +
        "Invite this bot to that server and verify the configured guildId."
      );
    }
    throw error;
  }

  let channel;
  try {
    channel = await guild.channels.fetch(bot.voiceChannelId);
  } catch (error) {
    if (error.code === 50001 || error.code === 10003) {
      throw new Error(
        `${bot.id}: cannot access voice channel ${bot.voiceChannelId}. ` +
        "Invite this bot to the server and grant View Channel, Connect, and Speak " +
        "on the channel or its category."
      );
    }
    throw error;
  }

  if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
    throw new Error(`Configured channel ${bot.voiceChannelId} is not a voice or stage channel.`);
  }

  const permissions = channel.permissionsFor(client.user);
  const requiredPermissions = ["ViewChannel", "Connect", "Speak"];
  const missingPermissions = permissions
    ? requiredPermissions.filter((permission) => !permissions.has(permission))
    : requiredPermissions;
  if (missingPermissions.length > 0) {
    throw new Error(
      `${bot.id}: missing ${missingPermissions.join(", ")} permission(s) for ` +
      `${channel.name} (${channel.id}). Grant them to this bot on the channel or category.`
    );
  }

  entry.channelName = channel.name;
  entry.playback = createPlayback(entry);

  let reconnecting = false;

  const connect = async () => {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true
    });

    entry.connection = connection;
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (entry.connection !== connection) return;
      entry.status = "reconnecting";
      console.error(`${bot.id}: voice connection dropped; attempting to reconnect.`);
      recover(connection);
    });
    connection.on("error", (error) => {
      console.error(`${bot.id}: voice connection error:`, error);
    });

    entry.playback.attach(connection);
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    entry.status = "connected";
    return connection;
  };

  const recover = (lostConnection) => {
    if (reconnecting) return;
    reconnecting = true;

    void (async () => {
      try {
        try {
          await entersState(lostConnection, VoiceConnectionStatus.Ready, 15_000);
        } catch (error) {
          console.error(
            `${bot.id}: existing voice connection did not recover; retrying with a new connection:`,
            error
          );
          if (entry.connection === lostConnection) {
            lostConnection.destroy();
            entry.connection = null;
          }

          while (entry.client?.isReady()) {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            try {
              await connect();
              entry.playback.resume();
              console.log(`${bot.id} reconnected to ${channel.name}.`);
              return;
            } catch (reconnectError) {
              if (entry.connection) {
                entry.connection.destroy();
                entry.connection = null;
              }
              console.error(`${bot.id}: reconnect attempt failed:`, reconnectError);
            }
          }
          return;
        }

        if (entry.client?.isReady() && entry.connection === lostConnection) {
          entry.status = "connected";
          entry.playback.attach(lostConnection);
          entry.playback.resume();
        }
      } finally {
        reconnecting = false;
      }
    })();
  };

  await connect();

  if (fs.existsSync(entry.soundPath)) {
    entry.playback.play();
  } else {
    entry.error = `Add an audio file for this bot from the web page (${entry.soundFile}).`;
    console.warn(`${bot.id}: ${entry.error}`);
  }

  console.log(`${bot.id} (${client.user.tag}) connected to ${channel.name}.`);
}

async function startBot(entry) {
  const { bot } = entry;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  entry.client = client;
  clients.push(client);
  entry.status = "starting";

  client.once("ready", () => {
    void joinAndPlay(entry).catch((error) => {
      entry.status = "error";
      entry.error = error.message;
      console.error(`${bot.id} failed to join/play:`, error);
      if (entry.connection) {
        try {
          entry.connection.destroy();
        } catch (destroyError) {
          console.error(`${bot.id}: could not destroy the voice connection:`, destroyError);
        }
        entry.connection = null;
      }
      entry.playback?.stop();
    });
  });

  client.on("error", (error) => {
    entry.status = "error";
    entry.error = error.message;
    console.error(`${bot.id}: Discord client error:`, error);
  });

  await client.login(process.env[bot.tokenEnv]);
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
      enabledBots: [...bots.values()].filter((entry) => entry.enabled).length,
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
  const server = startHealthServer();
  const enabled = [...bots.values()].filter((entry) => entry.enabled);

  if (enabled.length === 0) {
    console.warn(
      "No bots are enabled. Set enabled: true for each bot you want to start; " +
      "the web page stays available so you can add audio files."
    );
    return;
  }

  try {
    for (const entry of enabled) validateEnvironment(entry);
  } catch (error) {
    console.error("Could not start configured bots:", error);
    server.close(() => process.exit(1));
    return;
  }

  await Promise.allSettled(
    enabled.map((entry) =>
      startBot(entry).catch((error) => {
        entry.status = "error";
        entry.error = error.message;
        console.error(`${entry.bot.id} could not start:`, error);
      })
    )
  );
}

main().catch((error) => {
  console.error("Application startup failed:", error);
  process.exitCode = 1;
});
