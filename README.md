# 15 Discord Sound Bot Settings

`bots.config.json` contains settings for 15 Discord sound bots. The Node.js
application starts the enabled bots, serves the sound-management page at `/`,
and exposes `/health` for Render.

## Add audio from the web page

Start the app and open `http://localhost:3000/` (or the Render URL):

1. Pick or drop one or more audio files on a bot card. `.mp3`, `.wav`, `.ogg`, `.oga`,
   `.opus`, `.m4a`, `.aac`, `.flac`, `.webm`, `.mp4`, `.mkv`, `.aif`, `.aiff`,
   `.wma` and `.mov` are accepted, up to 25 MB per file. Set `MAX_SOUND_MB` to
   change that limit.
2. Files are streamed straight to the bot's audio library, with up to three
   files uploading at once. A single added file starts playing immediately;
   for a batch, the final successfully uploaded file is selected and played.
3. Choose a file from the library section on the bot card to play it. Uploads
   with the same filename replace that library entry; other files remain
   available for later selection.

Each bot owns exactly one audio player. A new sound stops the previous one,
including its ffmpeg process, before it starts, so a sound can never overlap
itself or a newer sound. `npm test` runs the playback regression tests covering
that guarantee.

The page is driven by these endpoints:

| Request | Effect |
| --- | --- |
| `GET /api/bots` | Status, library, selected sound and playback state of all 15 bots |
| `POST /api/bots/<id>/sound?name=<filename>` | Stream raw audio bytes into that bot's library |
| `POST /api/bots/<id>/select?file=<path>` | Select and play a file from that bot's library |
| `POST /api/bots/<id>/play`, `POST /api/bots/<id>/stop` | Start or stop that bot's sound |
| `GET /health` | Health check used by Render |

Uploaded sounds live under `sounds/<bot-id>/` on the service's own disk. They
survive restarts and redeploys only as long as the container keeps its
filesystem, so commit the files you want permanently next to `bots.config.json`.
The configured `soundFile` remains the initial sound; the web page also lists
that file alongside uploaded library sounds.

## Configure a bot

For each bot:

1. Create a Discord application and bot, then invite that bot to the target
   server. Every bot account must be invited separately. In the Discord
   Developer Portal's OAuth2 URL Generator, select the `bot` scope and grant
   **View Channels**, **Connect**, and **Speak**. Also grant those permissions
   to each bot in the target voice channel's permissions (or its category);
   channel/category overrides can deny access even when the server role allows it.
2. For local development, copy `.env.example` to `.env` and put that bot's
   token in the matching `DISCORD_BOT_TOKEN_XX` variable. On Render, add the
   same variable names under **Environment** instead. Never commit or share
   bot tokens.
3. Set `guildId` and `voiceChannelId` in `bots.config.json`.
4. Put the audio file at the configured `soundFile` path, or add it from the
   web page instead.
5. Set `enabled` to `true` for bots you want the application to start.
   The default is `false`, so no bot logs in until you enable it.

`defaults` provides the default `enabled`, `volume` (0–1), and `loop` values.
An individual bot can override these by adding the same setting to its entry.
The default volume is `1` (full gain); reduce it if the sound distorts or is too loud.
Set `loop` to `true` to repeat that bot's sound continuously. The app checks
voice permissions before joining, waits for the voice connection to become
ready before playback, and attempts to reconnect if Discord drops the connection.
Each `tokenEnv` value names the environment variable from which the application
reads that bot's token. Audio files must be included in the deployed project;
the configured files are transcoded for Discord voice playback.

A bot whose sound file is not there yet still connects and reports
`Add an audio file for this bot from the web page` in its status, so you can add
the sound later without restarting the app.

Voice playback needs an Opus encoder and an encryption library, which are
installed as dependencies (`opusscript` and `libsodium-wrappers`) by
`npm install`. Run `npm run test` to confirm playback behaviour on your machine.

The app cannot bypass Discord permissions: a `Missing Access` error means the
bot has not been invited to the configured server or cannot view the configured
channel. Check that the configured guild and channel IDs are correct and that
channel-level permission overrides allow **View Channel**, **Connect**, and
**Speak** for that specific bot.

## Deploy on Render

Create a **Web Service** for this repository, use **`npm install`** as the
Build Command and **`npm start`** as the Start Command. Render detects the
listening `PORT` and checks `/health`. Add a `DISCORD_BOT_TOKEN_XX` environment
variable for each enabled bot, and ensure the bot's configured sound file is
committed to the repository. The bot must be invited to the configured server
and have permission to view, connect to, and speak in its voice channel.
