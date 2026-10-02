/**
 * The capture stage: drive the browser with Playwright while the overlay paints
 * the polish into the same frames Playwright records. Output is a raw .webm.
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { buildInitScript } from './overlay.js'
import { buildSceneHtml, buildBackgroundHtml, FORMAT_SIZES, LOOP_SEC } from './scenes.js'
import { backdropGeometry, chromeHtml, maskHtml, shadowHtml } from './backdrop.js'
import { runFfmpeg } from './render.js'
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

  async goto(page, step) {
    await page.goto(step.url, { waitUntil: 'load' })
    await page.waitForFunction(() => !!window.__dw).catch(() => {})
    await dw(page, 'ready')
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
  // its marker and swaps it for the scene recorded at each format's size. A
  // sticky scene (the end card) and the last step keep the cover to the end.
  async scene(page, step, demo, { last, sceneIndex, next }) {
    await dw(page, 'highlightHide')
    await dw(page, 'cover', true, sceneIndex, step.title, step.subtitle || '')
    await sleep(page, step.duration)
    // Back to back with another scene, the page would flash for a frame between.
    if (!last && !step.sticky && !(next && next.type === 'scene')) await dw(page, 'cover', false)
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
 * Run a normalized demo and return { rawVideoPath }. The caller is responsible
 * for the render stage (render.js) and any cleanup of the work directory.
 */
export async function runDemo(demo, opts = {}) {
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
      if (step.type === 'scene') {
        // An opening scene also replaces the page load before it, so the video
        // starts on the scene instead of on the white frames of a loading page.
        scenes.push({ step, opening: i === 0 })
      }
      try {
        await exec(page, step, demo, { last, sceneIndex: scenes.length - 1, next: demo.steps[i + 1] })
      } catch (err) {
        throw new Error('step ' + i + ' (' + step.type + ') failed: ' + err.message)
      }
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
 * Record every scene once per format, at that format's output size. `scenes` are
 * the ranges matched to the capture (marker.js: { step, start, end, toEnd }).
 * Formats record side by side; the scenes of one format one after another.
 * Returns, per format, one { path, offset, length } per scene (seconds): the clip
 * is used from `offset`, the first frame after the animation started.
 */
export async function recordScenes(demo, scenes, formats, opts = {}) {
  const out = {}
  if (!scenes.length) return out
  for (const format of formats) {
    if (!FORMAT_SIZES[format]) throw new Error('[demowright] unknown format "' + format + '" (use landscape|square|vertical)')
  }
  const dir = path.join(opts.workDir || path.join(process.cwd(), '.demowright-tmp'), 'scenes')
  await mkdir(dir, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    await Promise.all(
      formats.map(async (format) => {
        const size = FORMAT_SIZES[format]
        const clips = []
        for (let k = 0; k < scenes.length; k++) {
          const sc = scenes[k]
          const length = sc.end - sc.start
          if (opts.onScene) opts.onScene(format, k)
          const context = await browser.newContext({
            viewport: size,
            deviceScaleFactor: 1,
            recordVideo: { dir, size },
            reducedMotion: 'no-preference',
          })
          const page = await context.newPage()
          // A scene that runs to the end of the video does not fade out.
          await page.setContent(buildSceneHtml(sc.step, demo.theme, length * 1000, sc.toEnd), { waitUntil: 'load' })
          await page.evaluate(() => document.fonts.ready)
          // Hold the start marker long enough to be recorded: the video starts a
          // little after the page, and later still with formats recording side by side.
          await sleep(page, 500)
          await page.evaluate(() => document.body.classList.add('go'))
          await sleep(page, length * 1000 + 300)
          const video = page.video()
          await context.close()
          const clipPath = await video.path()
          // The marker sits on the page until `go`: where it ends, the scene starts.
          const runs = await detectMarkerRuns(clipPath, { minSec: 0 })
          if (!runs.length) throw new Error('[demowright] scene ' + (k + 1) + ' (' + format + '): start marker not found')
          clips.push({ path: clipPath, offset: runs[0].end, length })
        }
        out[format] = clips
      })
    )
  } finally {
    await browser.close()
  }
  return out
}

/**
 * Make what the backdrop needs, once per format: a clean LOOP_SEC loop of the
 * background (recorded, then trimmed to the frames after its start marker) and
 * the chrome, mask and shadow images. Formats are made side by side.
 * Returns, per format, { background, chrome, mask, shadow, geometry }.
 */
export async function recordBackdrop(demo, formats, opts = {}) {
  const out = {}
  if (!demo.backdrop) return out
  const dir = path.join(opts.workDir || path.join(process.cwd(), '.demowright-tmp'), 'backdrop')
  await mkdir(dir, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    await Promise.all(
      formats.map(async (format) => {
        const size = FORMAT_SIZES[format]
        if (!size) throw new Error('[demowright] unknown format "' + format + '" (use landscape|square|vertical)')
        if (opts.onBackdrop) opts.onBackdrop(format)
        const geometry = backdropGeometry(format, demo.viewport, demo.backdrop)

        // Still images, rendered from HTML with a transparent page.
        const shot = async (name, html, w, h, transparent) => {
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

        // The background loop, recorded in real time like a scene.
        const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, recordVideo: { dir, size } })
        const page = await context.newPage()
        await page.setContent(buildBackgroundHtml(demo.theme), { waitUntil: 'load' })
        await sleep(page, 500)
        await page.evaluate(() => document.body.classList.add('go'))
        await sleep(page, LOOP_SEC * 1000 + 400)
        const video = page.video()
        await context.close()
        const raw = await video.path()
        const runs = await detectMarkerRuns(raw, { minSec: 0 })
        if (!runs.length) throw new Error('[demowright] backdrop (' + format + '): start marker not found')
        const background = path.join(dir, format + '-loop.mp4')
        await runFfmpeg([
          '-y', '-loglevel', 'error', '-ss', runs[0].end.toFixed(3), '-i', raw, '-t', String(LOOP_SEC),
          '-vf', 'fps=' + (demo.fps || 30) + ',format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', background,
        ])
        out[format] = { background, chrome, mask, shadow, geometry }
      })
    )
  } finally {
    await browser.close()
  }
  return out
}
