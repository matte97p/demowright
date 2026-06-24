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
import { runDemo } from './runner.js'
import { renderVideo } from './render.js'
import { synthesizeNarration } from './voice.js'

export { defineDemo, normalizeDemo, runDemo, renderVideo, estimateDurationMs, STEP_TYPES }

/**
 * Capture a demo and render it to MP4(s).
 * @param {object} rawDemo  the demo definition ({ url, steps, ... })
 * @param {object} [opts]   { out, formats, music, workDir, keepRaw, onStep, onAuth, onVoice }
 * @returns {Promise<{ outputs: Array<{format,path}>, demo: object }>}
 */
export async function recordDemo(rawDemo, opts = {}) {
  const demo = normalizeDemo(rawDemo)
  const out = opts.out || path.join(process.cwd(), 'output', demo.name + '.mp4')
  const workDir = opts.workDir || path.join(path.dirname(out), '.demowright-tmp')

  const { rawVideoPath, timelapses, narration } = await runDemo(demo, {
    workDir,
    onStep: opts.onStep,
    onAuth: opts.onAuth,
  })

  // Synthesize voiceover (if configured) before rendering, so the lines can be
  // muxed in at their timestamps. No-op when voice is off or there are no lines.
  let voiceCues = []
  if (demo.voice && narration.length) {
    if (opts.onVoice) opts.onVoice(narration.length)
    voiceCues = await synthesizeNarration(narration, demo.voice, workDir)
  }

  const outputs = await renderVideo(rawVideoPath, {
    out,
    formats: opts.formats && opts.formats.length ? opts.formats : demo.formats,
    music: opts.music || demo.music,
    musicVolume: demo.musicVolume,
    fps: demo.fps,
    timelapses,
    narration: voiceCues,
    workDir,
  })

  if (!opts.keepRaw) await rm(workDir, { recursive: true, force: true })
  return { outputs, demo }
}
