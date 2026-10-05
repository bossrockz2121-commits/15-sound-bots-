const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { destroyVoiceConnection, joinBotVoiceChannel } = require("../lib/voice-connection");

describe("bot voice connections", () => {
  it("keeps each bot on its own voice connection for the same guild", () => {
    const adapterCreator = () => ({ sendPayload: () => true, destroy() {} });
    const channel = {
      id: "111111111111111111",
      guild: {
        id: "222222222222222222",
        voiceAdapterCreator: adapterCreator
      }
    };
    const connections = Array.from({ length: 15 }, (_, index) =>
      joinBotVoiceChannel(`bot-${index + 1}`, channel)
    );

    try {
      assert.equal(new Set(connections).size, 15, "each bot must have its own connection");
      for (const connection of connections) {
        connection.on("error", () => {});
        connection.on("disconnected", () => {});
        connection.once("ready", () => {});
        assert.equal(connection.listenerCount("error"), 1);
        assert.equal(connection.listenerCount("disconnected"), 1);
        assert.equal(connection.listenerCount("ready"), 1);
      }
      assert.equal(
        joinBotVoiceChannel("bot-1", channel),
        connections[0],
        "a bot rejoining with the same group should reuse its own connection"
      );
    } finally {
      for (const connection of connections) destroyVoiceConnection(connection);
    }
  });

  it("does not destroy the same connection twice", () => {
    const connection = joinBotVoiceChannel("idempotent-cleanup", {
      id: "333333333333333333",
      guild: {
        id: "444444444444444444",
        voiceAdapterCreator: () => ({ sendPayload: () => true, destroy() {} })
      }
    });

    destroyVoiceConnection(connection);
    assert.doesNotThrow(() => destroyVoiceConnection(connection));
  });
});
