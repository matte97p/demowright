import { defineDemo } from '../src/index.js'

// A real-world demowright config: "How GeoSuite works", end to end, on the live
// app — add a brand (the site is scraped into a brand profile), launch a GEO
// audit, watch it run, read the result, then ask the Geo copilot. The dead waits
// — the scrape and the multi-minute audit — are recorded in real time and SPED
// UP in the final video via the `timelapse` field on those waits.
//
// Credentials come from the environment so they never live in the file or appear
// on screen (see the `auth` block below):
//
//   GEOSUITE_URL=https://your-instance.example \
//   GEOSUITE_EMAIL=you@example.com GEOSUITE_PASSWORD=... \
//   node bin/cli.js run examples/geosuite-howitworks.config.js -o output/geosuite-howitworks.mp4 --keep-raw
//
// `init` suppresses the first-run tour and pre-expands the sidebar groups so the
// nav is clickable from the first frame.

const BASE = process.env.GEOSUITE_URL || 'http://localhost:3000'

const INIT = `(() => {
  const get = Storage.prototype.getItem
  Storage.prototype.getItem = function (k) {
    if (typeof k === 'string') {
      if (k.indexOf('gs-workspace-tour:') === 0) return '1'
      if (k === 'gs-sidebar-expanded-groups') return JSON.stringify(['Analizza', 'Account', 'Analyze'])
    }
    return get.call(this, k)
  }
})();`

const M = '.gs-admin-modal-shell' // the dialog panel (intercepts clicks)

export default defineDemo({
  name: 'geosuite-howitworks',
  url: `${BASE}/app`,
  viewport: { width: 1920, height: 1080 },
  theme: { accent: '#ff3b7a' },
  locale: 'it-IT',
  formats: ['landscape'],
  init: INIT,

  auth: {
    url: `${BASE}/login`,
    fields: [
      { selector: 'input[type="email"]', env: 'GEOSUITE_EMAIL' },
      { selector: 'input[type="password"]', env: 'GEOSUITE_PASSWORD' },
    ],
    submit: 'button[type="submit"]',
    waitUrl: '**/app**',
  },

  steps: [
    { type: 'wait', selector: '.gs-workspace-sidebar', timeout: 20000 },
    { type: 'wait', duration: 800 },

    // --- intro ---
    { type: 'caption', text: 'GeoSuite: come funziona, dall’inizio.', duration: 2600 },
    { type: 'highlight', selector: '.gs-admin-hero', pad: 6, duration: 1600 },

    // --- add a brand (onboarding + profile config) ---
    { type: 'move', selector: '.gs-workspace-sidebar a[href="/app/brand"]', duration: 550 },
    { type: 'click', selector: '.gs-workspace-sidebar a[href="/app/brand"]' },
    { type: 'wait', duration: 2000 },
    { type: 'caption', text: 'Aggiungi un brand: bastano nome e sito.', duration: 2600 },
    { type: 'move', selector: '.gs-admin-panel-cta.is-accent', duration: 500 },
    { type: 'click', selector: '.gs-admin-panel-cta.is-accent' }, // open "Aggiungi brand"
    { type: 'wait', selector: M, timeout: 10000 },
    { type: 'wait', duration: 700 },
    { type: 'move', selector: `${M} input[type="text"]`, duration: 400 },
    { type: 'type', selector: `${M} input[type="text"]`, text: 'Linear', perChar: 70 },
    { type: 'type', selector: `${M} input[type="url"]`, text: 'https://linear.app', perChar: 48 },
    { type: 'wait', duration: 500 },
    { type: 'caption', text: 'GeoSuite legge il sito e costruisce il profilo del brand.', duration: 2600 },
    { type: 'click', selector: `${M} .gs-admin-panel-cta.is-accent` }, // "Analizza il sito" → scrape
    // scrape runs ~15-30s; record it and speed it up 8×
    { type: 'wait', selector: `${M} .gs-starter-profile`, timeout: 90000, timelapse: 8 },
    { type: 'caption', text: 'Profilo generato: settore, posizionamento, target, personas.', duration: 3200 },
    { type: 'highlight', selector: `${M} .gs-starter-profile`, pad: 4, duration: 1800 },
    { type: 'click', selector: `${M} .gs-admin-panel-cta.is-accent` }, // "Crea brand"
    { type: 'wait', selector: '.gs-table-mini-btn-secondary', timeout: 15000 }, // brand list reloaded (Linear added)
    { type: 'wait', duration: 1200 },

    // --- launch a real audit ---
    { type: 'caption', text: 'Ora lancia l’audit di visibilità sulle AI.', duration: 2600 },
    { type: 'move', selector: '.gs-table-mini-btn-secondary', duration: 550 },
    { type: 'click', selector: '.gs-table-mini-btn-secondary' }, // "Lancia audit" (newest row = Linear)
    { type: 'wait', selector: M, timeout: 10000 },
    { type: 'wait', duration: 800 },
    { type: 'select', selector: `${M} select`, contains: 'Linear' },
    { type: 'wait', duration: 700 },
    { type: 'caption', text: 'L’audit interroga ChatGPT, Gemini e Perplexity sul brand — decine di volte.', hold: true },
    { type: 'click', selector: `${M} .gs-admin-panel-cta.is-accent` }, // "Nuovo audit" → POST (~20s) → navigate

    // --- the audit runs — speed up the dead waits; fail fast if it never starts ---
    { type: 'wait', selector: '.gs-audit-progress-fill', timeout: 120000, timelapse: 12 }, // POST + load → progress shows
    { type: 'wait', selector: '.gs-exec-summary', timeout: 1100000, timelapse: 40 }, // the run → ~20s
    { type: 'captionHide' },
    { type: 'wait', duration: 1000 },

    // --- the result ---
    { type: 'caption', text: 'Il risultato: punteggio di visibilità, competitor, cosa migliorare.', duration: 3200 },
    { type: 'highlight', selector: '.gs-score-range', pad: 6, duration: 2000 },
    { type: 'scroll', selector: '.gs-mp-rankings', duration: 800 },
    { type: 'caption', text: 'Come ti posizioni contro i competitor nelle risposte AI.', duration: 3000 },
    { type: 'highlight', selector: '.gs-mp-rankings', pad: 6, duration: 2000 },
    { type: 'wait', duration: 600 },

    // --- ask Geo ---
    { type: 'caption', text: 'E il copilota Geo risponde sui tuoi dati.', duration: 2600 },
    { type: 'move', selector: '.gs-workspace-sidebar a[href="/app/assistant"]', duration: 550 },
    { type: 'click', selector: '.gs-workspace-sidebar a[href="/app/assistant"]' },
    { type: 'wait', selector: '.gs-asst-composer-input', timeout: 20000 },
    { type: 'wait', duration: 700 },
    { type: 'type', selector: '.gs-asst-composer-input', text: 'Qual è il punteggio di visibilità AI del mio ultimo audit?', perChar: 30 },
    { type: 'click', selector: '.gs-asst-composer button' },
    { type: 'caption', text: 'Geo legge l’audit e risponde.', hold: true },
    { type: 'wait', selector: '.gs-asst-feedback', timeout: 120000 },
    { type: 'captionHide' },
    { type: 'wait', duration: 800 },
    { type: 'zoom', selector: '.gs-asst-bubble-assistant', scale: 1.08, duration: 700 },
    { type: 'wait', duration: 2400 },
    { type: 'zoomReset', duration: 550 },

    { type: 'endcard', title: 'GeoSuite', subtitle: 'trygeosuite.it', duration: 2800 },
  ],
})
