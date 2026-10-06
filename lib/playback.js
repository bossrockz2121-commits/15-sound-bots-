const fs = require("node:fs");
const { spawn } = require("node:child_process");
const {
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource
} = require("@discordjs/voice");
const ffmpegPath = require("ffmpeg-static") || "ffmpeg";

/**
 * Owns the single playback of one bot.
 *
 * The bot has exactly one AudioPlayer for its whole lifetime, and one request
 * generation counter guards it: a request only starts a sound when it is still
 * the newest request, and `player.play(resource)` makes @discordjs/voice destroy
 * the previous resource's stream first. So no matter how fast uploads, play
 * requests or reconnects arrive, only one sound is ever audible at a time and a
 * single request can never start twice.
 *
 * @param {object} entry Bot registry entry: { bot, soundPath, soundFile, volume, loop, connection, error }.
 * @param {object} [playerOptions] Forwarded to createAudioPlayer, e.g. a subscriber
 *   behaviour. By default the library pauses while the bot has no active voice
 *   connection, which is what we want: the sound stays put instead of running on.
 */
function createPlayback(entry, playerOptions) {
  const player = createAudioPlayer(playerOptions);
  const state = { desired: false, generation: 0, startedAt: 0, stalls: 0 };
  let subscribedConnection = null;
  let activeResource = null;
  let activeProcess = null;
  let pendingStart = null;

  const isBusy = () => {
    const status = player.state.status;
    return status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering;
  };

  const load = (generation, startAt = Date.now()) => {
    if (generation !== state.generation || !state.desired) return false;
    if (!fs.existsSync(entry.soundPath)) {
      entry.error = `No audio file yet at ${entry.soundFile}. Add one from the web page.`;
      state.desired = false;
      return false;
    }

    let ffmpeg;
    try {
      ffmpeg = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", entry.soundPath,
        "-map", "0:a:0",
        "-vn",
        "-af", "loudnorm=I=-18:TP=-2:LRA=11",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1"
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let diagnostics = "";
      ffmpeg.stderr.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-4096);
      });
      ffmpeg.once("error", (error) => {
        if (activeResource !== resource || !state.desired) return;
        if (pendingStart) clearTimeout(pendingStart);
        pendingStart = null;
        entry.error = `Could not decode ${entry.soundFile}: ${error.message}`;
        console.error(`${entry.bot.id}: ${entry.error}`);
        state.desired = false;
      });
      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true
      });
      ffmpeg.once("close", (code, signal) => {
        if (code === 0 || activeResource !== resource || !state.desired) return;
        if (pendingStart) clearTimeout(pendingStart);
        pendingStart = null;
        const reason = diagnostics.trim() || `FFmpeg exited with ${code ?? signal}.`;
        entry.error = `Could not decode ${entry.soundFile}: ${reason}`;
        console.error(`${entry.bot.id}: ${entry.error}`);
        state.desired = false;
      });
      resource.playStream.once("close", () => {
        if (ffmpeg.exitCode === null && !ffmpeg.killed) ffmpeg.kill();
      });
      resource.volume?.setVolume(entry.volume);
      activeResource = resource;
      activeProcess = ffmpeg;
      const begin = () => {
        pendingStart = null;
        if (generation !== state.generation || !state.desired || activeResource !== resource) return;
        state.startedAt = Date.now();
        player.play(resource);
      };
      if (startAt > Date.now()) {
        pendingStart = setTimeout(begin, startAt - Date.now());
      } else {
        begin();
      }
      return true;
    } catch (error) {
      if (ffmpeg && ffmpeg.exitCode === null && !ffmpeg.killed) ffmpeg.kill();
      // A missing Opus encoder, an unreadable file or a broken decoder lands here.
      // Report it once instead of letting every retry throw again.
      entry.error = `Could not start ${entry.soundFile}: ${error.message}`;
      console.error(`${entry.bot.id}: ${entry.error}`);
      state.desired = false;
      return false;
    }
  };

  const start = (startAt = Date.now()) => {
    state.desired = false;
    const generation = ++state.generation;
    if (pendingStart) clearTimeout(pendingStart);
    pendingStart = null;
    if (activeProcess && activeProcess.exitCode === null && !activeProcess.killed) {
      activeProcess.kill();
    }
    activeProcess = null;
    activeResource = null;
    try {
      player.stop(true);
    } catch (error) {
      console.error(`${entry.bot.id}: could not replace the current sound:`, error);
    }
    state.desired = true;
    state.stalls = 0;
    return load(generation, startAt);
  };

  player.on(AudioPlayerStatus.Idle, () => {
    if (!state.desired) return;

    if (Date.now() - state.startedAt < 400) {
      if (++state.stalls > 5) {
        entry.error = `${entry.soundFile} keeps ending immediately; it may not be valid audio.`;
        console.error(`${entry.bot.id}: ${entry.error}`);
        state.desired = false;
        return;
      }
    } else {
      state.stalls = 0;
    }

    if (!entry.loop) return;
    const generation = state.generation;
    setTimeout(() => {
      if (generation === state.generation && state.desired) load(generation);
    }, 150);
  });

  player.on("error", (error) => {
    entry.error = error.message;
    console.error(`${entry.bot.id}: audio playback failed:`, error);
  });

  return {
    player,
    play(options = {}) {
      const startAt = Number.isFinite(options.startAt) ? options.startAt : Date.now();
      const started = start(startAt);
      if (started) entry.error = null;
      return started;
    },
    stop() {
      // force = true frees the resource immediately, including its ffmpeg process
      // and file handle, so an upload can replace the file on any platform.
      state.desired = false;
      state.generation += 1;
      if (pendingStart) clearTimeout(pendingStart);
      pendingStart = null;
      if (activeProcess && activeProcess.exitCode === null && !activeProcess.killed) {
        activeProcess.kill();
      }
      activeProcess = null;
      activeResource = null;
      try {
        player.stop(true);
      } catch (error) {
        console.error(`${entry.bot.id}: could not stop the current sound:`, error);
      }
    },
    /** Restarts the current sound only when it should play but nothing is playing. */
    resume() {
      if (!state.desired || isBusy()) return;
      if (start(Date.now())) entry.error = null;
    },
    setVolume(volume) {
      entry.volume = volume;
      activeResource?.volume?.setVolume(volume);
    },
    attach(connection) {
      entry.connection = connection;
      if (subscribedConnection === connection) return;
      subscribedConnection = connection;
      connection.subscribe(player);
    },
    /** True while the sound should be playing and a resource is still active. */
    isPlaying() {
      return state.desired && isBusy();
    }
  };
}

module.exports = { createPlayback };
