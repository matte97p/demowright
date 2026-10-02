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
import ffmpegPath from 'ffmpeg-static'

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
 * Group per-sample markers into runs. A one-off miss inside a run (a compression
 * artefact) does not split it, a run shorter than `minSec` is noise.
 * Returns [{ marker, start, end, toEnd }] in seconds.
 */
export function runsFromSamples(markers, rate, { maxGapSec = 0.1, minSec = 0.05 } = {}) {
  const runs = []
  let cur = null
  markers.forEach((m, i) => {
    if (m == null) return
    const t = i / rate
    if (!cur || cur.marker !== m || t - cur.end > maxGapSec) {
      cur = { marker: m, start: t }
      runs.push(cur)
    }
    cur.end = t + 1 / rate
    cur.lastIndex = i
  })
  const lastSample = markers.length - 1
  return runs
    .filter((r) => r.end - r.start >= minSec)
    .map((r) => ({ marker: r.marker, start: r.start, end: r.end, toEnd: lastSample - r.lastIndex <= Math.ceil(maxGapSec * rate) }))
}

/** Sample rate of the detection pass: 100 per second, so a cut is within 10 ms. */
const RATE = 100

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
 * Decode `file` once and return the marker runs it contains. `maxSec` stops the
 * decode early, for a clip whose marker can only be at its start.
 */
export function detectMarkerRuns(file, { maxSec, ...runOpts } = {}) {
  const c = MARKER.cell
  // Only the corner strip is converted and read, frame by frame as it arrives.
  const vf = 'fps=' + RATE + ':start_time=0,crop=' + 2 * c + ':' + c + ':0:0,format=rgb24'
  const frameBytes = 2 * c * c * 3
  const limit = maxSec ? ['-t', String(maxSec)] : []
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-v', 'error', ...limit, '-i', file, '-vf', vf, '-f', 'rawvideo', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const markers = []
    let pending = Buffer.alloc(0)
    let stderr = ''
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
      stderr += d.toString()
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('marker detection failed: ffmpeg exited ' + code + '\n' + stderr))
      resolve(runsFromSamples(markers, RATE, runOpts))
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
