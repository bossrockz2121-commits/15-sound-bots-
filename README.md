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
   voice-channel ID, and click **Join all bots**. This saves the ID and joins
   every online, token-configured bot in parallel. The channel's server is
   detected automatically; every bot must be invited to that server and have
   View Channel and Connect permissions. A problem with one bot no longer
   blocks the other bots; failed bots show their individual error in the
   dashboard.
6. Use the single control row at the bottom: **Start** plays the selected track,
   **Stop** stops audio without leaving voice, **Join VC** joins the selected
   channel, and **Disconnect VC** leaves it. Mute/Unmute/Deafen/Undeafen apply
   fleet-wide. Audio playback also requires Speak permission.
   Joining and disconnecting are user-controlled; the app does not automatically
   retry or rejoin voice. There is no per-bot selection.
7. If a bot does not join voice, check its card for the specific connection
   error. Confirm its token is correct, it is invited to the selected server,
   and it has View Channel and Connect permissions in the channel.
   Voice-state gateway updates are enabled by the app; no privileged portal
   intent is required for `GuildVoiceStates`.
   The voice handshake waits up to 45 seconds and leaves a still-negotiating
   connection alive rather than disconnecting it at timeout. If it remains
   stuck in `connecting`, use **Disconnect all bots** to cancel it, then check
   the host's outbound Discord voice connectivity before manually joining again.
   If it remains in `signalling`, the bot card identifies whether Discord has
   sent the bot voice-state update and voice-server update, plus the reported
   voice endpoint. If the server update arrived first, the app now buffers it
   until the bot voice-state update arrives, then forwards both to the voice
   connection in order. Verify this bot's token is not being used by a second
   running service, and that the bot is still online in the selected server.
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
