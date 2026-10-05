const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { describe, it } = require("node:test");
const {
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus
} = require("@discordjs/voice");
const { attachVoiceRecovery } = require("../lib/voice-recovery");

describe("voice connection recovery", () => {
  it("rejoins a 4014 disconnect and resumes playback when ready", async () => {
    const connection = new EventEmitter();
    connection.state = {
      status: VoiceConnectionStatus.Disconnected,
      reason: VoiceConnectionDisconnectReason.WebSocketClose,
      closeCode: 4014
    };
    let rejoinCalls = 0;
    connection.rejoin = () => {
      rejoinCalls += 1;
      connection.state = { status: VoiceConnectionStatus.Signalling };
      setImmediate(() => {
        const oldState = connection.state;
        connection.state = { status: VoiceConnectionStatus.Ready };
        connection.emit(VoiceConnectionStatus.Ready, oldState, connection.state);
      });
      return true;
    };

    let resumeCalls = 0;
    const entry = {
      bot: { id: "test-bot" },
      client: { isReady: () => true },
      connection,
      status: "connected",
      error: null,
      playback: { resume: () => { resumeCalls += 1; } },
      recoveryPromise: null
    };

    attachVoiceRecovery(entry, connection);
    connection.emit(VoiceConnectionStatus.Disconnected, { status: VoiceConnectionStatus.Ready }, connection.state);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(rejoinCalls, 1);
    assert.equal(entry.status, "connected");
    assert.equal(entry.error, null);
    assert.ok(resumeCalls >= 1);
  });
});
