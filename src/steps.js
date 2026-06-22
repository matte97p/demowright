/**
 * Demo schema: validation + normalization.
 *
 * A demo is a plain object: { url, viewport?, theme?, music?, steps: [...] }.
 * Each step is { type, ...fields }. This module is intentionally Playwright-free
 * so it can be unit-tested without a browser — the executors live in runner.js.
 */

/** Default timing (ms) per step kind. Tuned to read well at normal playback. */
const DEFAULTS = {
  caption: { duration: 2600 },
  move: { duration: 650 },
  click: { duration: 650, settle: 280 },
  type: { perChar: 42 },
  select: { duration: 450, settle: 350 },
  highlight: { pad: 8 },
  zoom: { scale: 1.35, duration: 750 },
  zoomReset: { duration: 600 },
  scroll: { duration: 600 },
  endcard: { duration: 2800 },
  wait: { timeout: 30000 },
}

/** Every supported step type and the fields it requires. */
export const STEP_TYPES = {
  caption: { required: ['text'] },
  captionHide: { required: [] },
  goto: { required: ['url'] },
  move: { required: [] }, // selector OR (x,y)
  click: { required: ['selector'] },
  type: { required: ['selector', 'text'] },
  select: { required: ['selector'] }, // + one of: value | label | index
  key: { required: ['key'] },
  highlight: { required: ['selector'] },
  highlightHide: { required: [] },
  zoom: { required: ['selector'] },
  zoomReset: { required: [] },
  scroll: { required: [] }, // selector OR y
  wait: { required: [] }, // duration OR selector
  endcard: { required: ['title'] },
}

function fail(msg) {
  throw new Error('[demowright] invalid demo: ' + msg)
}

/**
 * Validate and return a normalized copy of the demo with defaults applied.
 * Throws an Error with an actionable message on the first problem found.
 */
export function normalizeDemo(demo) {
  if (!demo || typeof demo !== 'object') fail('expected a demo object')
  if (!demo.url || typeof demo.url !== 'string') {
    fail('"url" is required (the page the demo starts on)')
  }
  if (!Array.isArray(demo.steps) || demo.steps.length === 0) {
    fail('"steps" must be a non-empty array')
  }

  const viewport = {
    width: (demo.viewport && demo.viewport.width) || 1280,
    height: (demo.viewport && demo.viewport.height) || 720,
  }

  const steps = demo.steps.map((raw, i) => {
    if (!raw || typeof raw !== 'object') fail('step ' + i + ' is not an object')
    const spec = STEP_TYPES[raw.type]
    if (!spec) {
      fail('step ' + i + ' has unknown type "' + raw.type + '". Valid: ' + Object.keys(STEP_TYPES).join(', '))
    }
    for (const field of spec.required) {
      if (raw[field] == null) fail('step ' + i + ' (' + raw.type + ') is missing "' + field + '"')
    }
    if (raw.type === 'move' && raw.selector == null && (raw.x == null || raw.y == null)) {
      fail('step ' + i + ' (move) needs either "selector" or both "x" and "y"')
    }
    if (raw.type === 'wait' && raw.duration == null && raw.selector == null) {
      fail('step ' + i + ' (wait) needs either "duration" (ms) or "selector"')
    }
    return { ...DEFAULTS[raw.type], ...raw }
  })

  return {
    name: demo.name || 'demo',
    url: demo.url,
    viewport,
    theme: demo.theme || {},
    music: demo.music || null,
    musicVolume: demo.musicVolume == null ? 0.18 : demo.musicVolume,
    formats: demo.formats || ['landscape'],
    fps: demo.fps || 30,
    // Browser UI locale (e.g. 'it-IT') for the recording context.
    locale: demo.locale || null,
    // JS run before the app's own scripts on every page (addInitScript) — for
    // seeding state that must exist at boot, e.g. dismissing a first-run tour.
    init: typeof demo.init === 'string' ? demo.init : null,
    auth: normalizeAuth(demo.auth),
    steps,
  }
}

/**
 * Optional login block. Performed in a throwaway, NON-recorded context to
 * capture an authenticated storageState — so the recording starts already
 * logged in and the password never appears on screen. Field values are read
 * from env at run time (referenced by name) so secrets stay out of the config.
 */
function normalizeAuth(auth) {
  if (!auth) return null
  if (!auth.url) fail('auth.url is required when auth is set')
  if (!Array.isArray(auth.fields) || !auth.fields.length) {
    fail('auth.fields must list the login inputs ({ selector, env|value })')
  }
  for (const f of auth.fields) {
    if (!f.selector) fail('each auth.field needs a "selector"')
    if (f.env == null && f.value == null) fail('auth.field "' + f.selector + '" needs "env" or "value"')
  }
  if (!auth.submit) fail('auth.submit (selector of the login button) is required')
  return {
    url: auth.url,
    fields: auth.fields,
    submit: auth.submit,
    waitFor: auth.waitFor || null,
    waitUrl: auth.waitUrl || null,
    perChar: auth.perChar || 20,
    // Best-effort selectors to click after login, before capturing the session
    // (e.g. dismiss a first-run tour) — so the recording starts on a clean page.
    after: Array.isArray(auth.after) ? auth.after : [],
  }
}

/** Identity helper — gives editors a hook for autocompletion on demo configs. */
export function defineDemo(demo) {
  return demo
}

/** Sum of caption/zoom/wait/etc. durations — a rough estimate of clip length (ms). */
export function estimateDurationMs(demo) {
  let total = 700 // intro settle
  for (const s of demo.steps) {
    if (s.type === 'caption') total += s.duration || 0
    else if (s.type === 'type') total += (s.text ? s.text.length : 0) * (s.perChar || 42) + 300
    else if (s.type === 'wait') total += s.duration || 600
    else if (s.type === 'click' || s.type === 'move') total += (s.duration || 0) + 200
    else if (s.type === 'zoom' || s.type === 'zoomReset' || s.type === 'scroll') total += s.duration || 0
    else if (s.type === 'endcard') total += s.duration || 0
    else total += 250
  }
  return total
}
