import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSceneHtml, escapeHtml, accentSet, FORMAT_SIZES, SCENE_PRESETS } from '../src/scenes.js'

const scene = (over) => ({ type: 'scene', preset: 'title', title: 'Hello world', duration: 2800, ...over })

test('escapeHtml neutralises markup in scene text', () => {
  assert.equal(escapeHtml('<b a="1">&\''), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;')
})

test('a title cannot inject markup into the scene page', () => {
  const html = buildSceneHtml(scene({ title: '<script>alert(1)</script> hi' }), {}, 2800, false)
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
})

test('accent words match regardless of case and punctuation', () => {
  const acc = accentSet('Code. ALWAYS')
  assert.ok(acc.has('code') && acc.has('always'))
  const html = buildSceneHtml(scene({ title: 'Demo as code.', accent: 'code' }), {}, 2800, false)
  assert.match(html, /<span class="w a"[^>]*>code\.<\/span>/)
  assert.match(html, /<span class="w"[^>]*>Demo<\/span>/)
})

test('a scene fades out before its end, unless it closes the video', () => {
  const mid = buildSceneHtml(scene(), {}, 3000, false)
  assert.match(mid, /dw-out 420ms ease 2550ms/)
  const last = buildSceneHtml(scene(), {}, 3000, true)
  assert.ok(!last.includes('.stage{animation:dw-out'))
})

test('animations wait for the runner to start them', () => {
  const html = buildSceneHtml(scene(), {}, 2800, false)
  assert.ok(html.includes('body:not(.go) *{animation-play-state:paused!important}'))
})

test('the list preset renders every item, with or without a hint', () => {
  const html = buildSceneHtml(
    scene({ preset: 'list', items: ['First', { label: 'Second', hint: 'with a hint' }] }),
    {},
    3000,
    false
  )
  assert.equal((html.match(/class="item"/g) || []).length, 2)
  assert.ok(html.includes('<b>First</b>') && html.includes('<small>with a hint</small>'))
})

test('the theme reaches the scene', () => {
  const html = buildSceneHtml(scene(), { accent: '#123456', background: '#010203', font: 'Inter' }, 2800, false)
  assert.ok(html.includes('--accent:#123456') && html.includes('--bg:#010203') && html.includes('font-family:Inter'))
})

test('every format has a size and the presets are the documented three', () => {
  assert.deepEqual(Object.keys(FORMAT_SIZES), ['landscape', 'square', 'vertical'])
  assert.deepEqual(SCENE_PRESETS, ['title', 'list', 'outro'])
})

test('a scene can start its background part way into the loop', () => {
  assert.ok(buildSceneHtml(scene(), {}, 2800, false).includes('--ph:0.000s'))
  const html = buildSceneHtml(scene(), {}, 2800, false, 7.25)
  assert.ok(html.includes('--ph:7.250s'))
  // Every background animation takes the phase into account.
  assert.equal((html.match(/var\(--ph\)/g) || []).length >= 4 + 36, true)
})
