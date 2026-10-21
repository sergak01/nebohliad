# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/),
certificate by [SignPath Foundation](https://signpath.org/).

> Status: planned. Until a SignPath Foundation project is approved, builds
> are unsigned (see [README](README.md#install)).

## What is signed

- Only files built from this repository's source by its GitHub Actions
  workflow ([.github/workflows/build.yml](.github/workflows/build.yml)) on
  GitHub-hosted runners: `Nebohliad.exe`, the installer
  `Nebohliad-Setup-<version>.exe` and the portable
  `Nebohliad-<version>-portable.exe`.
- Upstream files shipped with the app (the Electron runtime's DLLs,
  electron-builder's `elevate.exe`) are not re-signed; they come from their
  own projects as they are.
- Every signing request is approved by hand, release by release. Builds of
  pull requests and of ordinary commits are never signed.
- The SignPath artifact configurations are in
  [.signpath/artifact-configurations](.signpath/artifact-configurations).

## Team roles

| Role | Members |
| --- | --- |
| Committers and reviewers | [Serhii Shpak](https://github.com/sergak01) |
| Approvers | [Serhii Shpak](https://github.com/sergak01) |

All team members use multi-factor authentication for GitHub and SignPath.

## Privacy

This program will not transfer any information to other networked systems
unless specifically requested by the user or the person installing or
operating it, with these exceptions:

- It opens two public web pages, map.ukrainealarm.com and
  map.war-monitor.org, as a browser would; those pages load their own
  third-party services (Cloudflare, Google Analytics / Tag Manager,
  OpenFreeMap map tiles).
- Address search sends the typed text to a Nominatim server
  (OpenStreetMap's by default), only when the user searches (presses Enter).
- The newer-version check asks api.github.com for the latest release (and,
  for builds that are not releases, the latest commit) of this repository on
  start and every 6 hours; it can be turned off in the
  settings (System).
- The LAN stream, off by default, accepts connections only from the local
  network and only with a link that carries a key.

No telemetry; locations, settings and search history stay on the PC in
`%APPDATA%\Nebohliad`. See also [README → Privacy](README.md#приватність).
