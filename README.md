# 15 Discord Sound Bots

This Node.js app serves a blue-and-black control dashboard for up to 15 Discord
sound bots. Enter one voice channel ID, use **Join all** and **Disconnect all**
to control the whole fleet, and play or stop shared audio from the dashboard.

## Run the app

1. Install Node.js 22.12.0 or later and run `npm install`. The current Discord
   voice protocol requires the DAVE-capable `@discordjs/voice` 0.19 release.
2. Copy `.env.example` to `.env`, then add a `DISCORD_BOT_TOKEN_XX` value for
   every bot you want online. Never commit or share a real token.
3. Start the service with `npm start`, then open `http://localhost:3000/`.
4. Copy a Discord voice channel ID into the dashboard and press **Join all**.
   Bots with configured tokens attempt to join that channel; one bot's missing
   permission or connection problem does not prevent other bots from joining.
   Each bot uses an isolated voice-connection group, so all 15 bots can join the
   same server/channel without sharing one connection or accumulating each other's
   connection event listeners.
5. Upload one or more audio files, choose a track if needed, then use **Play**
   or **Stop** to control playback across the connected bots.

Each bot must be invited to the server that owns the selected channel and be
allowed **View Channel**, **Connect**, and **Speak** in that channel or category.
For **Mute all** and **Deafen all**, also grant **Mute Members** and
**Deafen Members** to the bots. The dashboard reports missing permissions per
bot. Transient voice disconnects are retried with backoff; a `4014` voice
WebSocket close is explicitly rejoined, while other close codes are retried by
the voice library.
The Discord **Developer Mode** context menu can copy the channel ID. `Join all`
logs each configured bot into Discord at startup; bots do not join voice until
you press the button. **Disconnect all** leaves voice but keeps the bot clients
online so they can be joined again.

## Uploads and volume

The shared audio library is stored in `sounds/fleet/`. Select multiple audio
files at once or drop them in the upload area. The browser uploads up to three
files concurrently, displays aggregate progress, and streams each file directly
to disk. The default and maximum accepted size is **90 MB per file**. Set
`MAX_SOUND_MB` in `.env` to choose a smaller limit. Supported extensions include
MP3, WAV, OGG, OGA, OPUS, M4A, AAC, FLAC, WEBM, MP4, MKV, AIF, AIFF, WMA, and MOV.

The fleet gain control ranges from mute to **3×** (about +9.5 dB of digital
gain). A 1000× gain is not offered: extreme output can harm hearing or
speakers, and digital gain cannot make playback safe. Higher gain can also
distort audio, so increase gradually and keep device volume moderate.

## API

| Request | Effect |
| --- | --- |
| `GET /api/state` | Fleet, channel, gain, upload limit, and shared library state |
| `POST /api/fleet/join?channelId=<id>` | Join every available bot to a voice channel |
| `POST /api/fleet/disconnect` | Disconnect every bot from voice |
| `POST /api/fleet/play`, `POST /api/fleet/stop` | Start or stop playback across connected bots |
| `POST /api/fleet/gain?value=<0-3>` | Set live fleet playback gain |
| `POST /api/fleet/mute`, `/unmute`, `/deafen`, `/undeafen` | Set voice moderation state for connected bots |
| `POST /api/audio?name=<filename>` | Stream an audio file into the shared library |
| `POST /api/audio/select?file=<path>` | Select a file from the shared library |
| `GET /health` | Health check for Render |

Uploaded files stay on the service's own disk. On Render, add a persistent disk
if uploaded audio must survive deployments or service restarts, and set
`AUDIO_UPLOAD_DIR` to its mount path (for example `/var/data/audio`). The voice
channel selection and gain are held in memory and need to be set again after a
service restart.

## Deploy on Render

Create a **Web Service**, use `npm install` for the Build Command and `npm start`
for the Start Command. Render provides the `PORT` environment variable and uses
`/health` as the health-check endpoint. Add the bot token environment variables
for all bots that should connect. For persistent uploaded audio, mount a disk
and configure the app's storage path before deployment.

Run `npm test` to execute playback regression tests.
