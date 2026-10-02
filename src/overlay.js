/**
 * In-page overlay runtime.
 *
 * This function is serialized with `.toString()` and injected into the page via
 * Playwright's `addInitScript`, so it re-installs itself on every navigation.
 * It exposes `window.__dw`, a small API the runner drives over `page.evaluate`.
 *
 * The whole point: the polish (captions, a smooth synthetic cursor, zoom) is part
 * of the DOM, so it ends up *inside* the recorded video, with no post-production
 * compositing needed. The browser never shows the real OS cursor
 * in a headless recording, which is exactly why we draw our own.
 *
 * Coordinate model:
 *  - The overlay root is attached to <html> (documentElement), so it is NOT a
 *    descendant of <body> and is therefore unaffected by the zoom transform we
 *    apply to <body>. Captions and cursor stay crisp while the page zooms.
 *  - `getBoundingClientRect()` already reflects ancestor CSS transforms, so the
 *    cursor/ring always land on the element as actually rendered, zoom or not.
 */
import { MARKER } from './marker.js'

export function overlayRuntime(theme, marker) {
  if (window.__dw) return
  const ACCENT = (theme && theme.accent) || '#e91e63'
  const FONT =
    (theme && theme.font) ||
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
  const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)'
  const BG = (theme && theme.background) || '#07070a'
  const MARKER = marker

  let root = null
  let cursorEl = null
  let clickRingEl = null
  let captionEl = null
  let ringEl = null
  let coverEl = null
  let captionTimer = null
  // A caption shown with no duration (hold) survives a scene: hidden under the
  // cover, shown again when the cover goes.
  let captionHeld = false

  function ensureRoot() {
    if (root) return
    root = document.createElement('div')
    root.id = '__dw-overlay'
    Object.assign(root.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '2147483647',
      fontFamily: FONT,
      overflow: 'hidden',
    })

    // Synthetic cursor (SVG arrow) — moves via a transform transition.
    cursorEl = document.createElement('div')
    Object.assign(cursorEl.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '28px',
      height: '28px',
      transform: 'translate(-40px, -40px)',
      filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.45))',
      willChange: 'transform',
    })
    cursorEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="28" height="28">' +
      '<path d="M5 2.5 19 12.2l-6.1.7 3.5 7.1-2.7 1.3-3.5-7.2L5 19.5z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>'

    // Click pulse ring.
    clickRingEl = document.createElement('div')
    Object.assign(clickRingEl.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '14px',
      height: '14px',
      marginLeft: '0px',
      marginTop: '0px',
      borderRadius: '50%',
      border: '2px solid ' + ACCENT,
      transform: 'translate(-40px, -40px) scale(0.2)',
      opacity: '0',
    })

    // Caption bar (bottom-center).
    captionEl = document.createElement('div')
    Object.assign(captionEl.style, {
      position: 'absolute',
      left: '50%',
      bottom: '7%',
      transform: 'translateX(-50%) translateY(12px)',
      maxWidth: '78%',
      padding: '14px 22px',
      borderRadius: '14px',
      background: 'rgba(12, 12, 14, 0.82)',
      backdropFilter: 'blur(6px)',
      color: '#fff',
      fontSize: '26px',
      lineHeight: '1.3',
      fontWeight: '600',
      letterSpacing: '0.2px',
      textAlign: 'center',
      boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
      opacity: '0',
      transition: 'opacity 320ms ease, transform 320ms ' + EASE,
      whiteSpace: 'pre-wrap',
    })

    // Highlight ring around an element.
    ringEl = document.createElement('div')
    Object.assign(ringEl.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      borderRadius: '12px',
      border: '3px solid ' + ACCENT,
      boxShadow: '0 0 0 9999px rgba(8,8,10,0.0)',
      opacity: '0',
      transition: 'opacity 260ms ease, left 420ms ' + EASE + ', top 420ms ' + EASE + ', width 420ms ' + EASE + ', height 420ms ' + EASE,
    })

    root.append(ringEl, captionEl, clickRingEl, cursorEl)
    ;(document.documentElement || document.body).appendChild(root)
  }

  function center(selector) {
    const el = document.querySelector(selector)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r }
  }

  const api = {}

  api.ready = function () {
    ensureRoot()
    return true
  }

  api.cursorTo = function (x, y, ms) {
    ensureRoot()
    cursorEl.style.transition = 'transform ' + (ms || 600) + 'ms ' + EASE
    cursorEl.style.transform = 'translate(' + x + 'px, ' + y + 'px)'
  }

  api.cursorToSelector = function (selector, ms) {
    ensureRoot()
    const c = center(selector)
    if (!c) return false
    api.cursorTo(c.x, c.y, ms)
    return true
  }

  api.click = function () {
    ensureRoot()
    const t = cursorEl.style.transform
    clickRingEl.style.transition = 'none'
    clickRingEl.style.transform = t + ' scale(0.2)'
    clickRingEl.style.opacity = '0.9'
    // Force reflow so the pulse animates from the reset state.
    void clickRingEl.offsetWidth
    clickRingEl.style.transition = 'transform 480ms ease-out, opacity 480ms ease-out'
    clickRingEl.style.transform = t + ' scale(2.6)'
    clickRingEl.style.opacity = '0'
  }

  // Strip the punctuation around a word, so "click." matches the accent "click".
  function bare(w) {
    return w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  }

  // `style: 'words'` reveals the caption one word at a time, blurred to sharp,
  // with the words listed in `accent` in the theme colour.
  function fillWords(text, accent) {
    const acc = new Set(String(accent || '').split(/\s+/).map(bare).filter(Boolean))
    captionEl.textContent = ''
    String(text)
      .split(/\s+/)
      .filter(Boolean)
      .forEach(function (w, i) {
        const span = document.createElement('span')
        span.textContent = w
        Object.assign(span.style, {
          display: 'inline-block',
          marginRight: '0.28em',
          opacity: '0',
          filter: 'blur(8px)',
          transform: 'translateY(0.35em)',
          transition: 'opacity 420ms ' + EASE + ', filter 420ms ' + EASE + ', transform 420ms ' + EASE,
          transitionDelay: 120 + i * 80 + 'ms',
          color: acc.has(bare(w)) ? ACCENT : '',
        })
        captionEl.appendChild(span)
      })
    void captionEl.offsetWidth
    for (const span of captionEl.children) {
      span.style.opacity = '1'
      span.style.filter = 'blur(0)'
      span.style.transform = 'none'
    }
  }

  api.caption = function (text, ms, opts) {
    ensureRoot()
    if (captionTimer) clearTimeout(captionTimer)
    captionHeld = !(ms && ms > 0)
    if (opts && opts.style === 'words') fillWords(text, opts.accent)
    else captionEl.textContent = text
    captionEl.style.opacity = '1'
    captionEl.style.transform = 'translateX(-50%) translateY(0)'
    if (ms && ms > 0) {
      captionTimer = setTimeout(api.captionHide, ms)
    }
  }

  api.captionHide = function () {
    captionHeld = false
    hideCaptionEl()
  }

  function hideCaptionEl() {
    if (!captionEl) return
    captionEl.style.opacity = '0'
    captionEl.style.transform = 'translateX(-50%) translateY(12px)'
  }

  api.highlight = function (selector, pad) {
    ensureRoot()
    const c = center(selector)
    if (!c) return false
    const p = pad == null ? 8 : pad
    ringEl.style.left = c.rect.left - p + 'px'
    ringEl.style.top = c.rect.top - p + 'px'
    ringEl.style.width = c.rect.width + p * 2 + 'px'
    ringEl.style.height = c.rect.height + p * 2 + 'px'
    ringEl.style.opacity = '1'
    return true
  }

  api.highlightHide = function () {
    if (ringEl) ringEl.style.opacity = '0'
  }

  api.zoom = function (selector, scale, ms) {
    ensureRoot()
    const c = center(selector)
    if (!c) return false
    const ox = c.x + window.scrollX
    const oy = c.y + window.scrollY
    const b = document.body
    b.style.transition = 'transform ' + (ms || 700) + 'ms ' + EASE
    b.style.transformOrigin = ox + 'px ' + oy + 'px'
    b.style.transform = 'scale(' + scale + ')'
    return true
  }

  api.zoomReset = function (ms) {
    const b = document.body
    b.style.transition = 'transform ' + (ms || 600) + 'ms ' + EASE
    b.style.transform = 'none'
  }

  // Full-screen cover held while a motion scene plays. The render stage finds it
  // by the two marker cells in the top-left corner and swaps that stretch for the
  // scene recorded at each format's size. The title is drawn too, so a capture
  // rendered without the scene clips still shows a plain card, not a blank one.
  api.cover = function (on, k, title, subtitle) {
    ensureRoot()
    if (!coverEl) {
      coverEl = document.createElement('div')
      Object.assign(coverEl.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '14px',
        background: BG,
        color: '#fff',
        opacity: '0',
      })
      const t = document.createElement('div')
      t.className = '__dw-cover-title'
      Object.assign(t.style, { fontSize: '56px', fontWeight: '800', letterSpacing: '-0.5px', textAlign: 'center', maxWidth: '86%' })
      const sub = document.createElement('div')
      sub.className = '__dw-cover-sub'
      Object.assign(sub.style, { fontSize: '24px', fontWeight: '500', color: ACCENT })
      const mk = document.createElement('div')
      Object.assign(mk.style, { position: 'absolute', left: '0', top: '0', display: 'flex' })
      for (let c = 0; c < 2; c++) {
        const cell = document.createElement('div')
        Object.assign(cell.style, { width: MARKER.cell + 'px', height: MARKER.cell + 'px' })
        mk.appendChild(cell)
      }
      mk.className = '__dw-cover-marker'
      coverEl.append(t, sub, mk)
      root.appendChild(coverEl)
    }
    if (on) {
      // Same order as markerCells() in marker.js: this function runs in the page
      // and cannot import it.
      const cells = k % 2 ? [MARKER.blue, MARKER.red] : [MARKER.red, MARKER.blue]
      const mk = coverEl.querySelector('.__dw-cover-marker').children
      mk[0].style.background = cells[0]
      mk[1].style.background = cells[1]
      coverEl.querySelector('.__dw-cover-title').textContent = title || ''
      coverEl.querySelector('.__dw-cover-sub').textContent = subtitle || ''
      hideCaptionEl()
    } else if (captionHeld) {
      captionEl.style.opacity = '1'
      captionEl.style.transform = 'translateX(-50%) translateY(0)'
    }
    coverEl.style.opacity = on ? '1' : '0'
    cursorEl.style.opacity = on ? '0' : '1'
    return true
  }

  window.__dw = api
}

/** Build the init-script source string that installs the overlay in-page. */
export function buildInitScript(theme) {
  return '(' + overlayRuntime.toString() + ')(' + JSON.stringify(theme || {}) + ', ' + JSON.stringify(MARKER) + ')'
}
