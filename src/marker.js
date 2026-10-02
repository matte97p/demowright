/**
 * Frame markers: how the render finds the scene stretches in the capture.
 *
 * While a scene plays, the capture shows a cover with two small colour cells in
 * the top-left corner. The render reads those cells from the decoded frames, so
 * every cut lands on the frames themselves instead of on the wall clock, which
 * runs 0.1 to 0.25 s off the video depending on the machine. Consecutive scenes
 * swap the order of the two colours, so two covers back to back stay two runs.
 *
 * The same marker sits on a scene page until its animation starts: the first
 * frame without it is where the scene clip is used from.
 */
import { spawn } from 'node:child_process'
import { ffmpegBin } from './ffmpeg.js'

export const MARKER = { cell: 12, red: '#ff0000', blue: '#0000ff' }

/** The two cell colours of marker `k` (0 or 1), left to right. */
export function markerCells(k) {
  return k % 2 ? [MARKER.blue, MARKER.red] : [MARKER.red, MARKER.blue]
}

const isRed = (r, g, b) => r > 170 && g < 90 && b < 90
const isBlue = (r, g, b) => b > 170 && r < 90 && g < 90

/** Which marker a sampled pair of cells shows (0, 1), or null for none. */
export function classifyCells(px) {
  const [r1, g1, b1, r2, g2, b2] = px
  if (isRed(r1, g1, b1) && isBlue(r2, g2, b2)) return 0
  if (isBlue(r1, g1, b1) && isRed(r2, g2, b2)) return 1
  return null
}

/**
 * Group per-frame markers into runs. `times` is each frame's timestamp (seconds),
 * or a number for evenly spaced samples at that rate. A run ends where the next
 * frame starts. A one-off miss inside a run (a compression artefact) does not
 * split it, and a run shorter than `minSec` is noise.
 * Returns [{ marker, start, end, toEnd }] in seconds.
 */
export function runsFromSamples(markers, times, { maxGapSec = 0.1, minSec = 0.05 } = {}) {
  const at = typeof times === 'number' ? (i) => i / times : (i) => times[i]
  const step = typeof times === 'number' ? 1 / times : typicalStep(times)
  const frameEnd = (i) => (i + 1 < markers.length ? at(i + 1) : at(i) + step)
  const runs = []
  let cur = null
  markers.forEach((m, i) => {
    if (m == null) return
    const t = at(i)
    if (!cur || cur.marker !== m || t - cur.end > maxGapSec) {
      cur = { marker: m, start: t }
      runs.push(cur)
    }
    cur.end = frameEnd(i)
    cur.lastIndex = i
  })
  const videoEnd = markers.length ? frameEnd(markers.length - 1) : 0
  return runs
    .filter((r) => r.end - r.start >= minSec)
    .map((r) => ({ marker: r.marker, start: r.start, end: r.end, toEnd: videoEnd - r.end <= maxGapSec + 1e-9 }))
}

/** Median spacing of the timestamps, the length given to the last frame. */
function typicalStep(times) {
  const d = []
  for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1])
  d.sort((a, b) => a - b)
  return d.length ? d[d.length >> 1] : 0.04
}


/** Average colour of one cell, from an rgb24 frame of the 2-cell corner strip. */
function cellAverage(frame, cellIndex) {
  const c = MARKER.cell
  const inset = 3 // stay off the edges, where compression bleeds one colour into the next
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let y = inset; y < c - inset; y++) {
    for (let x = cellIndex * c + inset; x < (cellIndex + 1) * c - inset; x++) {
      const o = (y * 2 * c + x) * 3
      r += frame[o]
      g += frame[o + 1]
      b += frame[o + 2]
      n++
    }
  }
  return [r / n, g / n, b / n]
}

/**
 * Decode `file` once and return the marker runs it contains, cut on the frames'
 * own timestamps (each frame read once, at the rate it was recorded). `maxSec`
 * stops the decode early, for a clip whose marker can only be at its start.
 */
export function detectMarkerRuns(file, { maxSec, ...runOpts } = {}) {
  const c = MARKER.cell
  // Only the corner strip is converted and read, frame by frame as it arrives;
  // showinfo reports each frame's timestamp on stderr, in the same order.
  const vf = 'crop=' + 2 * c + ':' + c + ':0:0,format=rgb24,showinfo'
  const frameBytes = 2 * c * c * 3
  const limit = maxSec ? ['-t', String(maxSec)] : []
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'info', ...limit, '-i', file, '-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']
    const proc = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const markers = []
    const times = []
    let pending = Buffer.alloc(0)
    let errTail = ''
    let errLine = ''
    proc.stdout.on('data', (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d
      let at = 0
      for (; at + frameBytes <= pending.length; at += frameBytes) {
        const frame = pending.subarray(at, at + frameBytes)
        markers.push(classifyCells([...cellAverage(frame, 0), ...cellAverage(frame, 1)]))
      }
      pending = pending.subarray(at)
    })
    proc.stderr.on('data', (d) => {
      const lines = (errLine + d.toString()).split('\n')
      errLine = lines.pop()
      for (const line of lines) {
        const m = line.match(/\bn:\s*\d+.*\bpts_time:\s*(-?[\d.]+)/)
        if (m) times.push(Number(m[1]))
        else errTail = (errTail + line + '\n').slice(-2000)
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('marker detection failed: ffmpeg exited ' + code + '\n' + errTail))
      if (times.length !== markers.length) {
        return reject(new Error('marker detection: ' + markers.length + ' frames but ' + times.length + ' timestamps'))
      }
      resolve(runsFromSamples(markers, times, runOpts))
    })
  })
}

/**
 * Pair the scene steps of a capture with the covers found in it, in order.
 * An opening scene (the first step) also takes the page load before its cover.
 * Throws when the counts or the colours disagree: a silent mismatch would put
 * one scene where another belongs.
 */
export function matchScenes(scenes, rawRuns) {
  const runs = mergeInterrupted(rawRuns)
  if (runs.length !== scenes.length) {
    throw new Error(
      '[demowright] found ' + runs.length + ' scene cover(s) in the capture, expected ' + scenes.length +
        ': is something drawing over the top-left corner of the page?'
    )
  }
  runs.forEach((run, k) => {
    if (run.marker !== k % 2) throw new Error('[demowright] scene ' + (k + 1) + ' cover has the wrong marker')
  })
  // Each cut is widened by PAD_SEC on both sides: re-timing the capture to the
  // output frame rate can move a boundary by one frame, and that frame would show
  // the cover. The scene clip has frames to spare at its end for this.
  const starts = runs.map((run, k) => (scenes[k].opening ? 0 : Math.max(0, run.start - PAD_SEC)))
  return scenes.map((sc, k) => {
    const run = runs[k]
    // Two scenes back to back: the frames between their covers are the swap, not
    // content, so the first scene runs up to the second.
    const nextStart = starts[k + 1]
    const end = run.toEnd
      ? run.end
      : nextStart != null && nextStart - run.end < BACK_TO_BACK_SEC
        ? nextStart
        : run.end + PAD_SEC
    return { ...sc, start: starts[k], end, toEnd: run.toEnd }
  })
}

/**
 * Consecutive scenes alternate their marker, so two runs in a row with the same
 * marker are one cover interrupted: a page navigation under a sticky end card
 * shows a few frames of the loading page. The scene clip covers the gap too.
 */
export function mergeInterrupted(runs) {
  const out = []
  for (const run of runs) {
    const prev = out[out.length - 1]
    if (prev && prev.marker === run.marker) out[out.length - 1] = { ...prev, end: run.end, toEnd: run.toEnd }
    else out.push({ ...run })
  }
  return out
}

/** Under this gap two covers are one scene change, not a glimpse of the page. */
const BACK_TO_BACK_SEC = 0.2

/** How much each cut is widened, on each side (a bit over one frame at 25 fps). */
const PAD_SEC = 0.05
