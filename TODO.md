# TODO

## Top layer over the base page's interface (noted 2026-10-21, not critical)

With the base page's interface shown (HUD on), the top layer's window covers
the whole map area, so its targets and heat trails are drawn over the base
site's header, panels and cards. A z-index cannot fix it (separate windows).
Idea: the base page reports the rectangles of its opaque interface over the
map (header bar, open cards and dialogs, its data notice) every second or on
change; the top page cuts them out of its map with a CSS mask / clip-path
(evenodd path of the holes). Map-only mode does not need it.

## Releases for others (decided 2026-10-20)

Now: unsigned installer + portable on GitHub Releases (tag v* → draft
release from CI, published by hand); README "Install" explains the browser
and SmartScreen warnings. Later:
- a ZIP of the `dist:local` build (stock electron.exe) as a third file, for
  PCs with Smart App Control on (works on the author's PC, not guaranteed
  elsewhere);
- the README "for personal use" note says it is not a product for others:
  reword it before applying to SignPath (and it reads oddly next to
  downloads anyway);
- SignPath Foundation signing (below).

## CI signing through SignPath Foundation (prepared 2026-10-20)

`.github/workflows/build.yml` builds on every push / PR (unsigned artifacts)
and signs v* tags and manual runs with "sign" once SignPath is set up. Manual
steps, all the author's:

1. Turn on MFA for GitHub (and later SignPath).
2. Apply at https://signpath.org/apply (OSS project, MIT). Their conditions
   that matter here: released and documented software (publish a first
   release, even unsigned, before applying), a code signing policy linked
   from the home page (CODE_SIGNING.md, linked from README), a privacy
   statement (in CODE_SIGNING.md), and data sent to other systems can be
   turned off (the update check can; site pages and Nominatim are what the
   user asks for). The README's "for personal use" note may need softening
   if they object.
3. In SignPath: create the project (slug, e.g. `nebohliad`), add the
   artifact configurations from `.signpath/artifact-configurations/` (slugs
   `app` and `installers`), link the "GitHub.com" trusted build system,
   signing policy `release-signing` (approver: the author). Optionally
   install the SignPath GitHub App.
4. GitHub repo settings: secret `SIGNPATH_API_TOKEN` (a CI user's API token
   with submitter rights), variables `SIGNPATH_ORGANIZATION_ID`,
   `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`.
5. Release: bump `version`, tag `vX.Y.Z` (must match), push the tag, approve
   both signing requests in SignPath (the job waits up to an hour for each),
   then publish the draft release.

Notes: the signer shown by Windows will be "SignPath Foundation", not the
author. The NSIS uninstaller inside the installer stays unsigned (it is
generated inside the installer build; signing it would need SignPath during
electron-builder's run). Whether Smart App Control accepts the signed build
is to be seen.

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

## Later (agreed 2026-10-20)

- **Start with Windows:** a login item that starts minimized to the tray (the
  PC is the hub for the phone).
- **Diagnostics page:** uptime, memory per process, stream resets, last frame
  time, recent log lines (Settings → System).
- **"Update from GitHub" button:** when the version check says "behind",
  `git pull` + `npm run dist:local` for this personal setup.
- **Stream capture memory:** watching costs ~500 MB of GPU memory for the
  page captures (any quality); try `beginFrameSubscription` or capturing only
  the streamed area.
- **macOS:** deferred (no Mac to build and test on).
- **Android without the PC:** a standalone tracking app (hidden WebViews in a
  foreground service); risky (Turnstile in WebView, battery, background
  limits). A small APK wrapper around the stream viewer is the cheap option.