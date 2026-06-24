/**
 * The render stage: turn the raw .webm Playwright produced into shareable MP4s.
 *
 * Playwright records silent video. Audio is assembled here: an optional looped
 * music track (faded in/out) and optional voiceover lines, each delayed to the
 * moment its step ran and with the music ducked underneath it. Formats are
 * derived with ffmpeg filters so one capture yields landscape (16:9), square
 * (1:1), and vertical (9:16 with a blurred fill) without re-recording.
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

/** Video-filter graph per format. `[v]` is the labelled final video pad. */
const FILTERS = {
  landscape:
    '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v]',
  square: '[0:v]crop=ih:ih:(iw-ih)/2:0,scale=1080:1080,setsar=1[v]',
  vertical:
    '[0:v]split=2[bg][fg];' +
    '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4[bgb];' +
    '[fg]scale=1080:-2[fgs];' +
    '[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v]',
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error('ffmpeg exited ' + code + '\n' + stderr.split('\n').slice(-12).join('\n')))
    })
  })
}

/**
 * Read a clip's duration (seconds) by parsing ffmpeg's own banner — ffmpeg-static
 * ships no ffprobe. Resolves null if it can't be determined (callers degrade
 * gracefully: the music tail-fade is skipped, capture length still governs).
 */
function probeDurationSec(file) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let s = ''
    proc.stderr.on('data', (d) => {
      s += d.toString()
    })
    proc.on('error', () => resolve(null))
    proc.on('close', () => {
      const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
      resolve(m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null)
    })
  })
}

/**
 * Map a raw-capture timestamp (seconds) onto the time-lapsed output timeline, so
 * narration stays in sync after dead-wait ranges are sped up. With no ranges,
 * returns t unchanged.
 */
export function remapTime(t, timelapses) {
  const ranges = (timelapses || [])
    .filter((r) => r && r.factor > 1 && r.end > r.start)
    .sort((a, b) => a.start - b.start)
  let out = 0
  let cursor = 0
  for (const r of ranges) {
    if (t <= r.start) break
    out += r.start - cursor
    const segEnd = Math.min(t, r.end)
    out += (segEnd - r.start) / r.factor
    cursor = segEnd
    if (t <= r.end) return out
  }
  return out + (t - cursor)
}

/**
 * Speed up one or more time ranges of the capture (the "dead waits" — a scrape,
 * an audit running) while leaving the rest at real time. `timelapses` is a list
 * of { start, end, factor } in seconds, relative to the video start. Returns the
 * path to a new intermediate video; the format crops then run on top of it. With
 * no ranges, the original path is returned untouched.
 */
async function applyTimelapse(rawVideoPath, timelapses, workDir, fps) {
  const ranges = (timelapses || [])
    .filter((t) => t && t.factor > 1 && t.end > t.start)
    .sort((a, b) => a.start - b.start)
  if (!ranges.length) return rawVideoPath

  const parts = []
  const labels = []
  let cursor = 0
  let i = 0
  const seg = (expr, label) => {
    parts.push('[0:v]' + expr + '[' + label + ']')
    labels.push('[' + label + ']')
  }
  for (const r of ranges) {
    if (r.start > cursor) {
      seg('trim=start=' + cursor.toFixed(3) + ':end=' + r.start.toFixed(3) + ',setpts=PTS-STARTPTS', 'n' + i)
      i++
    }
    seg(
      'trim=start=' + r.start.toFixed(3) + ':end=' + r.end.toFixed(3) + ',setpts=(PTS-STARTPTS)/' + r.factor,
      'f' + i
    )
    i++
    cursor = r.end
  }
  // tail: from the last range to the end (open-ended trim)
  seg('trim=start=' + cursor.toFixed(3) + ',setpts=PTS-STARTPTS', 'n' + i)

  const filter = parts.join(';') + ';' + labels.join('') + 'concat=n=' + labels.length + ':v=1:a=0[v]'
  await mkdir(workDir, { recursive: true })
  const out = path.join(workDir, 'timelapsed.mp4')
  await runFfmpeg([
    '-y', '-loglevel', 'error', '-i', rawVideoPath,
    '-filter_complex', filter, '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18',
    '-r', String(fps), out,
  ])
  return out
}

/**
 * Append the audio filter chain to `parts` and return the label of the final
 * audio pad (or null if there is no audio). Music is faded in/out; narration
 * cues are each delayed to their moment; when both are present the music is
 * ducked under the narration via a sidechain compressor, then the two are mixed.
 */
function buildAudioGraph(parts, { hasMusic, musicVolume, cues, durationSec, musicInputIndex, voiceStartIndex }) {
  if (!hasMusic && !cues.length) return null

  // Narration: delay each cue to its time, then mix down to one track.
  let narrLabel = null
  if (cues.length) {
    cues.forEach((c, k) => {
      parts.push('[' + (voiceStartIndex + k) + ':a]adelay=delays=' + c.delayMs + ':all=1[nv' + k + ']')
    })
    if (cues.length === 1) {
      narrLabel = '[nv0]'
    } else {
      const ins = cues.map((_, k) => '[nv' + k + ']').join('')
      parts.push(ins + 'amix=inputs=' + cues.length + ':dropout_transition=0:normalize=0[narr]')
      narrLabel = '[narr]'
    }
  }

  if (!hasMusic) return narrLabel // voiceover only

  // Music: set level and fade in; add a tail fade-out if the length is known.
  let music = '[' + musicInputIndex + ':a]volume=' + musicVolume + ',afade=t=in:st=0:d=0.6'
  if (durationSec && durationSec > 1.4) {
    music += ',afade=t=out:st=' + (durationSec - 0.8).toFixed(3) + ':d=0.8'
  }
  music += '[mus]'
  parts.push(music)

  if (!narrLabel) return '[mus]' // music only

  // Duck the music under the narration, then mix the two together.
  parts.push(narrLabel + 'asplit=2[narrout][narrkey]')
  parts.push('[mus][narrkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[musd]')
  parts.push('[musd][narrout]amix=inputs=2:dropout_transition=0:normalize=0[a]')
  return '[a]'
}

function outPathFor(base, format, formats) {
  if (formats.length === 1) return base
  const ext = path.extname(base) || '.mp4'
  const stem = base.slice(0, base.length - ext.length)
  return stem + '.' + format + ext
}

/**
 * Render `rawVideoPath` into one MP4 per requested format.
 * Returns an array of { format, path } for the files written.
 */
export async function renderVideo(rawVideoPath, opts = {}) {
  const formats = opts.formats && opts.formats.length ? opts.formats : ['landscape']
  const base = opts.out || path.join(process.cwd(), 'output', 'demo.mp4')
  const fps = opts.fps || 30
  const workDir = opts.workDir || path.dirname(base)
  await mkdir(path.dirname(base), { recursive: true })

  // Speed up the marked dead-wait ranges once, up front; the format crops then
  // run on top of the time-lapsed intermediate.
  const source = await applyTimelapse(rawVideoPath, opts.timelapses, workDir, fps)

  // Narration cues, with timestamps remapped onto the (post-timelapse) timeline.
  const cues = (opts.narration || []).map((c) => ({
    path: c.path,
    delayMs: Math.max(0, Math.round(remapTime(c.atSec, opts.timelapses) * 1000)),
  }))
  const hasMusic = !!opts.music
  const hasVoice = cues.length > 0
  const musicVolume = opts.musicVolume == null ? 0.18 : opts.musicVolume
  // Capture length caps the output (so looped music / late narration don't run
  // past the video) and positions the music tail-fade.
  const durationSec = hasMusic || hasVoice ? await probeDurationSec(source) : null

  const results = []
  for (const format of formats) {
    const vfilter = FILTERS[format]
    if (!vfilter) throw new Error('[demowright] unknown format "' + format + '" (use landscape|square|vertical)')
    const out = outPathFor(base, format, formats)

    const args = ['-y', '-loglevel', 'error', '-i', source]
    if (hasMusic) args.push('-stream_loop', '-1', '-i', opts.music)
    for (const c of cues) args.push('-i', c.path)

    const parts = [vfilter]
    const audioLabel = buildAudioGraph(parts, {
      hasMusic,
      musicVolume,
      cues,
      durationSec,
      musicInputIndex: 1,
      voiceStartIndex: hasMusic ? 2 : 1,
    })

    args.push('-filter_complex', parts.join(';'), '-map', '[v]')
    if (audioLabel) args.push('-map', audioLabel, '-c:a', 'aac', '-b:a', '128k')
    args.push(
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'medium',
      '-crf', '20',
      '-r', String(fps),
      '-movflags', '+faststart'
    )
    // Cap to the capture length when known; otherwise fall back to -shortest so
    // infinitely-looped music can't run forever.
    if (durationSec) args.push('-t', durationSec.toFixed(3))
    else if (hasMusic) args.push('-shortest')
    args.push(out)

    await runFfmpeg(args)
    results.push({ format, path: out })
  }
  return results
}
