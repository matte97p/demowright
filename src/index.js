/**
 * demowright — record polished product demo videos from a script.
 *
 * Public API:
 *   recordDemo(demo, opts)  capture + render in one call → { outputs, demo }
 *   defineDemo(demo)        identity helper for editor autocompletion
 *   runDemo / renderVideo   the two stages, if you want them separately
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { normalizeDemo, defineDemo, estimateDurationMs, STEP_TYPES } from './steps.js'
import { runDemo, recordScenes, recordBackdrop } from './runner.js'
import { renderVideo, remapTime } from './render.js'
import { synthesizeNarration } from './voice.js'
import { detectMarkerRuns, matchScenes } from './marker.js'
import { LOOP_SEC } from './scenes.js'

export { defineDemo, normalizeDemo, runDemo, recordScenes, recordBackdrop, renderVideo, estimateDurationMs, STEP_TYPES }
export { detectMarkerRuns, matchScenes }

/**
 * Capture a demo and render it to MP4(s).
 * @param {object} rawDemo  the demo definition ({ url, steps, ... })
 * @param {object} [opts]   { out, formats, music, workDir, keepRaw, onStep, onAuth, onVoice, onScene, onBackdrop }
 * @returns {Promise<{ outputs: Array<{format,path}>, demo: object }>}
 */
export async function recordDemo(rawDemo, opts = {}) {
  const demo = normalizeDemo(rawDemo)
  const out = opts.out || path.join(process.cwd(), 'output', demo.name + '.mp4')
  const workDir = opts.workDir || path.join(path.dirname(out), '.demowright-tmp')

  const { rawVideoPath, timelapses, narration, scenes } = await runDemo(demo, {
    workDir,
    onStep: opts.onStep,
    onAuth: opts.onAuth,
  })
  const formats = opts.formats && opts.formats.length ? opts.formats : demo.formats

  // Where each scene sits in the capture, read from the frames (marker.js). Over
  // a backdrop, a scene starts its background where the window's loop is at that
  // moment of the final video, so the background does not jump at the cuts.
  const matched = scenes.length ? matchScenes(scenes, await detectMarkerRuns(rawVideoPath)) : []
  const sceneRanges = matched.map((sc) => ({
    ...sc,
    phase: demo.backdrop ? remapTime(sc.start, timelapses) % LOOP_SEC : 0,
  }))

  // Scene clips (recorded once per format, at that format's size, now that their
  // real length is known) and the voiceover (synthesized before rendering, so the
  // lines can be muxed in at their timestamps) do not depend on each other.
  const voiceLines = demo.voice && narration.length
  if (voiceLines && opts.onVoice) opts.onVoice(narration.length)
  // The first failure stops the recordings that have not started, and is the
  // error reported, once everything in flight has settled.
  const stop = new AbortController()
  let first = null
  const guard = (p) =>
    p.catch((err) => {
      if (!first) first = err
      stop.abort()
      throw err
    })
  const settled = await Promise.allSettled([
    guard(recordScenes(demo, sceneRanges, formats, { workDir, onScene: opts.onScene, signal: stop.signal })),
    guard(voiceLines ? synthesizeNarration(narration, demo.voice, workDir) : Promise.resolve([])),
    guard(recordBackdrop(demo, formats, { workDir, onBackdrop: opts.onBackdrop, signal: stop.signal })),
  ])
  if (first) throw first
  const [sceneClips, voiceCues, backdropAssets] = settled.map((r) => r.value)

  const outputs = await renderVideo(rawVideoPath, {
    out,
    formats,
    music: opts.music || demo.music,
    musicVolume: demo.musicVolume,
    fps: demo.fps,
    timelapses,
    narration: voiceCues,
    scenes: sceneRanges,
    sceneClips,
    backdropAssets,
    background: demo.theme.background,
    workDir,
  })

  if (!opts.keepRaw) await rm(workDir, { recursive: true, force: true })
  return { outputs, demo }
}
