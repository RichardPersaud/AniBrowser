# AniNinja — desktop

Windows desktop app for browsing and streaming anime — a GUI equivalent of
[ani-cli](https://github.com/pystardust/ani-cli) using the same source site
(hianime.at) and the same ZokoAnime embed flow. Built with Electron; the app
itself is a local Node server (`server.js`), the ani-cli-mirroring scraper
(`scraper.js`), and a vanilla-JS UI (`ui/`).

**Personal use only.** It scrapes unofficial sources, exactly like ani-cli does.

> The Android app lives in its own repo now:
> **[RichardPersaud/AniNinja-Mobile](https://github.com/RichardPersaud/AniNinja-Mobile)**
> (Expo/React Native + nodejs-mobile, Google Play distribution). It carries its
> own fork of the node core, so fixes here are ported there deliberately.

## Install

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