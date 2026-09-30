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
    maxVideoBitrate: 600,        // kbps the very first film starts at (600 = 480x270). The app then adjusts by itself and remembers
    forceTranscode: true,        // true = server always re-encodes to H.264 + AAC stereo (never direct-streams the video)
    seekStepSeconds: 15,
    controlsHideMs: 6000,        // playback controls auto-hide after this long while playing
    startTimeoutSeconds: 45,     // give up on one method (and try the next) if no picture by then
    relayBitrate: 400,           // where a first-ever film starts when connected through Plex's relay (slow)
    autoLowerQuality: true,      // if playback keeps stalling, step down to a lighter stream automatically
    autoRaiseQuality: true,      // after a good stretch without stalls, try one step up (and go back at once if that stalls)
    autoRaiseUpToKbps: 1200,     // ...but never above this (1200 = 640x360, plenty for the glasses' 600-pixel display)
    raiseAfterSeconds: 150,      // how long playback must be smooth before trying a step up
    raiseBufferSeconds: 4,       // ...and how many seconds must be stored up ahead at that moment
    rememberQuality: true,       // remember what worked for home / remote / relay, so the next film starts there
    rebufferSeconds: 10,         // after a stall, wait until this many seconds are stored up before resuming
    rebufferMaxSeconds: 25,      // ...but never wait longer than this
    hlsJsUrl: ""                 // optional: your own hls.js URL. Empty = js/vendor/hls.min.js, then a public CDN
  }
};
