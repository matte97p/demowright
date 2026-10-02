/**
 * The capture stage: drive the browser with Playwright while the overlay paints
 * the polish into the same frames Playwright records. Output is a raw .webm.
 */
import { chromium } from 'playwright'
import { mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { buildInitScript } from './overlay.js'
import { buildSceneHtml, buildBackgroundHtml, FORMAT_SIZES, LOOP_SEC, assertFormats } from './scenes.js'
import { backdropGeometry, chromeHtml, maskHtml, shadowHtml } from './backdrop.js'
import { runFfmpeg } from './render.js'
import { normalizeDemo } from './steps.js'
import { detectMarkerRuns } from './marker.js'

const sleep = (page, ms) => page.waitForTimeout(Math.max(0, ms | 0))

/** Real on-screen center of a selector (viewport coords), for genuine hover. */
async function centerOf(page, selector) {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) return null
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function dw(page, fn, ...args) {
  return page.evaluate(
    ([f, a]) => (window.__dw && window.__dw[f] ? window.__dw[f](...a) : false),
    [fn, args]
  )
}

/** type → async executor. Each receives (page, step, demo). */
const EXECUTORS = {
  async caption(page, step) {
    await dw(page, 'caption', step.text, step.hold ? 0 : step.duration, { style: step.style, accent: step.accent })
    if (!step.hold) await sleep(page, step.duration)
  },

  async captionHide(page) {
    await dw(page, 'captionHide')
    await sleep(page, 340)
  },

  async goto(page, step, demo, { held }) {
    await page.goto(step.url, { waitUntil: 'load' })
    await page.waitForFunction(() => !!window.__dw).catch(() => {})
    await dw(page, 'ready')
    // The new page has a fresh overlay: a held end card goes back up at once.
    if (held) await dw(page, 'cover', true, held.sceneIndex, held.step.title, held.step.subtitle || '')
    await sleep(page, 400)
  },

  async move(page, step) {
    if (step.selector) {
      await dw(page, 'cursorToSelector', step.selector, step.duration)
      const c = await centerOf(page, step.selector)
      if (c) await page.mouse.move(c.x, c.y, { steps: 12 })
    } else {
      await dw(page, 'cursorTo', step.x, step.y, step.duration)
      await page.mouse.move(step.x, step.y, { steps: 12 })
    }
    await sleep(page, step.duration + 120)
  },

  async click(page, step) {
    await dw(page, 'cursorToSelector', step.selector, step.duration)
    const c = await centerOf(page, step.selector)
    if (c) await page.mouse.move(c.x, c.y, { steps: 12 })
    await sleep(page, step.duration)
    await dw(page, 'click')
    // .first(): demos often have a selector that legitimately matches more than
    // one node (e.g. a desktop + mobile copy of the same nav). Click the first
    // rather than failing Playwright's strict-mode check.
    await page.locator(step.selector).first().click()
    await sleep(page, step.settle)
  },

  async type(page, step) {
    const loc = page.locator(step.selector).first()
    if (step.clear) await loc.fill('')
    await loc.focus()
    await loc.pressSequentially(step.text, { delay: step.perChar })
    await sleep(page, 250)
  },

  async key(page, step) {
    await page.keyboard.press(step.key)
    await sleep(page, 200)
  },

  // Pick an option in a native <select>. Target by `value`, `label`, or `index`.
  async select(page, step) {
    await dw(page, 'cursorToSelector', step.selector, step.duration)
    const c = await centerOf(page, step.selector)
    if (c) await page.mouse.move(c.x, c.y, { steps: 10 })
    await sleep(page, step.duration)
    const loc = page.locator(step.selector).first()
    if (step.contains != null) {
      // Match the option whose visible text contains a substring, then select
      // by its value — robust to decorated labels (e.g. "Linear · linear.app").
      const value = await loc.evaluate((el, sub) => {
        const o = [...el.options].find((opt) => opt.text.toLowerCase().includes(String(sub).toLowerCase()))
        return o ? o.value : null
      }, step.contains)
      if (value == null) throw new Error('no <option> containing "' + step.contains + '" in ' + step.selector)
      await loc.selectOption(value)
    } else if (step.index != null) await loc.selectOption({ index: step.index })
    else if (step.label != null) await loc.selectOption({ label: step.label })
    else await loc.selectOption(step.value)
    await sleep(page, step.settle)
  },

  async highlight(page, step) {
    await dw(page, 'highlight', step.selector, step.pad)
    if (step.duration) {
      await sleep(page, step.duration)
      await dw(page, 'highlightHide')
      await sleep(page, 260)
    }
  },

  async highlightHide(page) {
    await dw(page, 'highlightHide')
    await sleep(page, 260)
  },

  async zoom(page, step) {
    await dw(page, 'zoom', step.selector, step.scale, step.duration)
    await sleep(page, step.duration + 100)
  },

  async zoomReset(page, step) {
    await dw(page, 'zoomReset', step.duration)
    await sleep(page, step.duration + 100)
  },

  async scroll(page, step) {
    if (step.selector) {
      await page.evaluate(
        (sel) => document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        step.selector
      )
    } else {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), step.y || 0)
    }
    await sleep(page, step.duration)
  },

  async wait(page, step) {
    if (step.selector) {
      await page.waitForSelector(step.selector, { state: 'visible', timeout: step.timeout })
    } else {
      await sleep(page, step.duration)
    }
  },

  // The page is covered while the scene runs; the render stage finds the cover by
  // its marker and swaps it for the scene recorded at each format's size. Once a
  // sticky scene (the end card) has run, the cover stays to the end, through any
  // later scene; so does the cover of the last step.
  async scene(page, step, demo, { last, sceneIndex, next, held }) {
    await dw(page, 'highlightHide')
    await dw(page, 'cover', true, sceneIndex, step.title, step.subtitle || '')
    await sleep(page, step.duration)
    // Back to back with another scene, the page would flash for a frame between.
    const keep = last || step.sticky || held || (next && next.type === 'scene')
    if (!keep) await dw(page, 'cover', false)
  },
}

/**
 * Log in once in a throwaway, non-recorded context and return its storageState
 * (cookies + localStorage). Field values come from env vars referenced by name,
 * so credentials never live in the config or appear in the recording.
 */
async function authenticate(browser, auth, viewport, { locale = null, init = null } = {}) {
  const ctx = await browser.newContext({ viewport, ...(locale ? { locale } : {}) })
  const page = await ctx.newPage()
  if (init) await page.addInitScript(init)
  await page.goto(auth.url, { waitUntil: 'load' })
  for (const f of auth.fields) {
    const value = f.env != null ? process.env[f.env] : f.value
    if (value == null || value === '') {
      throw new Error('auth field "' + f.selector + '" resolved empty (set env ' + (f.env || '') + ')')
    }
    const loc = page.locator(f.selector).first()
    await loc.fill('')
    await loc.pressSequentially(String(value), { delay: auth.perChar })
  }
  await page.click(auth.submit)
  if (auth.waitUrl) await page.waitForURL(auth.waitUrl, { timeout: 30000 })
  else if (auth.waitFor) await page.waitForSelector(auth.waitFor, { state: 'visible', timeout: 30000 })
  else await page.waitForLoadState('networkidle')
  // Best-effort post-login dismissals (e.g. first-run tour) so the recording
  // starts on a clean page. Each is optional — a missing element is ignored.
  for (const sel of auth.after || []) {
    await page.locator(sel).first().click({ timeout: 10000, force: true }).catch(() => {})
  }
  await page.waitForTimeout(500)
  const state = await ctx.storageState()
  await ctx.close()
  return state
}

/**
 * Run a demo (raw or normalized) and return { rawVideoPath }. The caller is
 * responsible for the render stage (render.js) and any cleanup of the work
 * directory. `opts.signal` (an AbortSignal) stops it between two steps.
 */
export async function runDemo(rawDemo, opts = {}) {
  const demo = normalizeDemo(rawDemo)
  const workDir = opts.workDir || path.join(process.cwd(), '.demowright-tmp')
  await mkdir(workDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })

  let storageState
  if (demo.auth) {
    if (opts.onAuth) opts.onAuth()
    storageState = await authenticate(browser, demo.auth, demo.viewport, {
      locale: demo.locale,
      init: demo.init,
    })
  }

  const context = await browser.newContext({
    viewport: demo.viewport,
    deviceScaleFactor: 1,
    recordVideo: { dir: workDir, size: demo.viewport },
    reducedMotion: 'no-preference',
    ...(demo.locale ? { locale: demo.locale } : {}),
    ...(storageState ? { storageState } : {}),
  })
  // The video's first frame is the new page's, not the context's: measured, the
  // context-based clock ran 0.1-0.25 s ahead of the capture. Timelapse ranges and
  // narration cues are second-offsets from this moment; scene cuts do not use the
  // clock at all (see marker.js).
  const page = await context.newPage()
  const recordStart = Date.now()
  await page.addInitScript(buildInitScript(demo.theme))
  if (demo.init) await page.addInitScript(demo.init)

  const log = opts.onStep || (() => {})
  const timelapses = [] // { start, end, factor } in seconds — dead waits to speed up
  const scenes = [] // { step, opening }: in order, matched to the covers in the capture
  const narration = [] // { text, atSec } — voiceover lines, placed at step start
  let held = null // the sticky scene whose cover stays up, once one has run
  let video

  try {
    await page.goto(demo.url, { waitUntil: 'load' })
    await page.waitForFunction(() => !!window.__dw).catch(() => {})
    await dw(page, 'ready')
    await sleep(page, 700)

    for (let i = 0; i < demo.steps.length; i++) {
      const step = demo.steps[i]
      log(i, step)
      // Narration is anchored to the moment the step begins (a caption is voiced
      // as it appears). `say` wins; with voice.fromCaptions a caption's own text
      // is spoken when it has no explicit `say`.
      if (demo.voice) {
        const line =
          step.say != null
            ? step.say
            : step.type === 'caption' && demo.voice.fromCaptions
              ? step.text
              : null
        if (line) narration.push({ text: String(line), atSec: (Date.now() - recordStart) / 1000 })
      }
      const exec = EXECUTORS[step.type]
      // A `wait` may be marked `timelapse: N` to speed that recorded span up N×
      // in the final video (e.g. waiting out a multi-minute audit).
      const tlStart = step.type === 'wait' && step.timelapse > 1 ? (Date.now() - recordStart) / 1000 : null
      const last = i === demo.steps.length - 1
      checkAborted(opts.signal)
      if (step.type === 'scene') {
        // An opening scene also replaces the page load before it, so the video
        // starts on the scene instead of on the white frames of a loading page.
        scenes.push({ step, opening: i === 0 })
      }
      const sceneIndex = scenes.length - 1
      try {
        await exec(page, step, demo, { last, sceneIndex, next: demo.steps[i + 1], held })
      } catch (err) {
        throw new Error('step ' + i + ' (' + step.type + ') failed: ' + err.message)
      }
      // From a sticky scene on, the cover is held: later scenes keep it up, and a
      // navigation puts back the latest one.
      if (step.type === 'scene' && (step.sticky || held)) held = { step, sceneIndex }
      if (tlStart != null) {
        timelapses.push({ start: tlStart, end: (Date.now() - recordStart) / 1000, factor: step.timelapse })
      }
    }
  } finally {
    // Close the context/browser even on failure (flushes the video). Do NOT
    // `return` here — a return inside finally swallows a thrown step error and
    // makes a failed run look successful. Capture the handle and resolve after.
    video = page.video()
    await context.close() // flushes the video file
    await browser.close()
  }
  // Only reached when the step loop completed without throwing.
  if (!video) throw new Error('[demowright] no video was recorded')
  const rawVideoPath = await video.path()
  return { rawVideoPath, workDir, timelapses, narration, scenes }
}

/**
 * How many real-time recordings run at once, across every stage (scenes and the
 * backdrop share it). Each one needs a core to keep its frame rate: on a 4-core
 * CI runner six at once started their videos so late that the start marker was
 * never recorded. Only the recording holds a slot: decoding and encoding run
 * outside it.
 */
const RECORD_SLOTS = Math.max(1, Math.floor(cpuBudget() / 2))

/**
 * CPUs this process may use: the cgroup quota when there is one (a container on
 * Cloud Run sees every core of the host but may use two), else the cores it can
 * run on. DEMOWRIGHT_CPUS overrides both.
 */
export function cpuBudget() {
  const env = Number(process.env.DEMOWRIGHT_CPUS)
  if (Number.isFinite(env) && env >= 1) return env
  return Math.min(availableParallelism(), cgroupCpus() || Infinity)
}

function cgroupCpus() {
  try {
    // cgroup v2: "<quota> <period>" or "max <period>". Read synchronously once, at load.
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/)
    if (quota === 'max') return null
    const n = Number(quota) / Number(period)
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : null
  } catch {
    return null
  }
}

function limiter(n) {
  let active = 0
  const waiting = []
  return async (fn) => {
    if (active >= n) await new Promise((resolve) => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      const next = waiting.shift()
      if (next) next()
    }
  }
}
const recordSlot = limiter(RECORD_SLOTS)

/**
 * Run every job (functions returning promises); on the first failure `controller`
 * is aborted, so the jobs not started yet are skipped, and the first error is
 * the one thrown, once every job has settled, so the browser is never closed
 * under a recording.
 */
export async function runAll(jobs, controller) {
  let first = null
  const results = await Promise.allSettled(
    jobs.map((job) =>
      Promise.resolve()
        .then(job)
        .catch((err) => {
          if (!first) first = err
          controller.abort(new Error('[demowright] stopped: another recording failed'))
          throw err
        })
    )
  )
  if (first) throw first
  return results.map((r) => r.value)
}

/** Throw the abort reason (or a plain "stopped") when `signal` has fired. */
function checkAborted(signal) {
  if (!signal || !signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('[demowright] stopped')
}

/** Start-marker holds tried in turn: a busy machine starts the video later. */
const MARKER_HOLDS_MS = [500, 1500, 3500]

/**
 * Record `html` at `size` for `runMs` after its start, and return { path, offset }:
 * where the start marker ends, the animation begins. If the marker was not
 * recorded (the video started after it was gone), record again holding it longer.
 */
async function recordClip(browser, dir, size, html, runMs, label, signal, onStart) {
  for (const [attempt, hold] of MARKER_HOLDS_MS.entries()) {
    checkAborted(signal)
    const clipPath = await recordSlot(async () => {
      checkAborted(signal)
      // Progress is reported when the recording really starts, not when queued.
      if (onStart && attempt === 0) onStart()
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir, size }, reducedMotion: 'no-preference' })
      const page = await context.newPage()
      await page.setContent(html, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)
      await sleep(page, hold)
      await page.evaluate(() => document.body.classList.add('go'))
      await sleep(page, runMs)
      const video = page.video()
      await context.close()
      return video.path()
    })
    // The marker can only be at the start: decode just past the longest hold.
    const runs = await detectMarkerRuns(clipPath, { minSec: 0, maxSec: hold / 1000 + 4 })
    if (runs.length) return { path: clipPath, offset: runs[0].end }
    await rm(clipPath, { force: true })
  }
  throw new Error('[demowright] ' + label + ': start marker not recorded, even holding it ' + MARKER_HOLDS_MS.at(-1) + ' ms')
}

/**
 * Record every scene once per format, at that format's output size. `scenes` are
 * the ranges matched to the capture (marker.js: { step, start, end, toEnd }),
 * each with an optional `phase` (seconds into the background loop, see scenes.js).
 * Clips record side by side, as many at once as the machine has cores for.
 * `opts.signal` (an AbortSignal) skips what has not started yet.
 * Returns, per format, one { path, offset, length } per scene (seconds): the clip
 * is used from `offset`, the first frame after the animation started.
 */
export async function recordScenes(rawDemo, scenes, formats, opts = {}) {
  const demo = normalizeDemo(rawDemo)
  if (!scenes.length) return {}
  return withStage('scenes', formats, opts, async ({ browser, dir, controller }) => {
    const jobs = formats.flatMap((format) => scenes.map((sc, k) => ({ format, sc, k })))
    const clips = await runAll(
      jobs.map(({ format, sc, k }) => async () => {
        const length = sc.end - sc.start
        // A scene that runs to the end of the video does not fade out.
        const html = buildSceneHtml(sc.step, demo.theme, length * 1000, sc.toEnd, sc.phase || 0)
        const label = 'scene ' + (k + 1) + ' (' + format + ')'
        const onStart = opts.onScene ? () => opts.onScene(format, k) : null
        const clip = await recordClip(browser, dir, FORMAT_SIZES[format], html, length * 1000 + 300, label, controller.signal, onStart)
        return { ...clip, length }
      }),
      controller
    )
    const out = {}
    jobs.forEach((job, i) => {
      out[job.format] = out[job.format] || []
      out[job.format][job.k] = clips[i]
    })
    return out
  })
}

/**
 * Shared set-up of the recording stages: check the formats, make the work
 * subdirectory, follow the caller's signal (already aborted counts too) and
 * close the browser when done.
 */
async function withStage(name, formats, opts, fn) {
  assertFormats(formats)
  const controller = new AbortController()
  const outer = opts.signal
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason)
    else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true })
  }
  checkAborted(controller.signal)
  const dir = path.join(opts.workDir || path.join(process.cwd(), '.demowright-tmp'), name)
  await mkdir(dir, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    return await fn({ browser, dir, controller })
  } finally {
    await browser.close()
  }
}

/**
 * Make what the backdrop needs, once per format: a clean LOOP_SEC loop of the
 * background (recorded, then trimmed to the frames after its start marker) and
 * the chrome, mask and shadow images. Formats are made side by side, sharing the
 * recording slots with the scenes. `opts.signal` skips what has not started yet.
 * Returns, per format, { background, chrome, mask, shadow, geometry }.
 */
export async function recordBackdrop(rawDemo, formats, opts = {}) {
  const demo = normalizeDemo(rawDemo)
  if (!demo.backdrop) return {}
  return withStage('backdrop', formats, opts, async ({ browser, dir, controller }) => {
    const out = {}
    await runAll(
      formats.map((format) => async () => {
        const size = FORMAT_SIZES[format]
        const geometry = backdropGeometry(format, demo.viewport, demo.backdrop)

        // Still images, rendered from HTML with a transparent page.
        const shot = async (name, html, w, h, transparent) => {
          checkAborted(controller.signal)
          const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
          const page = await ctx.newPage()
          await page.setContent(html, { waitUntil: 'load' })
          const file = path.join(dir, format + '-' + name + '.png')
          await page.screenshot({ path: file, omitBackground: transparent })
          await ctx.close()
          return file
        }
        const chrome = await shot('chrome', chromeHtml(geometry, demo.backdrop, demo.theme), geometry.ww, geometry.total, true)
        const mask = await shot('mask', maskHtml(geometry), geometry.ww, geometry.total, false)
        const shadow = await shot('shadow', shadowHtml(geometry), geometry.W, geometry.H, true)

        // The background loop, recorded in real time like a scene, then cut to
        // exactly one loop from its start (the encode runs outside the slot).
        const label = 'backdrop (' + format + ')'
        const onStart = opts.onBackdrop ? () => opts.onBackdrop(format) : null
        const clip = await recordClip(browser, dir, size, buildBackgroundHtml(demo.theme), LOOP_SEC * 1000 + 400, label, controller.signal, onStart)
        const background = path.join(dir, format + '-loop.mp4')
        await runFfmpeg([
          '-y', '-loglevel', 'error', '-ss', clip.offset.toFixed(3), '-i', clip.path, '-t', String(LOOP_SEC),
          '-vf', 'fps=' + demo.fps + ',format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', background,
        ])
        out[format] = { background, chrome, mask, shadow, geometry }
      }),
      controller
    )
    return out
  })
}
