const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { after, before, describe, it } = require("node:test");
const voice = require("@discordjs/voice");
const ffmpeg = require("ffmpeg-static");
const { createPlayback } = require("../lib/playback");

// Records every resource handed to AudioPlayer#play, which is what lets these
// tests prove that two sounds are never live at the same moment.
const streams = [];

// Recording starts and stops automatically around each test so counting is local.
let recording = false;
const originalPlay = voice.AudioPlayer.prototype.play;
voice.AudioPlayer.prototype.play = function patchedPlay(resource) {
  if (recording) streams.push({ at: Date.now(), resource });
  return originalPlay.call(this, resource);
};

// Without a voice connection the player would pause, so keep it running and
// measure pure playback behaviour.
const keepPlaying = { behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play } };

let tmpDir;
let soundA;
let soundB;
const playbacks = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tone(file, seconds, frequency, volume = 1) {
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`,
    "-af", `volume=${volume}`,
    "-ac", "2", "-ar", "48000", file
  ]);
}

const liveStreams = () =>
  streams.filter(({ resource }) => !resource.playStream.destroyed && !resource.playStream.readableEnded).length;

function makeEntry(soundPath, extra = {}) {
  return {
    bot: { id: "test-bot" },
    soundPath,
    soundFile: path.basename(soundPath),
    volume: 0.5,
    loop: false,
    connection: null,
    error: null,
    ...extra
  };
}

function start(entry) {
  const playback = createPlayback(entry, keepPlaying);
  playbacks.push(playback);
  return playback;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soundbots-test-"));
  soundA = path.join(tmpDir, "voice.wav");
  soundB = path.join(tmpDir, "short.wav");
  tone(soundA, 1.5, 440);
  tone(soundB, 0.6, 880);
});

after(async () => {
  playbacks.forEach((playback) => playback.stop());
  await sleep(200);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A lingering ffmpeg handle on Windows must not fail the suite.
  }
});

describe("bot playback", () => {
  it("starts a sound exactly once and never restarts it on its own", async () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(soundA);
    const playback = start(entry);
    playback.play();
    await sleep(2500);
    recording = false;

    assert.equal(streams.length, 1, "one add must produce exactly one audio stream");
    assert.equal(playback.isPlaying(), false, "the bot is silent once the sound finished");
    assert.equal(playback.player.state.status, "idle", "the player returns to idle");
  });

  it("updates the gain on the active resource without restarting playback", async () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(soundA);
    const playback = start(entry);
    playback.play();
    await playback.waitUntilReady();
    playback.setVolume(1.75);
    await sleep(20);
    recording = false;

    assert.equal(streams.length, 1, "changing gain must not create another stream");
    assert.equal(entry.volume, 1.75, "the selected gain is retained for future playback");
    assert.equal(playback.isPlaying(), true, "the current stream remains active");
    playback.stop();
  });

  it("decodes imported audio files to playable 48 kHz stereo PCM", async () => {
    streams.length = 0;
    recording = true;
    const playback = start(makeEntry(soundA));
    playback.play();
    await playback.waitUntilReady();
    await sleep(20);
    const chunks = [];
    streams[0].resource.playStream.on("data", (chunk) => chunks.push(chunk));
    await sleep(400);
    playback.stop();
    recording = false;

    assert.ok(chunks.length > 0, "the decoder must provide audio data to the player");
    assert.ok(chunks.reduce((total, chunk) => total + chunk.length, 0) > 0);
  });

  it("normalizes quiet imported audio to a consistent playback level", async () => {
    streams.length = 0;
    const quietSound = path.join(tmpDir, "quiet.wav");
    tone(quietSound, 1, 440, 0.003162);
    recording = true;
    const playback = start(makeEntry(quietSound, { volume: 1 }));
    playback.play();
    await playback.waitUntilReady();
    await sleep(20);
    const chunks = [];
    streams[0].resource.playStream.on("data", (chunk) => chunks.push(chunk));
    await sleep(500);
    playback.stop();
    recording = false;

    const peak = chunks.reduce((max, chunk) => {
      for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
        max = Math.max(max, Math.abs(chunk.readInt16LE(offset)));
      }
      return max;
    }, 0);
    assert.ok(peak > 4000, `normalized PCM peak should be audible, received ${peak}`);
  });

  it("starts a scheduled fleet track at its shared start time", async () => {
    streams.length = 0;
    recording = true;
    const playback = start(makeEntry(soundA));
    const startAt = Date.now() + 300;
    assert.equal(playback.play({ startAt }), true);
    await playback.waitUntilReady();
    await sleep(120);
    assert.equal(streams.length, 0, "the stream waits for the common start time");
    await sleep(300);
    recording = false;
    assert.equal(streams.length, 1, "the stream starts once the common time arrives");
    assert.ok(streams[0].at >= startAt - 40, "playback must not start ahead of the shared time");
    playback.stop();
  });

  it("keeps separate bot players aligned to one scheduled start time", async () => {
    streams.length = 0;
    recording = true;
    const first = start(makeEntry(soundA));
    const second = start(makeEntry(soundA));
    let scheduleFleet;
    const sharedStart = new Promise((resolve) => {
      scheduleFleet = resolve;
    });
    first.play({ startAt: sharedStart });
    second.play({ startAt: sharedStart });
    await Promise.all([first.waitUntilReady(), second.waitUntilReady()]);
    assert.equal(streams.length, 0, "neither bot starts before the fleet is ready");
    scheduleFleet(Date.now() + 350);
    await sleep(500);
    recording = false;

    assert.equal(streams.length, 2, "each bot receives one stream");
    assert.ok(Math.abs(streams[0].at - streams[1].at) < 60, "bot streams begin together");
    first.stop();
    second.stop();
  });

  it("cancels a scheduled start when stopped before it begins", async () => {
    streams.length = 0;
    recording = true;
    const playback = start(makeEntry(soundA));
    playback.play({ startAt: Date.now() + 300 });
    await sleep(50);
    playback.stop();
    await sleep(350);
    recording = false;
    assert.equal(streams.length, 0, "stopping cancels the pending start");
  });

  it("keeps only the newest stream alive when requests arrive rapidly", async () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(soundA);
    const playback = start(entry);
    for (let i = 0; i < 5; i += 1) playback.play();
    await playback.waitUntilReady();
    await sleep(20);
    recording = false;

    assert.equal(streams.length, 1, "only the newest request starts after decoding");
    assert.equal(liveStreams(), 1, "only one stream may be audible at a time");
    playback.stop();
  });

  it("does not double-start on resume but recovers exactly one stream after an interruption", async () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(soundA);
    const playback = start(entry);
    playback.play();
    await playback.waitUntilReady();
    await sleep(20);
    await sleep(400);
    playback.resume();
    playback.resume();
    assert.equal(streams.length, 1, "resuming a playing bot must not add a stream");

    playback.player.stop(true);
    await sleep(50);
    playback.resume();
    await playback.waitUntilReady();
    await sleep(20);
    recording = false;
    assert.equal(streams.length, 2, "a reconnect recovery starts exactly one stream");
    assert.equal(liveStreams(), 1, "the recovered sound is the only live stream");
    playback.stop();
  });

  it("does not restart a bot that was stopped on purpose", async () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(soundA);
    const playback = start(entry);
    playback.play();
    await sleep(200);
    playback.stop();
    playback.resume();
    recording = false;

    assert.equal(streams.length, 1, "stop() must win over a later resume()");
  });

  it("releases the file on stop so an upload can replace it", async () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(soundA);
    const playback = start(entry);
    playback.play();
    await playback.waitUntilReady();
    await sleep(20);
    await sleep(500);
    playback.stop();

    const replacement = path.join(tmpDir, "replacement.wav");
    tone(replacement, 0.8, 660);
    fs.renameSync(replacement, soundA);

    playback.play();
    await playback.waitUntilReady();
    await sleep(20);
    recording = false;
    assert.equal(streams.length, 2, "the replacement plays right after the old sound");
    assert.equal(liveStreams(), 1, "the replacement is the only live stream");
    assert.ok(streams[0].resource.playStream.destroyed, "the old sound is destroyed, so it cannot overlap the new one");
    playback.stop();
  });

  it("stops looping for good when the bot is stopped", async () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(soundB, { loop: true });
    const playback = start(entry);
    playback.play();
    await sleep(300);
    playback.stop();
    const afterStop = streams.length;
    await sleep(1400);
    recording = false;

    assert.equal(streams.length, afterStop, "a stale idle event must not restart the loop");
  });

  it("loops at most once per finished sound", async () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(soundB, { loop: true });
    const playback = start(entry);
    playback.play();
    await sleep(2200);
    recording = false;

    assert.ok(streams.length >= 2 && streams.length <= 4, `expected a few loops, received ${streams.length}`);
    const gaps = streams.slice(1).map((stream, index) => stream.at - streams[index].at);
    assert.ok(gaps.every((gap) => gap >= 500), `loop replays must not stack up, gaps: ${gaps.join(",")}ms`);
    playback.stop();
  });

  it("reports a missing sound instead of playing something stale", () => {
    streams.length = 0;
    recording = true;
    const entry = makeEntry(path.join(tmpDir, "never-added.wav"));
    const playback = start(entry);
    const started = playback.play();
    recording = false;

    assert.equal(started, false, "playback must not start without a file");
    assert.equal(streams.length, 0, "nothing is streamed");
    assert.ok(entry.error && entry.error.length > 0, "the bot status explains what is missing");
  });

  it("does not report empty or invalid audio as ready to play", async () => {
    streams.length = 0;
    const invalidSound = path.join(tmpDir, "empty.wav");
    fs.writeFileSync(invalidSound, Buffer.alloc(0));
    const entry = makeEntry(invalidSound);
    const playback = start(entry);

    assert.equal(playback.play(), true, "the decoder process starts");
    assert.equal(await playback.waitUntilReady(), false, "no decoded samples means playback is not ready");
    await sleep(20);

    assert.equal(playback.isPlaying(), false, "invalid audio is never sent to the voice player");
    assert.equal(streams.length, 0, "no empty stream is created");
    assert.match(entry.error, /Could not decode/);
  });
});
