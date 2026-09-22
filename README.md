# AniNinja

Personal desktop app for browsing and streaming anime — a GUI equivalent of
[ani-cli](https://github.com/pystardust/ani-cli) using the same source site
(hianime.at) and the same ZokoAnime embed flow.

**Personal use only.** It scrapes unofficial sources, exactly like ani-cli does.

## Repo layout

Two apps share one codebase:

- **`desktop/`** — the Windows/Electron app: `main.js` (Electron shell),
  `server.js` (local HTTP server), `scraper.js` (the ani-cli-mirroring
  scraper), `cloud.js` (Supabase sync), `ui/` (vanilla JS UI), and the
  build/publish config. See `desktop/README.md` for building and releasing.
- **`expo-app/`** — the Android port: an Expo/React Native shell around the
  *same* `server.js` + `scraper.js` + `ui/`, booted on a bundled Node.js
  runtime (nodejs-mobile) and rendered in a WebView. The shared files are
  zipped into the APK by `expo-app/scripts/sync-node.sh` — run that after
  every change to the shared code. See `expo-app/README.md`.

## Install

### Android (APK)

1. Go to the [Releases page](https://github.com/RichardPersaud/AniBrowser/releases)
2. Download the APK matching your device (most phones: **arm64**) from the
   latest release's Assets — emulators need the **universal** APK
3. Open the APK and allow "install unknown apps" when Android asks
   (releases v1.0.18+ install straight over each other; pre-1.0.18 releases
   were signed with a different key and must be uninstalled first)

The APK is a full port of the desktop app for phones — same UI, same scraper,
same sources, with a bundled Node.js runtime inside the app (no extra
permissions beyond notifications). It adds the mobile bits: the in-window
mini player is draggable, tapping the sidebar mid-episode docks the video
there, and leaving the app hands it to system picture-in-picture. New
episodes of favorited shows post a system notification (toggle it in
⚙ Settings → **Favorite update alerts**). The app checks GitHub Releases
for updates every 6 hours and offers a one-tap install of new APKs.

### Windows

1. Go to the [Releases page](https://github.com/RichardPersaud/AniBrowser/releases)
2. Under the latest release, download **AniNinja-Setup-x.y.z.exe** from Assets
3. Run the installer — standard setup with a desktop shortcut

**SmartScreen note:** the installer isn't code-signed, so Windows may warn
*"Windows protected your PC"*. Click **More info → Run anyway** — that's
expected for a self-built app.

Installers aren't committed to the repo because GitHub blocks files over
100MB; every build ships as a release asset instead. Settings, favorites and
watch history survive updates and reinstalls.

### Auto-updates (from v1.0.15 on)

Once installed, AniNinja keeps itself up to date — you only ever run the
installer once:

- The app checks GitHub Releases on launch and every 6 hours.
- When a new version is published, a banner appears at the top of the window:
  **Download update** (progress bar) → **Restart to install**. The silent
  installer replaces the app in place and relaunches it.
- You can also check manually any time via **⚙ Settings → Updates → Check now**.
- Update metadata (`latest.yml` + blockmap) is produced by electron-builder
  and published with each release; `electron-updater`'s GitHub provider
  handles version checks, downloads and the silent install.

On Android the same flow works a little differently (sideloaded APKs can't
silently replace themselves): the bundled server checks the newest release
for an `.apk` asset, the banner downloads it, and **Install update** hands it
to Android's standard installer prompt. Android updates need the release to
be *published* (drafts are invisible to the check) and to carry the APK asset.

## Use

1. Type in the search bar, pick a result
2. Pick an episode (SUB/DUB toggle available)
3. Player has: skip-intro, subtitles (auto-loaded), quality selector,
   auto-next, resume-where-you-left-off (per show, in "Continue watching")
4. Sidebar (☰ in the top bar) has Home, Browse, and Favorites — clicking it
   while watching docks the video into a mini player in the corner
   (⤢ expands it back, ✕ stops playback)
5. Browse tab: full catalog by letter (All / 0-9 / A-Z / Other) or with
   filters (type, status, genre, rating, score, season, audio, sort),
   paginated with clickable page numbers
6. Detail pages show synopsis, MAL score, genres, studios, producers,
   aired dates, sub/dub episode counts and more — genre badges jump into
   Browse pre-filtered to that genre
7. ♥ on any poster (or the button on the detail page) adds a show to Favorites;
   ✕ on a continue-watching card (or "Clear history") removes it from the
   watch history
8. Episodes you've played are marked with a ✓ in the episode list (starting
   playback is enough — no need to finish); the one you stopped on is
   highlighted as the resume point
9. 🔔 bell in the top bar: when a favorited show releases new episodes, it
   lands in the notifications panel (badge + toast). Favorites are polled
   every 10 minutes; "Mark all seen" dismisses them. Notification state is
   saved with the backup.
10. App version shows in Settings and at the bottom of the sidebar
11. Settings toggle: **R-rated content (18+)** — Hide (default) removes 18+
    titles from Home, Search and Browse (they're marked `18+` on the source's
    cards); Show restores them
12. Episodes whose embeds are all dead at the source are crossed out in the
    episode list after one failed attempt — the error message also says so
13. Detail pages show up to 5 recommendations picked from the show's own
    genres (most-watched within each genre)
14. Settings, favorites and watch history are mirrored to
    `Documents\AniBrowser\anibrowser-data.json` (falls back to
    `%USERPROFILE%\AniBrowser` if Documents is OneDrive-synced and stalls)
    so updates and reinstalls don't reset them

Keyboard: `Space` play/pause · `←/→` seek 10s · `F` fullscreen

If sources break (they do, that's why ani-cli updates often), check the
`desktop/scraper.js` regexes against the live site's markup.