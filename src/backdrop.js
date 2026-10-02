/**
 * Backdrop: the capture shown as a browser window over the animated background,
 * instead of filling the frame.
 *
 * Everything around the capture is made once per format before the render: a
 * clean LOOP_SEC loop of the background (recorded by Playwright, see scenes.js)
 * and three still images rendered from HTML, the window chrome, the rounded mask
 * and the drop shadow. ffmpeg then composes them around the capture. This module
 * is browser-free: it computes the geometry and the markup, and builds the
 * filter chain; the runner records and screenshots.
 */
import { escapeHtml, FORMAT_SIZES, DEFAULT_FONT } from './scenes.js'

export const BACKDROP_FRAMES = ['browser', 'none']

const even = (n) => 2 * Math.round(n / 2)

/**
 * Normalize `demo.backdrop`: false/undefined is off, true is the defaults.
 * `url` is what the address bar shows, by default the host of the demo url.
 */
export function normalizeBackdrop(backdrop, demoUrl, fail) {
  if (!backdrop) return null
  const b = backdrop === true ? {} : backdrop
  if (typeof b !== 'object' || Array.isArray(b)) fail('"backdrop" must be true or an object')
  const frame = b.frame == null ? 'browser' : b.frame
  if (!BACKDROP_FRAMES.includes(frame)) fail('backdrop.frame must be one of: ' + BACKDROP_FRAMES.join(', '))
  const scale = b.scale == null ? 0.86 : b.scale
  if (typeof scale !== 'number' || !(scale >= 0.5 && scale <= 1)) fail('backdrop.scale must be a number between 0.5 and 1')
  let url = b.url
  if (url == null) {
    try {
      const u = new URL(demoUrl)
      url = u.protocol === 'http:' || u.protocol === 'https:' ? u.host : ''
    } catch {
      url = ''
    }
  }
  return { frame, scale, url: String(url) }
}

/**
 * Where the window sits in a format: the capture keeps its aspect ratio and,
 * with its address bar, fits inside `scale` of the frame in both directions.
 * All sizes are even (yuv420p needs it).
 */
export function backdropGeometry(format, viewport, backdrop) {
  const { width: W, height: H } = FORMAT_SIZES[format]
  const aspect = viewport.width / viewport.height
  const bar = backdrop.frame === 'browser' ? 0.045 : 0
  let ww = W * backdrop.scale
  if (ww / aspect + ww * bar > H * backdrop.scale) ww = (H * backdrop.scale) / (1 / aspect + bar)
  ww = even(ww)
  const hb = even(ww * bar)
  const wh = even(ww / aspect)
  const total = hb + wh
  return {
    W,
    H,
    ww,
    wh,
    hb,
    total,
    x: even((W - ww) / 2),
    y: even((H - total) / 2),
    radius: Math.max(8, Math.round(Math.min(ww, total) * 0.02)),
  }
}

const page = (w, h, css, body) =>
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  '*{box-sizing:border-box;margin:0}html,body{width:' + w + 'px;height:' + h + 'px;overflow:hidden;background:transparent}' +
  css + '</style></head><body>' + body + '</body></html>'

/** The window chrome: address bar on top, a hairline border, transparent inside. */
export function chromeHtml(g, backdrop, theme) {
  const font = (theme && theme.font) || DEFAULT_FONT
  const r = g.radius
  const bar = g.hb
    ? '<div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>' +
      (backdrop.url ? '<span class="url">' + escapeHtml(backdrop.url) + '</span>' : '') + '</div>'
    : ''
  const d = Math.round(g.hb * 0.24)
  const css =
    '.win{position:absolute;inset:0;border-radius:' + r + 'px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}' +
    '.bar{position:absolute;left:0;top:0;width:100%;height:' + g.hb + 'px;border-radius:' + r + 'px ' + r + 'px 0 0;' +
    'background:#1c1c22;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:center;padding-left:' + Math.round(g.hb * 0.42) + 'px;gap:' + Math.round(d * 0.7) + 'px}' +
    '.bar i{width:' + d + 'px;height:' + d + 'px;border-radius:50%}' +
    '.url{position:absolute;left:30%;width:40%;height:' + Math.round(g.hb * 0.58) + 'px;border-radius:' + Math.round(g.hb * 0.29) + 'px;' +
    'background:rgba(255,255,255,.07);color:#a0a9b7;font:500 ' + Math.round(g.hb * 0.3) + 'px ' + font + ';display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap}'
  return page(g.ww, g.total, css, '<div class="win">' + bar + '</div>')
}

/** The alpha mask of the window: white rounded rectangle on black. */
export function maskHtml(g) {
  return page(g.ww, g.total, 'body{background:#000}.m{width:100%;height:100%;background:#fff;border-radius:' + g.radius + 'px}', '<div class="m"></div>')
}

/** The drop shadow under the window, on the full frame. */
export function shadowHtml(g) {
  const css =
    '.s{position:absolute;left:' + g.x + 'px;top:' + g.y + 'px;width:' + g.ww + 'px;height:' + g.total + 'px;border-radius:' + g.radius + 'px;' +
    'box-shadow:0 ' + Math.round(g.total * 0.05) + 'px ' + Math.round(g.total * 0.14) + 'px rgba(0,0,0,.6)}'
  return page(g.W, g.H, css, '<div class="s"></div>')
}

/**
 * Filter chain that puts the capture ([0:v], after `prefix` filters) in its
 * window over the background. `inputs` are the ffmpeg indices of the background
 * loop and of the chrome, mask and shadow images. Ends on the label [v].
 */
export function backdropChain(g, inputs, fps, prefix) {
  const pre = prefix ? prefix + ',' : ''
  return [
    '[0:v]' + pre + 'scale=' + g.ww + ':' + g.wh + ',setsar=1,pad=' + g.ww + ':' + g.total + ':0:' + g.hb + ':color=black,format=rgba[dwcap]',
    '[dwcap][' + inputs.chrome + ':v]overlay=0:0:format=auto[dwwin0]',
    '[' + inputs.mask + ':v]format=gray,scale=' + g.ww + ':' + g.total + '[dwmask]',
    '[dwwin0][dwmask]alphamerge[dwwin]',
    '[' + inputs.bg + ':v]scale=' + g.W + ':' + g.H + ',setsar=1,fps=' + fps + '[dwbg]',
    '[dwbg][' + inputs.shadow + ':v]overlay=0:0[dwbgs]',
    '[dwbgs][dwwin]overlay=' + g.x + ':' + g.y + ':shortest=1,setsar=1[v]',
  ].join(';')
}
