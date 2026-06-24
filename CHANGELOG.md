# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Optional voiceover. Set a `voice` block (`openai`, `elevenlabs`, a `synthesize`
  function, or a bare function) and a `say` line on steps; each line is synthesized,
  placed at the moment its step runs, and the music is ducked underneath it.
  `voice.fromCaptions` narrates caption text when no `say` is given. API keys are
  read from the environment by name, never from the config.
- Music polish: fade-in/out and sidechain ducking under narration.
- `demowright run … --dry-run` — validate a config and print the planned timeline
  (length estimate + which lines are narrated) without launching a browser.
- TypeScript type definitions (`index.d.ts`), so `defineDemo`/`recordDemo`/step
  shapes autocomplete in editors.
- Unit tests for the demo schema (validation, defaults, auth/voice normalization).

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
