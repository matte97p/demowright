# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-02

### Added
- Motion scenes: a `scene` step for full-screen animated cards, with three presets
  (`title`, `list`, `outro`). Each scene is recorded at the size of every requested
  format and swapped in at render time for a stretch of the same length, so titles
  are never cropped and narration does not move. An opening scene also replaces
  the page load at the start of the video.
- Scene cuts are read from the frames: the cover carries a two-cell colour marker
  that the render decodes, instead of trusting the wall clock.
- `caption.style: 'words'` reveals a caption word by word, with `accent` words in
  the theme colour.
- `theme.background`, the base colour of scenes.
- `backdrop`: the capture shown as a browser window (address bar, rounded corners,
  drop shadow) over the animated background. With it, `square` and `vertical`
  show the whole window instead of a crop. The background is a seamless 12 s loop
  recorded once per format.
- `recordScenes`, `recordBackdrop`, `detectMarkerRuns` and `matchScenes` are
  exported, for callers who drive the stages themselves.
- `scripts/frame-check.mjs` and a CI job that render `examples/scenes.config.js`
  and report the frames the real-time recordings dropped.
- `recordDemo(demo, { signal })`: an `AbortSignal` stops the run between two
  steps, cuts the recordings in progress short, skips the ones not started and
  kills a running ffmpeg (`renderVideo` takes the same `signal`). The render
  service uses it on its timeout, and answers only once the render has stopped.
- `DEMOWRIGHT_CPUS` overrides how many CPUs the real-time recordings may use;
  otherwise a container's CPU quota is honoured.

### Changed
- `endcard` is now a `scene` with `preset: 'outro'`: same fields, animated, and
  recorded per format instead of cropped. It still stays on screen to the end of
  the video, whatever steps follow it.
- Without scene clips (`runDemo` + `renderVideo` called by hand), a scene renders
  as a plain card with its title, like the old end card.
- Step timestamps (timelapse ranges, narration cues) are measured from the moment
  the recorded page exists rather than from the browser context, which put them
  0.1 to 0.25 seconds ahead of the video.
- Scene clips, the backdrop and the voiceover are made side by side, as many
  recordings at once as the machine has cores for.
- ffmpeg is looked for in `DEMOWRIGHT_FFMPEG`, then in ffmpeg-static, then on
  the PATH. npm 12 blocks install scripts until they are approved, which leaves
  ffmpeg-static without its binary; with no ffmpeg anywhere the error now says
  how to get one (`npm install-scripts approve ffmpeg-static`).
- A scene must last at least 600 ms, and an unknown format is rejected by
  `normalizeDemo`, before anything is recorded.
- `runDemo`, `recordScenes` and `recordBackdrop` accept a raw demo and normalize
  it themselves.

## [0.1.2] - 2026-08-12

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
