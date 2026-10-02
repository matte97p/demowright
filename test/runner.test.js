import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAll, cpuBudget, followSignal, checkAborted } from '../src/runner.js'

test('runAll returns results in order, plain values included', async () => {
  const c = new AbortController()
  assert.deepEqual(await runAll([async () => 1, () => 2, () => Promise.resolve(3)], c), [1, 2, 3])
  assert.equal(c.signal.aborted, false)
})

test('runAll throws the first error, aborts the rest, and waits for all of them', async () => {
  const c = new AbortController()
  let slowDone = false
  const slow = () => new Promise((r) => setTimeout(() => ((slowDone = true), r('late')), 30))
  await assert.rejects(
    runAll([slow, async () => Promise.reject(new Error('first')), async () => {
      await new Promise((r) => setTimeout(r, 5))
      throw new Error('second')
    }], c),
    /first/
  )
  assert.equal(c.signal.aborted, true)
  assert.equal(slowDone, true)
})

test('DEMOWRIGHT_CPUS overrides the detected CPU budget', () => {
  const prev = process.env.DEMOWRIGHT_CPUS
  process.env.DEMOWRIGHT_CPUS = '3'
  try {
    assert.equal(cpuBudget(), 3)
  } finally {
    if (prev == null) delete process.env.DEMOWRIGHT_CPUS
    else process.env.DEMOWRIGHT_CPUS = prev
  }
  assert.ok(cpuBudget() >= 1)
})

test('followSignal follows, honours an already aborted signal, and detaches', () => {
  const outer = new AbortController()
  const a = followSignal(outer.signal)
  a.release()
  outer.abort(new Error('late'))
  assert.equal(a.controller.signal.aborted, false)

  const b = followSignal(outer.signal)
  assert.equal(b.controller.signal.aborted, true)
  assert.throws(() => checkAborted(b.controller.signal), /late/)
})
