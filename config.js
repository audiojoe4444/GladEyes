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
  // Your Plex Media Server. plex.direct hostnames carry a valid HTTPS certificate,
  // which the glasses need (HTTPS pages can't call plain-HTTP servers).
  // Can be overridden per launch with  #server=https%3A%2F%2F...
  serverUrl: "https://192-168-4-116.57fb472612144afbb22b40dfe4cfb2e9.plex.direct:32400",

  // Only these libraries are shown, in this order (matched by name, case-insensitive).
  libraries: ["Movies", "TV Shows", "Cartoons"],

  // How long to wait for the server before giving up on a request (seconds).
  requestTimeoutSeconds: 15,

  // How the Plex server transcodes for the glasses (Universal Transcoder).
  playback: {
    // "auto" tries, in order: HLS in the browser -> HLS via hls.js -> progressive MP4,
    // moving on by itself if one fails.  Or force one family:  "hls"  |  "mp4"
    strategy: "auto",
    container: "mp4",            // container for the progressive MP4 fallback
    videoResolution: "854x480",  // the display is 600x600, so 480p is plenty and light on bandwidth
    maxVideoBitrate: 2000,       // kbps
    forceTranscode: true,        // true = server always re-encodes to H.264 + AAC stereo (never direct-streams the video)
    seekStepSeconds: 15,
    controlsHideMs: 6000,        // playback controls auto-hide after this long while playing
    startTimeoutSeconds: 45,     // give up on one method (and try the next) if no picture by then
    hlsJsUrl: ""                 // optional: your own hls.js URL. Empty = js/vendor/hls.min.js, then a public CDN
  }
};
