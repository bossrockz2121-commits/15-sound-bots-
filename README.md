# Soundroom — 15 Discord Sound Bots

Soundroom is a password-protected web dashboard and Node.js service for
operating up to 15 Discord sound bots together. Upload one audio track, set one
voice-channel ID for the fleet, then start or stop every token-configured bot
at once. Mute, unmute, deafen, and undeafen controls apply to every bot
currently connected to voice.

## Configure

1. Create a Discord application and bot for each bot slot you plan to use.
   Invite each bot to your server with permission to view the server and voice
   channel, connect, and speak.
2. Configure `DISCORD_BOT_TOKEN_01` through `DISCORD_BOT_TOKEN_15` as
   environment variables. Use a local `.env` copied from `.env.example` for
   local development; on Render, enter tokens in the service's **Environment**
   settings. Never commit or share real bot tokens.
3. Set a strong `DASHBOARD_PASSWORD` environment variable. The dashboard will
   not permit control actions without it. Optionally set `VOICE_CHANNEL_ID` to
   prefill the shared voice channel.
4. Deploy the repository as a Render **Web Service** with **Build Command**
   `npm install` and **Start Command** `npm start`. Render supplies `PORT`;
   `/health` is the health-check endpoint.
5. Open the service URL, sign in with `DASHBOARD_PASSWORD`, enter one Discord
   voice-channel ID, and apply it to the fleet. The channel's server is detected
   automatically; every token-configured bot must be invited to that server.
6. Upload one sound and use **Start all bots**. All bots with configured tokens
   are started in parallel using that audio and channel. **Stop all bots**
   disconnects the entire connected fleet. Mute/Unmute/Deafen/Undeafen apply to
   every bot currently connected to voice. There is no per-bot selection.

Bots with tokens connect to Discord when the service starts. Slots without a
token remain visible but offline and are skipped by fleet start. A channel
entered in the dashboard is held in memory until the service restarts; use
`VOICE_CHANNEL_ID` in the service environment to restore it after a restart.
Audio uploads are limited to 50 MB and supported audio
formats (MP3, WAV, OGG, OPUS, M4A, AAC, FLAC, and WEBM).

## Render audio persistence

Render's ordinary service filesystem is temporary. To keep uploaded sounds
across deploys and restarts, attach a persistent disk mounted at
`/var/data` and set `AUDIO_UPLOAD_DIR` to `/var/data/audio` in the service
environment. Without a disk, uploaded files may be lost when Render replaces
the service instance.
