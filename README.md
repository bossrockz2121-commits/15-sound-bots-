# Soundroom — 15 Discord Sound Bots

Soundroom is a password-protected web dashboard and Node.js service for
operating up to 15 Discord sound bots. The dashboard lets you choose voice
channels per bot, upload audio, start or stop selected bots, and mute, unmute,
deafen, or undeafen all bots currently connected to voice.

## Configure

1. Create a Discord application and bot for each bot slot you plan to use.
   Invite each bot to your server with permission to view the server and voice
   channel, connect, and speak.
2. Configure `DISCORD_BOT_TOKEN_01` through `DISCORD_BOT_TOKEN_15` as
   environment variables. Use a local `.env` copied from `.env.example` for
   local development; on Render, enter tokens in the service's **Environment**
   settings. Never commit or share real bot tokens.
3. Set a strong `DASHBOARD_PASSWORD` environment variable. The dashboard will
   not permit control actions without it.
4. Deploy the repository as a Render **Web Service** with **Build Command**
   `npm install` and **Start Command** `npm start`. Render supplies `PORT`;
   `/health` is the health-check endpoint.
5. Open the service URL, sign in with `DASHBOARD_PASSWORD`, select each bot,
   load its server and voice-channel choices, and select a channel.
6. Upload a sound, select the bots to operate, and use the control bar. Start
   and Stop apply to selected bots; Mute/Unmute/Deafen/Undeafen All apply to
   every bot currently connected to a voice channel.
7. Use **Start all** to start all 15 configured bot slots in parallel with the
   selected sound. Use **Stop all** to disconnect every bot currently in
   voice. Bots that are offline or have not been assigned a voice channel are
   reported individually.

Bots with tokens connect to Discord when the service starts. Slots without a
token remain visible but offline. Channel selections are held in memory until
the service restarts. Audio uploads are limited to 50 MB and supported audio
formats (MP3, WAV, OGG, OPUS, M4A, AAC, FLAC, and WEBM).

## Render audio persistence

Render's ordinary service filesystem is temporary. To keep uploaded sounds
across deploys and restarts, attach a persistent disk mounted at
`/var/data` and set `AUDIO_UPLOAD_DIR` to `/var/data/audio` in the service
environment. Without a disk, uploaded files may be lost when Render replaces
the service instance.
