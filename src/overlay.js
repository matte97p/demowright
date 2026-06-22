/**
 * In-page overlay runtime.
 *
 * This function is serialized with `.toString()` and injected into the page via
 * Playwright's `addInitScript`, so it re-installs itself on every navigation.
 * It exposes `window.__dw`, a small API the runner drives over `page.evaluate`.
 *
 * The whole point: the polish (captions, a smooth synthetic cursor, zoom, an end
 * card) is part of the DOM, so it ends up *inside* the recorded video — no
 * post-production compositing needed. The browser never shows the real OS cursor
 * in a headless recording, which is exactly why we draw our own.
 *
 * Coordinate model:
 *  - The overlay root is attached to <html> (documentElement), so it is NOT a
 *    descendant of <body> and is therefore unaffected by the zoom transform we
 *    apply to <body>. Captions and cursor stay crisp while the page zooms.
 *  - `getBoundingClientRect()` already reflects ancestor CSS transforms, so the
 *    cursor/ring always land on the element as actually rendered, zoom or not.
 */
export function overlayRuntime(theme) {
  if (window.__dw) return
  const ACCENT = (theme && theme.accent) || '#e91e63'
  const FONT =
    (theme && theme.font) ||
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
  const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

  let root = null
  let cursorEl = null
  let clickRingEl = null
  let captionEl = null
  let ringEl = null
  let cardEl = null
  let captionTimer = null

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

  api.caption = function (text, ms) {
    ensureRoot()
    if (captionTimer) clearTimeout(captionTimer)
    captionEl.textContent = text
    captionEl.style.opacity = '1'
    captionEl.style.transform = 'translateX(-50%) translateY(0)'
    if (ms && ms > 0) {
      captionTimer = setTimeout(api.captionHide, ms)
    }
  }

  api.captionHide = function () {
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

  api.endcard = function (title, subtitle, ms) {
    ensureRoot()
    if (!cardEl) {
      cardEl = document.createElement('div')
      Object.assign(cardEl.style, {
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
        background: 'radial-gradient(120% 120% at 50% 30%, #1b1b22 0%, #0b0b0e 70%)',
        color: '#fff',
        opacity: '0',
        transition: 'opacity 520ms ease',
      })
      const t = document.createElement('div')
      t.className = '__dw-card-title'
      Object.assign(t.style, { fontSize: '56px', fontWeight: '800', letterSpacing: '-0.5px' })
      const s = document.createElement('div')
      s.className = '__dw-card-sub'
      Object.assign(s.style, { fontSize: '24px', fontWeight: '500', color: ACCENT })
      cardEl.append(t, s)
      root.appendChild(cardEl)
    }
    cardEl.querySelector('.__dw-card-title').textContent = title || ''
    cardEl.querySelector('.__dw-card-sub').textContent = subtitle || ''
    void cardEl.offsetWidth
    cardEl.style.opacity = '1'
    return true
  }

  window.__dw = api
}

/** Build the init-script source string that installs the overlay in-page. */
export function buildInitScript(theme) {
  return '(' + overlayRuntime.toString() + ')(' + JSON.stringify(theme || {}) + ')'
}
