import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCells, runsFromSamples, matchScenes, markerCells, MARKER } from '../src/marker.js'

const RED = [230, 20, 25]
const BLUE = [20, 25, 230]
const DARK = [8, 8, 10]

test('the two markers are the two orders of the same colours', () => {
  assert.deepEqual(markerCells(0), [MARKER.red, MARKER.blue])
  assert.deepEqual(markerCells(1), [MARKER.blue, MARKER.red])
  assert.deepEqual(markerCells(2), markerCells(0))
})

test('cells are classified by colour order, anything else is no marker', () => {
  assert.equal(classifyCells([...RED, ...BLUE]), 0)
  assert.equal(classifyCells([...BLUE, ...RED]), 1)
  assert.equal(classifyCells([...RED, ...RED]), null)
  assert.equal(classifyCells([...DARK, ...BLUE]), null)
  // A saturated brand blue next to a red logo is not the marker.
  assert.equal(classifyCells([200, 60, 60, 24, 119, 242]), null)
})

test('a one-sample miss does not split a run, and noise is dropped', () => {
  const m = [null, 0, 0, null, 0, 0, null, null, null, null, null, null, null, null, null, null, null, 1, null]
  const runs = runsFromSamples(m, 100, { maxGapSec: 0.02, minSec: 0.03 })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].marker, 0)
  assert.ok(Math.abs(runs[0].start - 0.01) < 1e-9 && Math.abs(runs[0].end - 0.06) < 1e-9)
})

test('a run that reaches the last sample is marked toEnd', () => {
  const runs = runsFromSamples([null, 1, 1, 1, 1, 1, 1], 100, { minSec: 0 })
  assert.equal(runs[0].toEnd, true)
})

const scene = (opening = false) => ({ step: { type: 'scene' }, opening })

test('matchScenes widens each cut by a frame on both sides', () => {
  const [r] = matchScenes([scene()], [{ marker: 0, start: 3, end: 5, toEnd: false }])
  assert.ok(Math.abs(r.start - 2.95) < 1e-9 && Math.abs(r.end - 5.05) < 1e-9)
})

test('an opening scene starts at zero, a closing one ends where the capture does', () => {
  const [a, b] = matchScenes([scene(true), scene()], [
    { marker: 0, start: 0.7, end: 2.5, toEnd: false },
    { marker: 1, start: 8, end: 11, toEnd: true },
  ])
  assert.equal(a.start, 0)
  assert.equal(b.end, 11)
  assert.equal(b.toEnd, true)
})

test('two scenes back to back meet exactly, with no overlap and no gap', () => {
  const [a, b] = matchScenes([scene(), scene()], [
    { marker: 0, start: 1, end: 3, toEnd: false },
    { marker: 1, start: 3.04, end: 5, toEnd: false },
  ])
  assert.equal(a.end, b.start)
})

test('a count or colour mismatch is an error, not a silent swap', () => {
  assert.throws(() => matchScenes([scene(), scene()], [{ marker: 0, start: 1, end: 2 }]), /found 1 scene cover\(s\)/)
  assert.throws(() => matchScenes([scene()], [{ marker: 1, start: 1, end: 2 }]), /wrong marker/)
})

test('a cover interrupted by a navigation is still one scene', async () => {
  const { mergeInterrupted } = await import('../src/marker.js')
  const runs = [
    { marker: 0, start: 1, end: 3, toEnd: false },
    { marker: 1, start: 5, end: 7, toEnd: false },
    { marker: 1, start: 7.6, end: 10, toEnd: true },
  ]
  assert.deepEqual(mergeInterrupted(runs), [
    { marker: 0, start: 1, end: 3, toEnd: false },
    { marker: 1, start: 5, end: 10, toEnd: true },
  ])
  const [, sticky] = matchScenes([scene(), scene()], runs)
  assert.equal(sticky.end, 10)
  assert.equal(sticky.toEnd, true)
})
