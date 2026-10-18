# TODO

## Update check and auto-update

Tell the user when a new version exists and, ideally, install it in place.

- **Library:** `electron-updater` (same project as electron-builder). It works
  with the NSIS installer build: downloads in the background, verifies, then
  installs on quit or on "Restart now". The portable build cannot update
  itself: for it, only "a new version is available" with a download link.
- **Where updates live (decide first):** electron-builder `publish` config.
  - GitHub Releases: simplest if the repo goes public (see the
    pre-publication review); a private repo needs a token in the app, which
    is not acceptable for a shared build.
  - Any static hosting ("generic" provider): `latest.yml` + installer +
    `.blockmap` uploaded per release (e.g. GitHub Pages, Cloudflare R2, own
    server).
- **Signing matters:** on Windows electron-updater checks that the new
  installer is signed by the same publisher (`publisherName`). With the
  self-signed certificate this works only on PCs that trust it; a public CA
  certificate (or SignPath, if open source) makes it work for everyone. Do not
  disable the check.
- **UX:** check on start and every few hours (and from the ⋯ panel / tray menu:
  "Check for updates"); a non-blocking notice "Version X is ready, restart to
  update"; never restart on its own while the user is watching an alert;
  optional "skip this version"; release notes from the release.
- **Settings to keep across updates:** already in userData; the installer
  keeps it (`deleteAppDataOnUninstall: false`).
- **Release flow:** bump `version`, `npm run dist:signed`, upload/publish
  (electron-builder `--publish always` with the provider configured).
  Delta updates come from the `.blockmap` files.

## LAN video stream: follow-ups

Show the overlay (a selected area, like PiP, or the whole map area) live on a
phone, tablet or TV on the same Wi-Fi, in a browser or VLC. Feasible with what
the app already has: PiP captures both pages with `capturePage` and blends
them; the same frames can be served over the local network.

**Done (2026-10-18):** MJPEG and WebRTC video, snapshots, modes, viewer
with fullscreen / keep-screen-on / home-screen app, alert banner, port
setting, viewer notifications (toasts, browser notifications; drones,
targets, official air alerts) (see README). Still open:

- **Browser notifications on a phone:** need a secure origin (chrome://flags
  "Insecure origins treated as secure" with the stream address) and the
  service worker; untested on a real phone. Toasts work without it.

- **Test on real phones:** on Android the screen stays on (video and MJPEG)
  and the fullscreen button works (verified). Chrome does not install the
  page as an app over plain http (only a shortcut); "Auto ⛶" covers that.
  Still to check: "Auto ⛶" from the shortcut, and iPhone Safari.
- **HLS/RTSP via ffmpeg** for TVs and players that open neither MJPEG nor a
  web page; adds a large external dependency (ffmpeg binary).
- **HTTPS on the LAN** would allow the real Wake Lock API, but needs a
  certificate phones trust (self-signed shows warnings); probably not worth it.
- Share one capture loop between PiP and the stream when both run (PiP is
  1 fps, so the gain is small).
- High quality is capture-bound (~3 fps at 1760 px): capture once per frame
  at the target size instead of full size, or use the GPU for blending.
