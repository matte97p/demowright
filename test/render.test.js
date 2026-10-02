import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildVideoGraph, remapTime } from '../src/render.js'

const graph = (segments, format = 'landscape') => buildVideoGraph(format, segments, 30).join(';')

test('without scenes the graph is the plain format crop', () => {
  const parts = buildVideoGraph('square', [], 30)
  assert.equal(parts.length, 1)
  assert.match(parts[0], /\[v\]$/)
})

test('a scene in the middle splits the capture around it', () => {
  const g = graph([{ start: 4, end: 7, input: 1, offset: 0.4 }])
  assert.match(g, /split=2\[c0\]\[c1\]/)
  assert.match(g, /\[c0\]trim=start=0\.000:end=4\.000/)
  assert.match(g, /\[1:v\]trim=start=0\.400:duration=3\.000/)
  assert.match(g, /\[c1\]trim=start=7\.000,setpts/)
  assert.match(g, /concat=n=3:v=1:a=0\[v\]$/)
})

test('an opening scene replaces the start, with no capture before it', () => {
  const g = graph([{ start: 0, end: 3, input: 2, offset: 0.3 }])
  assert.ok(!/split=/.test(g))
  assert.match(g, /\[p0\]\[p1\]concat=n=2/)
  assert.match(g, /\[2:v\]trim/)
})

test('a closing scene leaves no empty tail after it', () => {
  const g = graph([{ start: 10, end: 13, input: 1, offset: 0.3, toEnd: true }])
  assert.match(g, /concat=n=2/)
  assert.ok(!/trim=start=13\.000,setpts/.test(g))
})

test('a capture made only of scenes does not leave the crop unconnected', () => {
  const g = graph([{ start: 0, end: 3, input: 1, offset: 0.3, toEnd: true }])
  assert.ok(!g.includes('[0:v]'))
  assert.match(g, /concat=n=1/)
})

test('scene clips are scaled to the format size', () => {
  assert.match(graph([{ start: 1, end: 2, input: 1, offset: 0 }], 'vertical'), /scale=1080:1920/)
})

test('an unknown format is rejected', () => {
  assert.throws(() => buildVideoGraph('cinema', [], 30), /unknown format "cinema"/)
})

test('covers left in place get their marker painted over, before the crop', () => {
  const g = buildVideoGraph('square', [], 30, { masks: [{ start: 1, end: 2.5 }], background: '#101010' }).join(';')
  assert.match(g, /^\[0:v\]drawbox=x=0:y=0:w=24:h=12:color=0x101010:t=fill:enable='between\(t,1\.000,2\.500\)',crop=/)
})

test('remapTime keeps a scene after a timelapse on the sped-up timeline', () => {
  assert.equal(remapTime(20, [{ start: 5, end: 15, factor: 5 }]), 12)
})
