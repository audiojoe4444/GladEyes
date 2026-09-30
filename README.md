# Plex for Meta Ray-Ban Display

A Plex client web app for the Meta Ray-Ban Display glasses. Libraries, list views, movie splash
screens, season/episode browsing, and a fullscreen player. The Plex server does the
transcoding (Universal Transcoder), so the glasses only ever get a simple H.264/AAC stream.

No build step. It is plain HTML, CSS and JavaScript.

## Screens

```
Libraries (Movies, TV Shows, Cartoons)
  Movies      -> list A-Z -> movie splash (title, poster, description, Play) -> player
  TV Shows /  -> list A-Z -> seasons -> episodes -> player
  Cartoons
```

- A small **Back** button sits at the top left of every screen. Move **Up** past the first row or **Left**
  past the list edge to select it. It runs `history.back()`, exactly like the glasses' own Back gesture.
- In the player, **Select** opens: **-15s / Play-Pause / +15s / Exit**. Exit goes back to the movie's splash
  screen (or the episode list for TV).

## Setup

### 1. Put it on GitHub Pages

The glasses can only load a public **HTTPS** URL, and GitHub Pages provides one for free.

```bash
cd plex-glasses
git init -b main
git add -A            # -A matters: it includes the hidden .nojekyll file and .well-known folder
git commit -m "Plex for Meta Ray-Ban Display"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then on GitHub: **Settings > Pages > Build and deployment > Deploy from a branch > main / (root)**.
Your app will be at `https://<you>.github.io/<repo>/`.

Don't skip the hidden files: `.nojekyll` stops GitHub's Jekyll from hiding `.well-known/`, which holds the
manifest the glasses read for the app name and icon. (GitHub's drag-and-drop web uploader tends to drop
hidden files; use `git` or GitHub Desktop.)

### 2. Your server address

It's already set in `config.js` (`serverUrl`). It is not a secret. Note that a `192.168.x.x` plex.direct
address only works while the glasses' connection can reach your home network (see "Away from home").

### 3. Your Plex token (kept out of the repo)

Everything on GitHub Pages is public, so **never commit your token**. Instead put it on the launch URL, once:

```
https://<you>.github.io/<repo>/#token=YOUR_PLEX_TOKEN
```

On first load the app saves the token on the device and removes it from the address bar. If your server
address ever changes, you can override it the same way: `#token=...&server=https%3A%2F%2F...`.
If the Meta AI app's URL field drops everything after `#`, use `?token=YOUR_PLEX_TOKEN` instead.

Find your token: in Plex Web open any item, **... > Get Info > View XML**, and copy `X-Plex-Token=` from
the address bar. To revoke a token, remove the device under plex.tv > Account > Authorized Devices.

### 4. Add it to the glasses

1. Meta AI app: **Settings > App Info**, tap the version number five times, **Enable** Developer Mode.
   (Needs glasses software v125+ and Meta AI app v272+.)
2. **App Settings > Apps > Web Apps > Connect Web App**, paste the launch URL from step 3, **Save**.
3. Plex appears at the bottom of the glasses' app grid. Pin it if you like.

Use the middle tap for the Web App menu (**Restart / Resume / Permissions**).

## Customising (`config.js`)

| Setting | What it does |
|---|---|
| `libraries` | Which libraries show, and in what order (matched by name) |
| `playback.protocol` | `"http"` = progressive MP4 (default) or `"hls"` |
| `playback.videoResolution` / `maxVideoBitrate` | Size and bitrate the server encodes to |
| `playback.forceTranscode` | `true` = always re-encode video (default). `false` lets Plex copy already-compatible video |
| `playback.seekStepSeconds` | The skip size (15) |

## If video won't play

Meta's docs don't publish a video codec list for Web Apps, so the app requests the safest common target for a
Chromium browser: **H.264 (up to level 4.1) + stereo AAC in MP4**, sent by Plex's Universal Transcoder
(`/video/:/transcode/universal/start.mp4`). If playback fails, the player shows the error and what the
browser reports. Things to try, in order:

1. `protocol: "hls"` in `config.js` (uses the browser's native HLS if present).
2. Lower `videoResolution` (`"640x360"`) and `maxVideoBitrate` (`1200`).
3. In Plex Web: **Settings > Transcoder** and check the transcoder can run on your server.

## Away from home

`192-168-4-116...plex.direct` resolves to a private address, so it works only when the glasses (through the
phone) are on your home network. To use it elsewhere, turn on **Remote Access** in Plex, then relaunch with
`#server=` set to the public plex.direct address Plex shows for your server (`https://<ip-with-dashes>.<id>.plex.direct:<port>`).

## Desktop testing

Install Chrome's **Meta Ray-Ban Display Simulator** extension, open the site, and use the on-screen D-pad
(or the arrow keys and Enter). A 600 x 600 window matches the display.

## Files

```
index.html                              page shell
config.js                               server address, libraries, transcode settings (no secrets)
js/plex.js                              Plex API + Universal Transcoder URLs
js/app.js                               screens, navigation, player
css/style.css                           theme
.well-known/meta-wearables-manifest.json  app name + icon for the glasses' app grid
icons/                                  app icon (monochrome mask) and PNG favicon
.nojekyll                               lets GitHub Pages serve .well-known
```
