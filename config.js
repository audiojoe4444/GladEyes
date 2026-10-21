/*
 * App configuration. Nothing secret lives here, so it is safe to commit.
 *
 * The Plex TOKEN is deliberately NOT in this file (a GitHub Pages site is public,
 * so anything committed here is world-readable). Pass it once in the launch URL:
 *
 *     https://<you>.github.io/<repo>/#token=YOUR_PLEX_TOKEN
 *
 * The app stores it on the device and strips it from the address bar. See README.
 */
window.PLEX_CONFIG = {
  // OPTIONAL starting address for your Plex Media Server (plex.direct hostnames carry a valid HTTPS
  // certificate, which the glasses need). If it stops working (for example you're away from home) the app asks
  // plex.tv where your server is now, so you can leave this as "" and just sign in with a code.
  // Can be overridden per launch with  #server=https%3A%2F%2F...
  serverUrl: "",

  // Opening a movie library first shows a menu: Continue Watching / Recently Added / Library / Collections.
  // Set to false to go straight to the A-Z list instead.
  movieMenu: true,

  // Every movie and TV library on the server is shown. Names listed here come first, in this order;
  // any others follow in the server's own order. Use [] to just follow the server's order.
  libraryOrder: ["Movies", "TV Shows", "Cartoons"],

  // How long to wait for the server before giving up on a request (seconds).
  requestTimeoutSeconds: 15,

  // How the Plex server transcodes for the glasses (Universal Transcoder).
  playback: {
    // "auto" tries, in order: HLS in the browser -> HLS via hls.js -> progressive MP4,
    // moving on by itself if one fails.  Or force one family:  "hls"  |  "mp4"
    strategy: "auto",
    hlsEngine: "auto",           // "auto" = the browser's own HLS player first. "hlsjs" = try the hls.js library first
    container: "mp4",            // container for the progressive MP4 fallback
    forceTranscode: true,        // true = server always re-encodes to H.264 + AAC stereo (never direct-streams the video)

    // VIDEO QUALITY. Which one is used depends on how the glasses reach your server:
    //   at home (your home network)   -> the home settings: the sharpest picture the display can use
    //   away (remote or Plex relay)   -> the away settings: light and steady, which is what holds up on mobile data
    // Settings > "Video quality at home / away from home" lets you pick another option from the glasses.
    homeResolution: "854x480",   // wider than the glasses' 600-pixel display, so this is as sharp as it can look.
    homeBitrate: 2000,           // (For more: "1280x720" and 4000, if your server can transcode that fast.)
    awayResolution: "480x270",
    awayBitrate: 700,            // kbps
    autoLowerQuality: true,      // at home only: if playback keeps stalling, drop once to the away quality
    rememberQuality: true,       // ...and start the next films at that lighter quality for the next 12 hours

    // Away from home, collect a few seconds of video before playing so a thin link has a cushion.
    prebufferSeconds: 0,         // at home: play at once
    awayPrebufferSeconds: 10,    // away: wait for this many seconds of video (never longer than prebufferMaxSeconds)
    prebufferMaxSeconds: 20,

    seekStepSeconds: 15,
    controlsHideMs: 6000,        // playback controls auto-hide after this long while playing
    startTimeoutSeconds: 45,     // give up on one method (and try the next) if no picture by then
    awayStartTimeoutSeconds: 90, // ...but away from home the server and link are slower to get going
    rebufferSeconds: 10,         // after a stall, wait until this many seconds are stored up before resuming
    rebufferMaxSeconds: 25,      // ...but never wait longer than this
    hlsJsUrl: ""                 // optional: your own hls.js URL. Empty = js/vendor/hls.min.js, then a public CDN
  }
};
