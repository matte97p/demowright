#!/usr/bin/env node
/**
 * How many frames does the real-time capture drop on this machine?
 *
 * Scenes and the backdrop loop are recorded in real time, so a slow machine can
 * miss frames: Playwright then repeats the previous one. Their backgrounds move
 * on every frame, so after the start marker an exact repeat of the previous
 * frame is a dropped frame. This renders a config (examples/scenes.config.js by
 * default), counts the repeats in every scene and backdrop clip, and prints a
 * table (also to $GITHUB_STEP_SUMMARY when set).
 *
 *   node scripts/frame-check.mjs [config.js] [--max-dup-percent N]
 *
 * With --max-dup-percent it exits 1 when a clip repeats more than N% of its
 * frames: the signal to move scenes to a deterministic, frame-stepped capture.
 */
import { spawn } from 'node:child_process'
import { appendFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ffmpegBin } from '../src/ffmpeg.js'
import { recordDemo, detectMarkerRuns } from '../src/index.js'

const args = process.argv.slice(2)
const maxIdx = args.indexOf('--max-dup-percent')
const maxDup = maxIdx >= 0 ? Number(args[maxIdx + 1]) : null
if (maxIdx >= 0 && !(Number.isFinite(maxDup) && maxDup >= 0)) {
  console.error('✗ --max-dup-percent needs a number, e.g. --max-dup-percent 15')
  process.exit(2)
}
const configPath = args.find((a, i) => !a.startsWith('--') && (maxIdx < 0 || i !== maxIdx + 1)) || 'examples/scenes.config.js'

/** Per-frame hashes of `file` from `fromSec` on. */
function frameHashes(file, fromSec) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin(), ['-v', 'error', '-ss', fromSec.toFixed(3), '-i', file, '-f', 'framemd5', '-'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0
        ? resolve(out.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim()))
        : reject(new Error('ffmpeg exited ' + code))
    )
  })
}

async function measure(file) {
  const runs = await detectMarkerRuns(file, { minSec: 0 })
  const from = runs.length ? runs[0].end + 0.05 : 0
  const hashes = await frameHashes(file, from)
  let dups = 0
  for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) dups++
  return { frames: hashes.length, dups, pct: hashes.length ? (100 * dups) / hashes.length : 0 }
}

const workDir = path.resolve('.demowright-frame-check')
await rm(workDir, { recursive: true, force: true })
const mod = await import(pathToFileURL(path.resolve(configPath)).href)
const started = Date.now()
await recordDemo(mod.default, { out: path.join(workDir, 'out', 'check.mp4'), workDir, keepRaw: true })
const renderSec = (Date.now() - started) / 1000

const rows = []
for (const sub of ['scenes', 'backdrop']) {
  const dir = path.join(workDir, sub)
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.webm')).sort()
  for (const f of files) rows.push({ clip: sub + '/' + f.slice(0, 13), ...(await measure(path.join(dir, f))) })
}

// Nothing measured is not a pass: the clips moved or were never recorded.
if (!rows.length) {
  console.error('✗ no scene or backdrop clip found in ' + workDir + ': nothing was measured')
  process.exit(1)
}
const worst = rows.reduce((m, r) => Math.max(m, r.pct), 0)
const table = [
  '| clip | frames | repeated | % |',
  '|---|---|---|---|',
  ...rows.map((r) => '| ' + r.clip + ' | ' + r.frames + ' | ' + r.dups + ' | ' + r.pct.toFixed(1) + ' |'),
].join('\n')
const report =
  '### demowright frame check\n\n' + table + '\n\nWorst clip: ' + worst.toFixed(1) + '% repeated frames. Render: ' + renderSec.toFixed(0) + ' s.\n'
console.log(report)
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report)
await rm(workDir, { recursive: true, force: true })
if (maxDup != null && worst > maxDup) {
  console.error('✗ a clip repeats ' + worst.toFixed(1) + '% of its frames (limit ' + maxDup + '%)')
  process.exit(1)
}
