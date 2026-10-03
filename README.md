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
   `/health` is the health-check endpoint. `.node-version` selects Node.js
   22.12.0, required by the DAVE-capable Discord voice library.
5. Open the service URL, sign in with `DASHBOARD_PASSWORD`, enter one Discord
   voice-channel ID, and click **Join all bots**. This saves the ID and joins
   every online, token-configured bot in parallel. The channel's server is
   detected automatically; every bot must be invited to that server and have
   View Channel and Connect permissions. A problem with one bot no longer
   blocks the other bots; failed bots show their individual error in the
   dashboard.
6. Use the single control row at the bottom: **Play audio** plays the selected track,
   **Stop audio** stops playback without leaving voice, **Join VC** joins the selected
   channel, and **Disconnect VC** leaves it. Mute/Unmute/Deafen/Undeafen apply
   fleet-wide. Audio playback also requires Speak permission.
   Joining and disconnecting are user-controlled; the app does not automatically
   retry or rejoin voice. There is no per-bot selection.
7. If a bot does not join voice, check its card for the specific connection
   error. Confirm its token is correct, it is invited to the selected server,
   and it has View Channel and Connect permissions in the channel.
   `/health` reports the Ogg Opus audio format used for playback. Audio is
   converted once per track and volume setting, then the same Opus packets are
   streamed to the fleet so every bot does not have to encode the track in
   JavaScript at playback time. New uploads are prepared in the background;
   the dashboard shows conversion progress, and Play audio reuses that prepared
   output. If conversion stops reporting progress, the dashboard shows an error
   rather than remaining on Preparing indefinitely.
   The master-gain slider applies from 0× to 1000× on the next playback. The
   fleet prepares audio for every bot first, then starts all prepared players
   together in one event-loop pass. Discord network latency can still cause
   small differences between bots. High gain can damage hearing or speakers;
   the audio limiter reduces clipping but cannot make extreme levels safe.
   The selected master gain is held in memory and resets to 1× on service restart.
   Voice-state gateway updates are enabled by the app; no privileged portal
   intent is required for `GuildVoiceStates`.
   A bot can appear in Discord's voice member list before its voice media
   connection is ready. Audio starts only when the dashboard reports
   **Voice media ready**. The voice handshake waits up to 45 seconds; if it
   remains pending, use **Disconnect VC** to cancel it before retrying.
   A `voice network closed` error means the voice transport closed before
   media became ready, not that the channel join necessarily failed. Check
   the reported voice WebSocket close code and Render's outbound Discord voice
   WebSocket/UDP connectivity. Audio cannot play until the connection reaches
   `Ready`. Close code `4017` specifically means Discord requires DAVE
   end-to-end encryption; deploy the current `package-lock.json` with
   `@discordjs/voice` 0.19.2 and Node.js 22.12.0 or newer.
   If a connection is `destroyed`, check the bot card and Render logs for the
   Discord gateway shard close code. The voice adapter is destroyed when its
   gateway shard disconnects; confirm each token is used by one running service
   and check Render's gateway/WebSocket connection and restart logs.
   If it remains in `signalling`, the bot card identifies whether Discord has
   sent the bot voice-state update and voice-server update, plus the reported
   voice endpoint and the voice library's exact networking stage. The app uses
   discord.js's standard voice adapter so the voice library itself processes
   gateway packets and starts networking. Verify this bot's token is not being
   used by a second running service, and that the bot is still online in the
   selected server.
   Each of the 15 slots must also have a unique token. Duplicate tokens are
   detected at startup and the duplicate slot is kept offline with an error.

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
