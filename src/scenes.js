/**
 * Motion scenes: full-screen animated cards (an intro title, a list, an outro).
 *
 * A scene is a self-contained HTML page with CSS animations. It is recorded by
 * Playwright like the product itself, once per output format at that format's
 * exact size, so a centered title is never cropped by the square or vertical
 * derivation. This module only builds the markup: it is browser-free, so it can
 * be unit-tested, and the runner decides when and where to record it.
 *
 * The animations are paused until the runner adds `go` to <body>. Until then the
 * page also shows the frame marker (see marker.js): the first frame without it is
 * where the render starts using the clip, so the white frames Playwright records
 * while the page loads never reach the video.
 */
import { MARKER, markerCells } from './marker.js'

/** Output size of each format, in pixels. The render stage uses the same table. */
export const FORMAT_SIZES = {
  landscape: { width: 1280, height: 720 },
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1920 },
}

export const SCENE_PRESETS = ['title', 'list', 'outro']

const DEFAULT_BG = '#07070a'
const DEFAULT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Lower-case a word and strip the punctuation around it, for accent matching. */
const bare = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

/** The words of `text` to colour with the accent: any word that appears in `accent`. */
export function accentSet(accent) {
  return new Set(String(accent || '').split(/\s+/).map(bare).filter(Boolean))
}

/** `text` as one span per word, each with its reveal delay (ms). */
function words(text, accent, startMs, stepMs) {
  const acc = accentSet(accent)
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const cls = acc.has(bare(w)) ? 'w a' : 'w'
      return '<span class="' + cls + '" style="animation-delay:' + (startMs + i * stepMs) + 'ms">' + escapeHtml(w) + '</span>'
    })
    .join(' ')
}

/** Deterministic pseudo-random numbers, so a re-render is identical. */
function rand(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

function particles(n) {
  let out = ''
  for (let i = 0; i < n; i++) {
    const style =
      'left:' + (rand(i + 1) * 100).toFixed(2) + '%;' +
      'top:' + (rand(i + 101) * 100).toFixed(2) + '%;' +
      'width:calc(' + (2 + rand(i + 201) * 3).toFixed(1) + ' * var(--u));' +
      'opacity:' + (0.1 + rand(i + 301) * 0.25).toFixed(2) + ';' +
      'animation-duration:' + (9 + rand(i + 401) * 8).toFixed(1) + 's;' +
      'animation-delay:-' + (rand(i + 501) * 8).toFixed(1) + 's'
    out += '<i class="p" style="' + style + '"></i>'
  }
  return out
}

function itemsHtml(items, startMs) {
  return items
    .map((it, i) => {
      const label = typeof it === 'string' ? it : it.label
      const hint = typeof it === 'string' ? '' : it.hint
      return (
        '<div class="item" style="animation-delay:' + (startMs + i * 140) + 'ms">' +
        '<span class="dot"></span>' +
        '<span class="txt"><b>' + escapeHtml(label) + '</b>' +
        (hint ? '<small>' + escapeHtml(hint) + '</small>' : '') +
        '</span></div>'
      )
    })
    .join('')
}

function subtitle(scene, delayMs) {
  if (!scene.subtitle) return ''
  return '<p class="sub" style="animation-delay:' + delayMs + 'ms">' + escapeHtml(scene.subtitle) + '</p>'
}

function body(scene) {
  const titleWords = String(scene.title).split(/\s+/).filter(Boolean).length
  if (scene.preset === 'outro') {
    return '<h1 class="outro">' + escapeHtml(scene.title) + '</h1>' + subtitle(scene, 520)
  }
  if (scene.preset === 'list') {
    const after = 200 + titleWords * 90 + 160
    return (
      '<h2>' + words(scene.title, scene.accent, 200, 90) + '</h2>' +
      subtitle(scene, after) +
      '<div class="items">' + itemsHtml(scene.items || [], after + (scene.subtitle ? 260 : 0)) + '</div>'
    )
  }
  return '<h1>' + words(scene.title, scene.accent, 200, 110) + '</h1>' + subtitle(scene, 320 + titleWords * 110)
}

/**
 * Full HTML document for one scene.
 * @param {object} scene  normalized scene step ({ preset, title, subtitle?, accent?, items? })
 * @param {object} theme  demo theme ({ accent?, font?, background? })
 * @param {number} durationMs  how long the scene lasts in the final video
 * @param {boolean} last  the last scene of the video does not fade out
 */
export function buildSceneHtml(scene, theme, durationMs, last) {
  const t = theme || {}
  const accent = t.accent || '#e91e63'
  const bg = t.background || DEFAULT_BG
  const font = t.font || DEFAULT_FONT
  const exitAt = Math.max(0, durationMs - 450)
  const exit = last ? '' : '.stage{animation:dw-out 420ms ease ' + exitAt + 'ms forwards}'

  const css = `
:root{--u:calc(min(100vw,100vh)/1080);--accent:${accent};--bg:${bg};--ease:cubic-bezier(0.22,0.61,0.36,1)}
*{box-sizing:border-box;margin:0}
html,body{width:100%;height:100%;overflow:hidden;background:var(--bg);color:#f5f7fa;font-family:${font}}
body:not(.go) *{animation-play-state:paused!important}
.mk{position:fixed;left:0;top:0;display:flex;z-index:9}.mk i{width:${MARKER.cell}px;height:${MARKER.cell}px}
body.go .mk{display:none}
.bg,.grid,.vig{position:absolute;inset:0}
.blob{position:absolute;width:85vmax;height:85vmax;border-radius:50%;animation:dw-drift 16s ease-in-out infinite alternate}
.b1{left:45%;top:-30%;background:radial-gradient(circle,color-mix(in srgb,var(--accent) 30%,transparent) 0%,transparent 65%)}
.b2{left:-35%;top:25%;background:radial-gradient(circle,rgba(124,58,237,.22) 0%,transparent 65%);animation-delay:-6s}
.b3{left:20%;top:55%;background:radial-gradient(circle,rgba(37,99,235,.16) 0%,transparent 65%);animation-delay:-11s}
.grid{background-image:linear-gradient(rgba(255,255,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px);background-size:calc(72*var(--u)) calc(72*var(--u));animation:dw-grid 20s linear infinite;-webkit-mask-image:radial-gradient(ellipse at 50% 50%,#000 20%,transparent 75%)}
.p{position:absolute;aspect-ratio:1;border-radius:50%;background:#fff;animation:dw-float linear infinite}
.vig{background:radial-gradient(ellipse at 50% 50%,transparent 45%,rgba(0,0,0,.6) 100%)}
.stage{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:calc(26*var(--u));padding:0 7vw;text-align:center}
h1,h2{font-weight:800;letter-spacing:-.02em;line-height:1.1}
h1{font-size:calc(86*var(--u));max-width:92vw}
h2{font-size:calc(60*var(--u))}
.w{display:inline-block;opacity:0;animation:dw-word 640ms var(--ease) forwards}
.a{color:var(--accent)}
.sub{font-size:calc(30*var(--u));font-weight:600;color:var(--accent);opacity:0;animation:dw-rise 600ms var(--ease) forwards}
.outro{font-size:calc(100*var(--u));opacity:0;animation:dw-pop 900ms var(--ease) 120ms forwards}
.items{display:flex;flex-direction:column;gap:calc(16*var(--u));width:min(88vw,calc(820*var(--u)));margin-top:calc(10*var(--u))}
.item{display:flex;align-items:center;gap:calc(22*var(--u));text-align:left;padding:calc(20*var(--u)) calc(28*var(--u));border-radius:calc(20*var(--u));background:linear-gradient(120deg,#1b1b22,#121217);border:1px solid rgba(255,255,255,.1);box-shadow:0 calc(16*var(--u)) calc(40*var(--u)) rgba(0,0,0,.45);opacity:0;animation:dw-slide 620ms var(--ease) forwards}
.dot{flex:none;width:calc(12*var(--u));aspect-ratio:1;border-radius:50%;background:var(--accent);box-shadow:0 0 calc(14*var(--u)) var(--accent)}
.txt b{display:block;font-size:calc(30*var(--u));font-weight:700}
.txt small{display:block;font-size:calc(22*var(--u));color:#a0a9b7;margin-top:calc(4*var(--u))}
@keyframes dw-word{from{opacity:0;filter:blur(10px);transform:translateY(.35em)}to{opacity:1;filter:blur(0);transform:none}}
@keyframes dw-rise{from{opacity:0;transform:translateY(calc(20*var(--u)))}to{opacity:1;transform:none}}
@keyframes dw-slide{from{opacity:0;transform:translateX(calc(-60*var(--u)))}to{opacity:1;transform:none}}
@keyframes dw-pop{from{opacity:0;filter:blur(14px);transform:scale(.86)}to{opacity:1;filter:blur(0);transform:none}}
@keyframes dw-out{to{opacity:0;transform:translateY(calc(-26*var(--u)))}}
@keyframes dw-drift{to{transform:translate(8vw,6vh) scale(1.08)}}
@keyframes dw-grid{to{background-position:calc(-720*var(--u)) calc(-432*var(--u))}}
@keyframes dw-float{from{transform:translateY(0)}to{transform:translateY(-30vh)}}
${exit}`

  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' +
    '<div class="bg"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div></div>' +
    '<div class="grid"></div>' + particles(36) + '<div class="vig"></div>' +
    '<main class="stage">' + body(scene) + '</main>' +
    '<div class="mk">' + markerCells(0).map((c) => '<i style="background:' + c + '"></i>').join('') + '</div>' +
    '</body></html>'
  )
}
