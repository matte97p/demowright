import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeDemo,
  defineDemo,
  estimateDurationMs,
  STEP_TYPES,
} from '../src/steps.js'

const minimal = () => ({ url: 'http://localhost:3000', steps: [{ type: 'caption', text: 'hi' }] })

test('defineDemo is the identity', () => {
  const d = { url: 'x', steps: [] }
  assert.equal(defineDemo(d), d)
})

test('STEP_TYPES covers every executable step kind', () => {
  // A guard against a step type being added in one place but not the other.
  for (const t of ['caption', 'goto', 'click', 'type', 'zoom', 'wait', 'endcard']) {
    assert.ok(STEP_TYPES[t], 'missing ' + t)
  }
})

test('normalizeDemo rejects a non-object', () => {
  assert.throws(() => normalizeDemo(null), /expected a demo object/)
})

test('normalizeDemo requires a url', () => {
  assert.throws(() => normalizeDemo({ steps: [{ type: 'caption', text: 'x' }] }), /"url" is required/)
})

test('normalizeDemo requires non-empty steps', () => {
  assert.throws(() => normalizeDemo({ url: 'x', steps: [] }), /"steps" must be a non-empty array/)
})

test('normalizeDemo rejects an unknown step type', () => {
  assert.throws(
    () => normalizeDemo({ url: 'x', steps: [{ type: 'teleport' }] }),
    /unknown type "teleport"/
  )
})

test('normalizeDemo enforces required fields per step', () => {
  assert.throws(() => normalizeDemo({ url: 'x', steps: [{ type: 'caption' }] }), /missing "text"/)
  assert.throws(() => normalizeDemo({ url: 'x', steps: [{ type: 'click' }] }), /missing "selector"/)
  assert.throws(() => normalizeDemo({ url: 'x', steps: [{ type: 'endcard' }] }), /missing "title"/)
})

test('move needs either selector or x+y', () => {
  assert.throws(() => normalizeDemo({ url: 'x', steps: [{ type: 'move' }] }), /needs either "selector"/)
  assert.doesNotThrow(() => normalizeDemo({ url: 'x', steps: [{ type: 'move', x: 1, y: 2 }] }))
  assert.doesNotThrow(() => normalizeDemo({ url: 'x', steps: [{ type: 'move', selector: 'a' }] }))
})

test('wait needs either duration or selector', () => {
  assert.throws(() => normalizeDemo({ url: 'x', steps: [{ type: 'wait' }] }), /needs either "duration"/)
  assert.doesNotThrow(() => normalizeDemo({ url: 'x', steps: [{ type: 'wait', duration: 500 }] }))
  assert.doesNotThrow(() => normalizeDemo({ url: 'x', steps: [{ type: 'wait', selector: '.done' }] }))
})

test('normalizeDemo applies step defaults without mutating input', () => {
  const raw = minimal()
  raw.steps.push({ type: 'zoom', selector: '.x' })
  const d = normalizeDemo(raw)
  assert.equal(d.steps[0].duration, 2600) // caption default
  assert.equal(d.steps[1].scale, 1.35) // zoom default
  assert.equal(d.steps[1].duration, 750)
  assert.equal(raw.steps[0].duration, undefined, 'input must not be mutated')
})

test('normalizeDemo fills demo-level defaults', () => {
  const d = normalizeDemo(minimal())
  assert.deepEqual(d.viewport, { width: 1280, height: 720 })
  assert.deepEqual(d.formats, ['landscape'])
  assert.equal(d.fps, 30)
  assert.equal(d.musicVolume, 0.18)
  assert.equal(d.name, 'demo')
  assert.equal(d.voice, null)
  assert.equal(d.auth, null)
})

test('explicit demo-level values win over defaults', () => {
  const d = normalizeDemo({
    ...minimal(),
    name: 'mine',
    viewport: { width: 800, height: 600 },
    formats: ['square', 'vertical'],
    fps: 60,
    musicVolume: 0,
  })
  assert.equal(d.name, 'mine')
  assert.deepEqual(d.viewport, { width: 800, height: 600 })
  assert.deepEqual(d.formats, ['square', 'vertical'])
  assert.equal(d.fps, 60)
  assert.equal(d.musicVolume, 0) // 0 must survive (not coerced to the 0.18 default)
})

test('auth block is validated', () => {
  const withAuth = (auth) => normalizeDemo({ ...minimal(), auth })
  assert.throws(() => withAuth({ fields: [{ selector: '#u', env: 'U' }], submit: '#go' }), /auth\.url is required/)
  assert.throws(() => withAuth({ url: '/login', submit: '#go' }), /auth\.fields must list/)
  assert.throws(
    () => withAuth({ url: '/login', fields: [{ selector: '#u' }], submit: '#go' }),
    /needs "env" or "value"/
  )
  assert.throws(() => withAuth({ url: '/login', fields: [{ selector: '#u', env: 'U' }] }), /auth\.submit/)
  const ok = withAuth({ url: '/login', fields: [{ selector: '#u', env: 'U' }], submit: '#go' })
  assert.equal(ok.auth.perChar, 20) // default
  assert.deepEqual(ok.auth.after, [])
})

test('voice block is validated and normalized', () => {
  const withVoice = (voice) => normalizeDemo({ ...minimal(), voice })
  assert.equal(withVoice(undefined).voice, null)
  assert.throws(() => withVoice(42), /"voice" must be an object or a function/)
  assert.throws(() => withVoice({}), /needs a "provider".*or a "synthesize"/)
  assert.equal(withVoice({ provider: 'openai' }).voice.provider, 'openai')
  const fn = async () => Buffer.alloc(0)
  assert.equal(withVoice(fn).voice, fn)
  assert.equal(typeof withVoice({ synthesize: fn }).voice.synthesize, 'function')
})

test('estimateDurationMs grows with content and is roughly additive', () => {
  const small = estimateDurationMs(normalizeDemo(minimal()))
  const big = estimateDurationMs(
    normalizeDemo({
      url: 'x',
      steps: [
        { type: 'caption', text: 'hi', duration: 3000 },
        { type: 'type', selector: '#q', text: 'hello' },
        { type: 'wait', duration: 1000 },
        { type: 'endcard', title: 'End' },
      ],
    })
  )
  assert.ok(big > small)
  assert.ok(small >= 700, 'includes the intro settle')
})
