const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const dotenv = require("dotenv");
const { Client, GatewayIntentBits, ChannelType } = require("discord.js");
const {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus
} = require("@discordjs/voice");

dotenv.config();

const configPath = path.join(__dirname, "bots.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!Array.isArray(config.bots) || config.bots.length !== 15) {
  throw new Error("bots.config.json must contain exactly 15 bot entries.");
}

const ffmpegPath = require("ffmpeg-static");
if (ffmpegPath) {
  process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH || ""}`;
}

const enabledBots = config.bots.filter((bot) => bot.enabled ?? config.defaults?.enabled);
const botStatuses = new Map(enabledBots.map((bot) => [bot.id, "starting"]));
const clients = [];

function startHealthServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((request, response) => {
    if (request.url !== "/" && request.url !== "/health") {
      response.writeHead(404).end("Not found");
      return;
    }

    const body = JSON.stringify({
      status: "ok",
      configuredBots: config.bots.length,
      enabledBots: enabledBots.length,
      bots: Object.fromEntries(botStatuses)
    });
    response.writeHead(200, { "content-type": "application/json" }).end(body);
  });

  server.on("error", (error) => {
    console.error("Health server failed:", error);
    process.exitCode = 1;
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${port}.`);
  });

  return server;
}

function validateBot(bot) {
  if (!bot.tokenEnv || !process.env[bot.tokenEnv]) {
    throw new Error(`${bot.id}: missing token in environment variable ${bot.tokenEnv || "(unset)"}.`);
  }
  if (!bot.guildId || !bot.voiceChannelId) {
    throw new Error(`${bot.id}: set guildId and voiceChannelId in bots.config.json.`);
  }
  if (!bot.soundFile) {
    throw new Error(`${bot.id}: set soundFile in bots.config.json.`);
  }

  const soundPath = path.resolve(__dirname, bot.soundFile);
  if (!soundPath.startsWith(`${__dirname}${path.sep}`) || !fs.existsSync(soundPath)) {
    throw new Error(`${bot.id}: sound file does not exist inside this project: ${bot.soundFile}`);
  }
  return soundPath;
}

async function startBot(bot, soundPath) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  clients.push(client);

  client.once("ready", async () => {
    try {
      const guild = await client.guilds.fetch(bot.guildId);
      const channel = await guild.channels.fetch(bot.voiceChannelId);
      if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
        throw new Error(`Configured channel ${bot.voiceChannelId} is not a voice or stage channel.`);
      }

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true
      });
      const player = createAudioPlayer();
      const volume = bot.volume ?? config.defaults?.volume ?? 0.5;
      const loop = bot.loop ?? config.defaults?.loop ?? false;

      if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
        throw new Error(`Volume must be a number between 0 and 1; received ${volume}.`);
      }

      const playSound = () => {
        const resource = createAudioResource(soundPath, { inlineVolume: true });
        resource.volume.setVolume(volume);
        player.play(resource);
      };

      player.on(AudioPlayerStatus.Idle, () => {
        if (loop) playSound();
      });
      player.on("error", (error) => {
        console.error(`${bot.id}: audio playback failed:`, error);
      });
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        botStatuses.set(bot.id, "disconnected");
        console.error(`${bot.id}: voice connection disconnected.`);
      });
      connection.subscribe(player);
      playSound();
      botStatuses.set(bot.id, "connected");
      console.log(`${bot.id} (${client.user.tag}) connected to ${channel.name}.`);
    } catch (error) {
      botStatuses.set(bot.id, "error");
      console.error(`${bot.id} failed to join/play:`, error);
    }
  });

  client.on("error", (error) => {
    botStatuses.set(bot.id, "error");
    console.error(`${bot.id}: Discord client error:`, error);
  });

  await client.login(process.env[bot.tokenEnv]);
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  await Promise.allSettled(clients.map((client) => client.destroy()));
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  const server = startHealthServer();

  if (enabledBots.length === 0) {
    console.warn("No bots are enabled. Set enabled: true for each bot you want to start.");
    return;
  }

  try {
    const configuredBots = enabledBots.map((bot) => ({
      bot,
      soundPath: validateBot(bot)
    }));
    await Promise.all(configuredBots.map(({ bot, soundPath }) => startBot(bot, soundPath)));
  } catch (error) {
    console.error("Could not start configured bots:", error);
    await Promise.allSettled(clients.map((client) => client.destroy()));
    server.close(() => process.exit(1));
  }
}

main().catch((error) => {
  console.error("Application startup failed:", error);
  process.exitCode = 1;
});
