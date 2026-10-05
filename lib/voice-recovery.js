const {
  entersState,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason
} = require("@discordjs/voice");

function attachVoiceRecovery(entry, connection) {
  connection.on(VoiceConnectionStatus.Ready, () => {
    if (entry.connection !== connection) return;
    entry.status = "connected";
    entry.error = null;
    entry.recoveryPromise = null;
    entry.playback?.resume();
  });

  connection.on(VoiceConnectionStatus.Disconnected, (_oldState, newState) => {
    if (entry.connection !== connection || entry.recoveryPromise) return;

    entry.status = "reconnecting";
    entry.error = newState.reason === VoiceConnectionDisconnectReason.WebSocketClose
      ? `Voice WebSocket closed (${newState.closeCode}); reconnecting.`
      : "Voice connection interrupted; reconnecting.";

    const recovery = (async () => {
      let attempt = 0;
      while (entry.connection === connection && entry.client?.isReady()) {
        if (connection.state.status === VoiceConnectionStatus.Destroyed) return;

        if (connection.state.status === VoiceConnectionStatus.Disconnected) {
          const rejoined = connection.rejoin();
          if (!rejoined) {
            entry.error = "Discord voice rejoin could not be sent; retrying.";
          }
        }

        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
          if (entry.connection === connection) {
            entry.status = "connected";
            entry.error = null;
            entry.playback?.resume();
          }
          return;
        } catch (error) {
          if (entry.connection !== connection || !entry.client?.isReady()) return;
          if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
          const closeCode = connection.state.status === VoiceConnectionStatus.Disconnected
            ? connection.state.closeCode
            : undefined;
          entry.status = "reconnecting";
          entry.error = closeCode
            ? `Voice reconnect failed (close code ${closeCode}): ${error.message}`
            : `Voice reconnect failed: ${error.message}`;
          console.error(`${entry.bot.id}: ${entry.error}`);
          const backoff = Math.min(1_000 * (2 ** Math.min(attempt, 5)), 30_000);
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    })();

    entry.recoveryPromise = recovery;
    void recovery
      .catch((error) => {
        if (entry.connection !== connection) return;
        entry.status = "reconnecting";
        entry.error = `Voice recovery failed: ${error.message}`;
        console.error(`${entry.bot.id}: ${entry.error}`);
      })
      .finally(() => {
        if (entry.recoveryPromise === recovery) entry.recoveryPromise = null;
      });
  });
}

module.exports = { attachVoiceRecovery };
