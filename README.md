# 15 Discord Sound Bot Settings

`bots.config.json` contains settings for 15 Discord sound bots. The Node.js
application starts the enabled bots and exposes `/health` for Render.

## Configure a bot

For each bot:

1. Create a Discord application and bot, then invite it to the server with the
   permissions it needs to connect to and speak in voice channels.
2. For local development, copy `.env.example` to `.env` and put that bot's
   token in the matching `DISCORD_BOT_TOKEN_XX` variable. On Render, add the
   same variable names under **Environment** instead. Never commit or share
   bot tokens.
3. Set `guildId` and `voiceChannelId` in `bots.config.json`.
4. Put the audio file at the configured `soundFile` path, or change the path
   to the sound you want that bot to use.
5. Set `enabled` to `true` for bots you want the application to start.
   The default is `false`, so no bot logs in until you enable it.

`defaults` provides the default `enabled`, `volume` (0–1), and `loop` values.
An individual bot can override these by adding the same setting to its entry.
Each `tokenEnv` value names the environment variable from which the application
reads that bot's token. Audio files must be included in the deployed project;
the configured `.mp3` files are transcoded for Discord voice playback.

## Deploy on Render

Create a **Web Service** for this repository, use **`npm install`** as the
Build Command and **`npm start`** as the Start Command. Render detects the
listening `PORT` and checks `/health`. Add a `DISCORD_BOT_TOKEN_XX` environment
variable for each enabled bot, and ensure the bot's configured sound file is
committed to the repository. The bot must be invited to the configured server
and have permission to view, connect to, and speak in its voice channel.
