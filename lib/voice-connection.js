const {
  joinVoiceChannel,
  VoiceConnectionStatus
} = require("@discordjs/voice");

function joinBotVoiceChannel(botId, channel) {
  return joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    group: botId
  });
}

function destroyVoiceConnection(connection) {
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    connection.destroy();
  }
}

module.exports = { destroyVoiceConnection, joinBotVoiceChannel };
