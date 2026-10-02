import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBackdrop, backdropGeometry, chromeHtml, backdropChain } from '../src/backdrop.js'
import { buildVideoGraph } from '../src/render.js'
import { normalizeDemo } from '../src/steps.js'

const fail = (msg) => {
  throw new Error(msg)
}
const vp = { width: 1280, height: 720 }

test('backdrop is off unless asked for, and true means the defaults', () => {
  assert.equal(normalizeBackdrop(undefined, 'http://x', fail), null)
  assert.equal(normalizeBackdrop(false, 'http://x', fail), null)
  assert.deepEqual(normalizeBackdrop(true, 'https://app.example.com/path', fail), { frame: 'browser', scale: 0.86, url: 'app.example.com' })
})

test('the address bar shows the host only for web urls', () => {
  assert.equal(normalizeBackdrop(true, 'file:///tmp/site/index.html', fail).url, '')
  assert.equal(normalizeBackdrop({ url: 'myapp.com' }, 'file:///x', fail).url, 'myapp.com')
})

test('a bad frame or scale is rejected', () => {
  assert.throws(() => normalizeBackdrop({ frame: 'phone' }, 'http://x', fail), /backdrop.frame/)
  assert.throws(() => normalizeBackdrop({ scale: 1.4 }, 'http://x', fail), /backdrop.scale/)
})

test('normalizeDemo carries the backdrop', () => {
  const d = normalizeDemo({ url: 'https://a.com', backdrop: true, steps: [{ type: 'caption', text: 'x' }] })
  assert.equal(d.backdrop.url, 'a.com')
})

for (const format of ['landscape', 'square', 'vertical']) {
  test('the window fits, keeps the capture aspect and is centered (' + format + ')', () => {
    const b = normalizeBackdrop(true, 'http://x', fail)
    const g = backdropGeometry(format, vp, b)
    for (const k of ['ww', 'wh', 'hb', 'x', 'y']) assert.equal(g[k] % 2, 0, k + ' must be even')
    assert.ok(g.ww <= g.W * b.scale + 2 && g.total <= g.H * b.scale + 2)
    assert.ok(Math.abs(g.ww / g.wh - 16 / 9) < 0.01)
    assert.ok(Math.abs(g.x * 2 + g.ww - g.W) <= 2 && Math.abs(g.y * 2 + g.total - g.H) <= 2)
  })
}

test('frame: none has no address bar', () => {
  const g = backdropGeometry('landscape', vp, normalizeBackdrop({ frame: 'none' }, 'http://x', fail))
  assert.equal(g.hb, 0)
  assert.equal(g.total, g.wh)
})

test('the address bar text cannot inject markup', () => {
  const b = normalizeBackdrop({ url: '<img src=x onerror=alert(1)>' }, 'http://x', fail)
  const html = chromeHtml(backdropGeometry('landscape', vp, b), b, {})
  assert.ok(!html.includes('<img'))
})

test('with a backdrop the capture is composed, not cropped', () => {
  const b = normalizeBackdrop(true, 'http://x', fail)
  const geometry = backdropGeometry('square', vp, b)
  const inputs = { bg: 3, chrome: 4, mask: 5, shadow: 6 }
  const g = buildVideoGraph('square', [], 30, { backdrop: { geometry, inputs } }).join(';')
  assert.ok(!g.includes('crop=ih:ih'))
  assert.match(g, /\[3:v\]scale=1080:1080/)
  assert.match(g, /alphamerge/)
  assert.match(g, /overlay=\d+:\d+:shortest=1/)
})

test('the marker paint runs before the capture is scaled into the window', () => {
  const b = normalizeBackdrop(true, 'http://x', fail)
  const chain = backdropChain(backdropGeometry('landscape', vp, b), { bg: 1, chrome: 2, mask: 3, shadow: 4 }, 30, 'drawbox=x=0')
  assert.match(chain, /^\[0:v\]drawbox=x=0,scale=/)
})
