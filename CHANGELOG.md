# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-22

Initial public release.

### Added
- `demowright run <config.js>` — record a demo from a config, with captions, a
  synthetic cursor, auto-zoom, highlights, and an end card baked into the video.
- `demowright init` — scaffold a starter `demowright.config.js`.
- Step types: `caption`, `captionHide`, `goto`, `move`, `click`, `type`, `key`,
  `highlight`, `highlightHide`, `zoom`, `zoomReset`, `scroll`, `wait`, `endcard`.
- `auth` block — log in once in a throwaway, non-recorded context; credentials
  are read from the environment so they never appear in the config or the video.
- Social crops from a single capture: `landscape`, `square`, `vertical`.
- Library API: `recordDemo`, `defineDemo`.
- Bundled ffmpeg via `ffmpeg-static`; no system dependency beyond Chromium.
