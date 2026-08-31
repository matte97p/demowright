/**
 * demowright render service — a small, self-hostable HTTP server.
 *
 * One render per request. Deployed on Cloud Run with --concurrency=1, which is
 * a HARD SECURITY INVARIANT: BYO API keys arrive per-request and are set onto
 * process.env only for that single render. With one in-flight request per
 * container there is no cross-request key bleed. Raising concurrency above 1
 * BREAKS this isolation model — do not do it.
 *
 * Endpoints:
 *   GET  /health  -> 200 { ok: true, version }     (no auth, info-free, cheap)
 *   POST /render  -> gated by SERVICE_API_KEY (constant-time bearer check)
 *                    body { demo, formats?, music?, voiceKeys? }
 *                    -> recordDemo -> upload mp4(s) to R2 -> { ok, outputs, durationMs }
 *
 * The demo config is the OPERATOR'S OWN code on the OPERATOR'S OWN box
 * (single-tenant self-host) so we do NOT sandbox it. The security budget goes
 * to: key leakage (logs/responses), the concurrency=1 isolation invariant, a
 * fail-closed auth gate, scoped R2 creds, input caps, and temp-file cleanup.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { stat } from 'node:fs/promises'

// server/ lives INSIDE the repo, so import the package by relative path rather
// than its npm name (@matte97p/demowright) to avoid a self-dependency / version
// -skew trap. The Dockerfile copies ../src next to ../server.
import { recordDemo } from '../src/index.js'

import { uploadToR2 } from './r2.js'

// ---------------------------------------------------------------------------
// Config (all from env; no secrets in code)
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8080 // Cloud Run injects PORT — read it.
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || ''
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 2_000_000 // ~2MB; a demo is JSON, not media.
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 3_000_000 // under Cloud Run gen2's 3600s ceiling.

// Env-var NAMES a request is allowed to set for its render. Anything else is
// rejected so a body can never clobber PATH / HOME / R2_* / NODE_OPTIONS / etc.
const DEFAULT_ALLOWED_KEY_ENVS = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY']
const ALLOWED_KEY_ENVS = new Set(
  (process.env.ALLOWED_KEY_ENVS
    ? process.env.ALLOWED_KEY_ENVS.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  ).concat(DEFAULT_ALLOWED_KEY_ENVS)
)

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/
const KNOWN_FORMATS = new Set(['landscape', 'square', 'vertical'])

// Package version for /health (best-effort; never fatal).
let VERSION = '0.0.0'
try {
  const { default: pkg } = await import('./package.json', { with: { type: 'json' } })
  VERSION = pkg.version || VERSION
} catch {
  /* ignore — version is cosmetic */
}

// ---------------------------------------------------------------------------
// Fail-closed startup
// ---------------------------------------------------------------------------

if (!SERVICE_API_KEY) {
  console.error(
    '[demowright-service] FATAL: SERVICE_API_KEY is unset. Refusing to start with an open /render endpoint.'
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Redaction — used by BOTH the logger and the error handler.
// ---------------------------------------------------------------------------

// Mask key-shaped tokens regardless of source. Covers OpenAI (sk-...),
// ElevenLabs (xi-... and bare 32+ hex), and long base64/hex blobs.
const TOKEN_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /xi-[A-Za-z0-9_-]{8,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
]

/**
 * Scrub a string of secrets before it touches stdout or a response.
 * @param {string} text
 * @param {string[]} [liveValues] exact secret values from this request to mask first
 */
function scrub(text, liveValues = []) {
  let s = String(text == null ? '' : text)
  // Also mask the live values of currently-set allowlisted key envs (under
  // concurrency=1 that's the in-flight request's keys). Covers the paths that
  // don't thread liveValues (the top-level catch, or an error before the keys
  // are restored) and short/custom tokens the shape regexes would miss.
  const envVals = [...ALLOWED_KEY_ENVS].map((n) => process.env[n])
  for (const v of [...liveValues, ...envVals]) {
    if (v && typeof v === 'string' && v.length >= 4) s = s.split(v).join('[redacted]')
  }
  for (const re of TOKEN_PATTERNS) s = s.replace(re, '[redacted]')
  return s
}

// ---------------------------------------------------------------------------
// Auth — constant-time, fail-closed
// ---------------------------------------------------------------------------

/** Hash to a fixed length so the compare is constant-time and length is not a leak. */
function fixedDigest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest()
}

const SERVICE_KEY_DIGEST = fixedDigest(SERVICE_API_KEY)

function isAuthorized(req) {
  const auth = req.headers['authorization']
  const xkey = req.headers['x-service-key'] || req.headers['x-api-key']
  let presented = ''
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) presented = auth.slice(7).trim()
  else if (typeof xkey === 'string') presented = xkey.trim()
  if (!presented) return false
  // Equal-length digests; timingSafeEqual still requires equal length.
  return crypto.timingSafeEqual(fixedDigest(presented), SERVICE_KEY_DIGEST)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read the body with a hard byte cap; rejects with {tooLarge:true} past the cap. */
function readBodyCapped(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { tooLarge: true }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Validation — reject unknown top-level fields, validate shapes (NOT the demo's
// own JS; that's the operator's code).
// ---------------------------------------------------------------------------

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'body must be a JSON object'
  }
  const allowedTop = new Set(['demo', 'formats', 'music', 'voiceKeys'])
  for (const k of Object.keys(payload)) {
    if (!allowedTop.has(k)) return 'unknown field "' + k + '"'
  }
  if (!payload.demo || typeof payload.demo !== 'object' || Array.isArray(payload.demo)) {
    return '"demo" (a demowright demo object) is required'
  }
  if (payload.formats != null) {
    if (!Array.isArray(payload.formats) || payload.formats.length === 0) {
      return '"formats" must be a non-empty array'
    }
    for (const f of payload.formats) {
      if (!KNOWN_FORMATS.has(f)) return '"formats" entry "' + f + '" is not landscape|square|vertical'
    }
  }
  if (payload.music != null && typeof payload.music !== 'string') {
    return '"music" must be a string (url or path)'
  }
  if (payload.voiceKeys != null) {
    if (typeof payload.voiceKeys !== 'object' || Array.isArray(payload.voiceKeys)) {
      return '"voiceKeys" must be an object of ENV_NAME -> value'
    }
    for (const [name, val] of Object.entries(payload.voiceKeys)) {
      if (!ENV_NAME_RE.test(name)) return 'voiceKeys name "' + name + '" is not a valid env var name'
      if (!ALLOWED_KEY_ENVS.has(name)) return 'voiceKeys name "' + name + '" is not allowlisted'
      if (typeof val !== 'string' || !val) return 'voiceKeys["' + name + '"] must be a non-empty string'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// BYO-key injection — set allowlisted names onto process.env for ONE render,
// snapshot the prior value, restore in finally so operator deploy-time defaults
// survive a request that also passed a key. Safe ONLY under concurrency=1.
// ---------------------------------------------------------------------------

function applyVoiceKeys(voiceKeys) {
  const prior = new Map()
  for (const [name, value] of Object.entries(voiceKeys || {})) {
    prior.set(name, Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined)
    process.env[name] = value
  }
  return prior
}

function restoreVoiceKeys(prior) {
  for (const [name, value] of prior) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

// ---------------------------------------------------------------------------
// /render handler
// ---------------------------------------------------------------------------

function sanitizeName(name) {
  return String(name || 'demo')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'demo'
}

async function handleRender(req, res) {
  if (!isAuthorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })

  let raw
  try {
    raw = await readBodyCapped(req, MAX_BODY_BYTES)
  } catch (err) {
    if (err && err.tooLarge) return sendJson(res, 413, { ok: false, error: 'payload too large' })
    return sendJson(res, 400, { ok: false, error: 'could not read request body' })
  }

  let payload
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON' })
  }

  const validationError = validatePayload(payload)
  if (validationError) return sendJson(res, 400, { ok: false, error: validationError })

  const { demo, formats, music, voiceKeys = {} } = payload
  // Live secret values from THIS request — scrub these out of any log/response.
  const liveSecrets = Object.values(voiceKeys).filter((v) => typeof v === 'string')

  // Per-request unique workDir + out base so two requests can never share a path.
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'demowright-'))
  const outBase = path.join(workDir, sanitizeName(demo.name) + '.mp4')
  const renderId = path.basename(workDir).replace(/^demowright-/, '')

  const prior = applyVoiceKeys(voiceKeys)
  const startedAt = Date.now()

  // Wall-clock render timeout. recordDemo has no AbortController hook, so we race
  // it; cleanup in finally covers the timed-out path too.
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('render timed out'), { timedOut: true })), RENDER_TIMEOUT_MS)
  })

  try {
    const { outputs } = await Promise.race([
      recordDemo(demo, {
        out: outBase,
        workDir, // keep all artifacts (narration mp3s, raw, final mp4) inside our dir
        formats: Array.isArray(formats) && formats.length ? formats : undefined,
        music: music || undefined,
        keepRaw: true, // we own cleanup in finally; don't let recordDemo rm our dir mid-flight
      }),
      timeout,
    ])
    clearTimeout(timer)

    // Upload each produced mp4 under a server-generated key (never request-derived).
    const uploaded = []
    for (const o of outputs) {
      const ext = path.extname(o.path) || '.mp4'
      const key = 'renders/' + renderId + '/' + o.format + ext
      const url = await uploadToR2(o.path, key, 'video/mp4')
      let bytes = 0
      try {
        bytes = (await stat(o.path)).size
      } catch {
        /* size is best-effort */
      }
      uploaded.push({ format: o.format, url, bytes })
    }

    return sendJson(res, 200, { ok: true, outputs: uploaded, durationMs: Date.now() - startedAt })
  } catch (err) {
    clearTimeout(timer)
    // Scrub before logging AND never echo the upstream message to the client.
    const safe = scrub(err && err.stack ? err.stack : String(err), liveSecrets)
    console.error('[demowright-service] render failed (id=' + renderId + '): ' + safe)
    if (err && err.timedOut) return sendJson(res, 504, { ok: false, error: 'render timed out' })
    // normalizeDemo throws "[demowright] invalid demo: ..." — that text is safe
    // (no secrets) and useful, so surface it as a 400. Everything else is 500.
    const msg = String((err && err.message) || '')
    if (msg.startsWith('[demowright] invalid demo')) {
      return sendJson(res, 400, { ok: false, error: scrub(msg, liveSecrets) })
    }
    return sendJson(res, 500, { ok: false, error: 'render failed' })
  } finally {
    restoreVoiceKeys(prior)
    // Force-remove the per-request dir on EVERY exit path: success, error, timeout.
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const startedAt = Date.now()
  // Access log: method/path/status/duration only — NEVER the body (it has keys).
  res.on('finish', () => {
    console.log(
      '[demowright-service] ' +
        req.method +
        ' ' +
        (req.url || '') +
        ' ' +
        res.statusCode +
        ' ' +
        (Date.now() - startedAt) +
        'ms'
    )
  })

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, version: VERSION })
  }
  if (req.method === 'POST' && req.url === '/render') {
    handleRender(req, res).catch((err) => {
      // Last-resort guard: a handler bug must not leak anything or hang the socket.
      console.error('[demowright-service] unhandled: ' + scrub(err && err.stack ? err.stack : String(err)))
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'render failed' })
    })
    return
  }
  sendJson(res, 404, { ok: false, error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    '[demowright-service] listening on 0.0.0.0:' +
      PORT +
      ' (version ' +
      VERSION +
      '). INVARIANT: deploy with Cloud Run --concurrency=1.'
  )
})
