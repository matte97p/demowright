/**
 * The render stage: turn the raw .webm Playwright produced into shareable MP4s.
 *
 * Playwright records silent video, so audio (if any) is the supplied music track.
 * Formats are derived with ffmpeg filters so one capture yields landscape (16:9),
 * square (1:1), and vertical (9:16 with a blurred fill) without re-recording.
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

/** Video-filter graph per format. `[v]` is the labelled final video pad. */
const FILTERS = {
  landscape: 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v]',
  square: 'crop=ih:ih:(iw-ih)/2:0,scale=1080:1080,setsar=1[v]',
  vertical:
    'split=2[bg][fg];' +
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
  await mkdir(path.dirname(base), { recursive: true })

  // Speed up the marked dead-wait ranges once, up front; the format crops then
  // run on top of the time-lapsed intermediate.
  const source = await applyTimelapse(rawVideoPath, opts.timelapses, opts.workDir || path.dirname(base), fps)

  const results = []
  for (const format of formats) {
    const filter = FILTERS[format]
    if (!filter) throw new Error('[demowright] unknown format "' + format + '" (use landscape|square|vertical)')
    const out = outPathFor(base, format, formats)

    const args = ['-y', '-loglevel', 'error', '-i', source]
    if (opts.music) args.push('-stream_loop', '-1', '-i', opts.music)

    args.push('-filter_complex', filter, '-map', '[v]')
    if (opts.music) {
      const vol = opts.musicVolume == null ? 0.18 : opts.musicVolume
      args.push('-map', '1:a', '-af', 'volume=' + vol, '-c:a', 'aac', '-b:a', '128k')
    }
    args.push(
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'medium',
      '-crf', '20',
      '-r', String(fps),
      '-movflags', '+faststart',
      '-shortest',
      out
    )

    await runFfmpeg(args)
    results.push({ format, path: out })
  }
  return results
}
