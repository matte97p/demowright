# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Motion scenes: a `scene` step for full-screen animated cards, with three presets
  (`title`, `list`, `outro`). Each scene is recorded at the size of every requested
  format and swapped in at render time for a stretch of the same length, so titles
  are never cropped and narration does not move. An opening scene also replaces
  the page load at the start of the video.
- `caption.style: 'words'` reveals a caption word by word, with `accent` words in
  the theme colour.
- `theme.background`, the base colour of scenes.
- `backdrop`: the capture shown as a browser window (address bar, rounded corners,
  drop shadow) over the animated background. With it, `square` and `vertical`
  show the whole window instead of a crop. The background is a seamless 12 s loop
  recorded once per format.
- `scripts/frame-check.mjs` and a CI job that render `examples/scenes.config.js`
  and report the frames the real-time recordings dropped.

- Scene cuts are read from the frames: the cover carries a two-cell colour marker
  that the render decodes, instead of trusting the wall clock.
- `detectMarkerRuns` and `matchScenes` are exported, for callers who drive the two
  stages themselves.

### Changed
- `endcard` is now a `scene` with `preset: 'outro'`: same fields, animated, and
  recorded per format instead of cropped. It still stays on screen to the end of
  the video, whatever steps follow it.
- Without scene clips (`runDemo` + `renderVideo` called by hand), a scene renders
  as a plain card with its title, like the old end card.
- Step timestamps (timelapse ranges, narration cues) are measured from the moment
  the recorded page exists rather than from the browser context, which put them
  0.1 to 0.25 seconds ahead of the video.
- A scene must last at least 600 ms.

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
