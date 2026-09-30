# Plex for Meta Ray-Ban Display (v4)

A Plex client web app for the Meta Ray-Ban Display glasses. Libraries, list views, movie splash
screens, season/episode browsing, and a fullscreen player. The Plex server does the
transcoding (Universal Transcoder), so the glasses only ever get a simple H.264/AAC stream.

No build step. It is plain HTML, CSS and JavaScript.

## Screens

```
Libraries (every movie and TV library on your server)
  Movie libraries -> A-Z strip + list -> movie splash (title, poster, description, Play) -> player
  TV libraries    -> A-Z strip + list -> seasons -> episodes -> player
```

Music and photo libraries aren't shown (this app plays movies and TV only). The Libraries screen tells you
which ones were left out.

- A small **Back** button sits at the top left of every screen. Move **Up** past the first row or **Left**
  past the list edge to select it. It runs `history.back()`, exactly like the glasses' own Back gesture.
- **Big libraries:** a library with more than 80 titles shows a strip of letters (`# A B C ... Z`) above the
  list. Move **Up** from the first row to reach the strip, **Right/Left** to pick a letter, **Select** to
  show those titles. Each letter shows 100 titles at a time; choose **Show more** at the end for the next 100.
  Going Back from a title returns you to the same letter and row.
- In the player, a small **Controls** pill sits at the bottom of the picture. **Select** opens: **-15s / Play-Pause /
  +15s / Exit**. (If nothing has focus, any Select or arrow press opens them too.) Exit goes back to the movie's
  splash screen (or the episode list for TV). Under the progress bar a stats line shows the playback method,
  quality, seconds buffered and how many times it has stalled.
- The first time a library opens it downloads a compact list of titles (a few seconds for thousands of
  titles) and saves it on the glasses. After that it opens instantly. It refreshes on its own when the
  library changes, or after 6-24 hours.

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
hidden files; use `git` or GitHub Desktop, or create them with **Add file > Create new file**.)

**Updating later using only the GitHub website:** unzip the new version, open your repository,
**Add file > Upload files**, drag in `index.html`, `config.js`, `README.md` and the `css` and `js`
folders, and commit. Files with the same names are replaced. You don't need to touch the hidden files again.
GitHub Pages takes a minute or two to publish. Then on the glasses use the middle tap for the Web App menu and
choose **Restart**. The bottom of the Libraries screen shows the version you're running.

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
| `libraryOrder` | Library names to list first, in this order. Every other movie/TV library follows in the server's order. `[]` = server order |
| `requestTimeoutSeconds` | How long to wait for the server before giving up on one request (15) |
| `playback.strategy` | `"auto"` (default): try every method in turn. Or force `"hls"` or `"mp4"` |
| `playback.videoResolution` / `maxVideoBitrate` | Size and bitrate the server encodes to. Default 480x270 @ 600 kbps: small, but good on a 600-pixel display and light enough for smooth playback. The bitrate is the number that matters most: lower it for fewer stalls, raise it for more detail |
| `playback.hlsEngine` | `"auto"` (default): the browser's own HLS player first. `"hlsjs"`: try the hls.js library first (it handles tiny gaps between video chunks differently, worth a try if you still see very short stalls). The stats line shows which one is running |
| `playback.autoLowerQuality` | If playback keeps stalling (3 times in 90 s) step down to a lighter stream automatically (default on) |
| `playback.rebufferSeconds` / `rebufferMaxSeconds` | With hls.js, after a stall wait for this many seconds to be stored up (10) but never longer than the maximum (25) |
| `playback.forceTranscode` | `true` = always re-encode video (default). `false` lets Plex copy already-compatible video |
| `playback.seekStepSeconds` | The skip size (15) |
| `playback.startTimeoutSeconds` | Give up on one method and try the next if there is no picture by then (45) |
| `playback.hlsJsUrl` | Optional: your own address for the hls.js library |

## How playback works

The Plex server always does the transcoding (`directPlay=0`, and by default `directStream=0`, so video and audio
are both re-encoded to H.264 + stereo AAC). What differs is how the glasses' browser receives it, so the app
tries these in order and moves on by itself if one fails:

1. **HLS in the browser.** Plex's `start.m3u8` playlist, played natively (only tried if the browser says it can).
2. **HLS through hls.js.** The same stream, played through the browser's Media Source API by the open-source
   hls.js library.
3. **Progressive MP4.** `start.mp4`. Seeking restarts the stream at a new offset.

Meta doesn't publish a video codec list for Web Apps, which is why the app adapts instead of assuming.

### hls.js

The app loads hls.js only when it needs it, from `js/vendor/hls.min.js` if you've added it, otherwise from a public CDN
(`cdn.jsdelivr.net`, version 1.5.x). That's a third-party script running on a page that holds your Plex token.
To avoid it, host your own copy:

1. Download `https://cdn.jsdelivr.net/npm/hls.js@1.5/dist/hls.min.js` and save it as `hls.min.js`.
2. In your repository use **Add file > Upload files**, put it in a folder named `js/vendor/`, and commit.

## If video won't play

The player shows a report. It lists what each method did and what the server replied when asked for the
stream, for example:

```
Version 2. What was tried:
HLS (hls.js): manifestLoadError (HTTP 400)
MP4: format not supported
Server replies - HLS: HTTP 400, text/plain | MP4: HTTP 200, video/x-matroska, Matroska/WebM data
```

That last line is the most useful clue: the status, content type and what the data looks like. Things to try:

1. Lower `videoResolution` (`"640x360"`) and `maxVideoBitrate` (`1200`).
2. Set `strategy` to `"hls"` or `"mp4"` to test one method on its own.
3. Check the Plex server can transcode (Plex Web > Settings > Transcoder), and that this movie plays in Plex Web.

## If playback keeps buffering

Watch the stats line under the progress bar (open the controls). A few things it can tell you:

- **buffer stays near 0s and stalls climb:** the stream isn't arriving as fast as it plays. The app lowers the
  quality by itself after three stalls in 90 seconds, and you can lower the defaults in `config.js` too
  (`"480x270"` and `700`).
- **Tiny stalls (fractions of a second) even though the buffer is healthy** are usually small hiccups where one
  video chunk meets the next, not a shortage of data. Lowering the bitrate helps a little; trying
  `hlsEngine: "hlsjs"` in `config.js` is the other thing to test.
- **The server is the bottleneck.** In Plex Web open **Settings > Status > Dashboard** while it plays and look at the
  transcode entry. If its speed is below 1.0x your server can't encode fast enough: use a lower resolution, or turn
  on hardware transcoding (needs Plex Pass) if the server has a supported graphics chip.
- **Try letting Plex copy the video** (`forceTranscode: false`). If your files are already H.264 this uses almost no
  server power, but the video is sent at its original bitrate, which may be too heavy for the glasses' connection.

## Where playback starts

Every play starts at 0:00, even if you stopped part-way through last time. Some HLS players start a stream near its
newest end instead of the beginning, so the app tells the player to start at 0, and if a stream still begins
somewhere else (or jumps ahead in its first 15 seconds) it steps back to the start. When that happens the stats line
says "start fixed (was Ns)". Your own -15s / +15s presses are never overridden.

## About the logo

`icons/plex-icon.png` (the app-grid icon) and `icons/favicon.png` are a bold chevron I drew in Plex's gold,
in the spirit of Plex's own arrow. It isn't Plex's official artwork. If you publish this widely, check Plex's brand
guidelines about using the name and logo in an unofficial app; you may want a different name and mark.

## Away from home

`192-168-4-116...plex.direct` resolves to a private address, so it works only when the glasses (through the
phone) are on your home network. To use it elsewhere, turn on **Remote Access** in Plex, then relaunch with
`#server=` set to the public plex.direct address Plex shows for your server (`https://<ip-with-dashes>.<id>.plex.direct:<port>`).

## Desktop testing

Install Chrome's **Meta Ray-Ban Display Simulator** extension, open the site, and use the on-screen D-pad
(or the arrow keys and Enter). A 600 x 600 window matches the display.

## Files

```
index.html                                page shell
config.js                                 server address, libraries, transcode settings (no secrets)
js/plex.js                                Plex API, library loading and cache, Universal Transcoder URLs
js/app.js                                 screens, navigation, A-Z strip, player and fallbacks
js/vendor/hls.min.js                      optional: your own copy of hls.js (see above)
css/style.css                             theme
.well-known/meta-wearables-manifest.json  app name + icon for the glasses' app grid
icons/                                    app icon (monochrome mask, tinted gold by the glasses) and PNG favicon
.nojekyll                                 lets GitHub Pages serve .well-known
```
