# 15 Discord Sound Bot Settings

`bots.config.json` contains one independent settings entry for each of the 15
bots. This folder is a configuration starter, not a running bot application.

## Configure a bot

For each bot:

1. Create a Discord application and bot, then invite it to the server with the
   permissions it needs to connect to and speak in voice channels.
2. Copy `.env.example` to `.env` and put that bot's token in the matching
   `DISCORD_BOT_TOKEN_XX` variable. Do not commit `.env` or share bot tokens.
3. Set `guildId` and `voiceChannelId` in `bots.config.json`.
4. Put the audio file at the configured `soundFile` path, or change the path
   to the sound you want that bot to use.
5. Set `enabled` to `true` for bots you want your bot application to start.

`defaults` provides the default `enabled`, `volume` (0–1), and `loop` values.
An individual bot can override these by adding the same setting to its entry.
Each `tokenEnv` value names the environment variable from which the application
should read that bot's token.

Keep `.env` private; it is excluded by `.gitignore`. The runtime application
must load these settings and environment variables; this folder alone does not
connect bots to Discord.
