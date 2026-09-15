# AniBrowser

Personal desktop app for browsing and streaming anime — a GUI equivalent of
[ani-cli](https://github.com/pystardust/ani-cli) using the same source site
(hianime.at) and the same ZokoAnime embed flow.

**Personal use only.** It scrapes unofficial sources, exactly like ani-cli does.

## Install

1. Go to the [Releases page](https://github.com/RichardPersaud/AniBrowser/releases)
2. Under the latest release, download **AniBrowser.Setup.x.y.z.exe** from Assets
   (direct link for v1.0.13:
   [AniBrowser.Setup.1.0.13.exe](https://github.com/RichardPersaud/AniBrowser/releases/download/v1.0.13/AniBrowser.Setup.1.0.13.exe))
3. Run the installer — standard setup with a desktop shortcut

**SmartScreen note:** the installer isn't code-signed, so Windows may warn
*"Windows protected your PC"*. Click **More info → Run anyway** — that's
expected for a self-built app.

Installers aren't committed to the repo because GitHub blocks files over
100MB; every build ships as a release asset instead. Settings, favorites and
watch history survive updates and reinstalls.

### Auto-updates (from v1.0.15 on)

Once installed, AniBrowser keeps itself up to date — you only ever run the
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
8. Already-watched episodes are marked with a ✓ in the episode list; the one
   you stopped on is highlighted as the resume point
9. 🔔 bell in the top bar: when a favorited show releases new episodes, it
   lands in the notifications panel (badge + toast). Favorites are polled
   every 10 minutes; "Mark all seen" dismisses them. Notification state is
   saved with the backup.
10. App version shows in Settings and at the bottom of the sidebar
11. Settings, favorites and watch history are mirrored to
   `Documents\AniBrowser\anibrowser-data.json` (falls back to
   `%USERPROFILE%\AniBrowser` if Documents is OneDrive-synced and stalls)
   so updates and reinstalls don't reset them

Keyboard: `Space` play/pause · `←/→` seek 10s · `F` fullscreen · `N` next episode

## How it works

- `scraper.js` — mirrors ani-cli's flow: search page → episode-list API →
  servers API → ZokoAnime embed → `window.__P` blob (base64 JSON XOR
  `otaku-embed-v1`) → master.m3u8
- `server.js` — local HTTP server (127.0.0.1, random port) serving the UI,
  JSON API, and an HLS proxy that adds the Referer header browsers can't set
- `ui/` — vanilla HTML/CSS/JS with vendored hls.js (no CDN, works offline)

## Rebuild

```
npm install
npm start        # run in dev
npm run dist     # produce dist/AniBrowser Setup x.y.z.exe
npm run release  # build AND publish a draft GitHub release (needs GH_TOKEN)
```

Releasing a new version (so installed apps auto-update):

```
# bump version in package.json first
$env:GH_TOKEN = "<github PAT with repo scope>"   # PowerShell
npm run release
```

electron-builder uploads a **draft** release containing the exe, blockmap and
`latest.yml`. Publish the draft (GitHub web → Releases → Publish, or
`PATCH /repos/RichardPersaud/AniBrowser/releases/<id> {"draft":false}` via
API) — published releases are what installed apps pick up.

If sources break (they do, that's why ani-cli updates often), check the
`scraper.js` regexes against the live site's markup.

## Getting it running on another PC

Requirements:

- **Windows 10/11** (the installer target is NSIS; the app is Windows-only)
- **Node.js 20 LTS or newer** — <https://nodejs.org> (includes npm). Check
  with `node --version`.
- **Git** (optional, only to clone the repo) — <https://git-scm.com>

Steps:

```
git clone <this-repo> anime-player
cd anime-player
npm install
npm start        # run it straight from source
```

`npm install` pulls everything — there are no other runtime dependencies:

- `electron` ^44.3.0 — the desktop shell (downloads its binary on first install)
- `electron-builder` ^26.15.3 — builds the Windows installer
- `ws` ^8.21.3 — used by the scraper's debugging probes
- `hls.js` is vendored at `ui/hls.min.js` (no CDN, works offline)

To build an installer on the new machine: `npm run dist` →
`dist/AniBrowser Setup x.y.z.exe`. Building needs internet access.

Notes:

- Nothing is installed system-wide by `npm start` — it just runs Electron
  from `node_modules`. Only the built installer installs the app.
- The first `npm install` can take a few minutes (Electron's binary is ~100MB).
- `dist/`, `node_modules/` and the scraped `probe/` pages are not in git —
  they're regenerated by the commands above.