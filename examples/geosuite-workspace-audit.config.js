import { defineDemo } from '../src/index.js'

// A real-world demowright config: a workspace tour ending on a completed audit's
// results, at 1920×1080. Uses only pre-computed content (no live LLM calls), so
// it renders reliably in CI. Live add-brand scrape and the Geo assistant are
// omitted here — see geosuite-howitworks.config.js for those.
//
// Credentials come from the environment (see the `auth` block):
//
//   GEOSUITE_URL=https://your-instance.example \
//   GEOSUITE_EMAIL=you@example.com GEOSUITE_PASSWORD=... \
//   node bin/cli.js run examples/geosuite-workspace-audit.config.js -o output/geosuite-workspace-audit.mp4

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

export default defineDemo({
  name: 'geosuite-workspace-audit',
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

    // cockpit
    { type: 'caption', text: 'GeoSuite: la tua visibilità sulle AI, in un posto solo.', duration: 2800 },
    { type: 'highlight', selector: '.gs-admin-hero', pad: 6, duration: 1600 },
    { type: 'caption', text: 'Brand, audit e i tuoi dati — tutto qui.', duration: 2400 },

    // brand profile
    { type: 'move', selector: '.gs-workspace-sidebar a[href="/app/brand"]', duration: 550 },
    { type: 'click', selector: '.gs-workspace-sidebar a[href="/app/brand"]' },
    { type: 'wait', duration: 2200 },
    { type: 'caption', text: 'Il profilo del brand e il suo punteggio di visibilità GEO.', duration: 3000 },
    { type: 'highlight', selector: '.gs-admin-panel', pad: 4, duration: 2000 },

    // audit center
    { type: 'move', selector: '.gs-workspace-sidebar a[href="/app/audits"]', duration: 550 },
    { type: 'click', selector: '.gs-workspace-sidebar a[href="/app/audits"]' },
    { type: 'wait', duration: 2200 },
    { type: 'caption', text: 'Gli audit misurano quanto le AI ti citano.', duration: 2800 },
    { type: 'highlight', selector: '.gs-admin-tile-row', pad: 6, duration: 1900 },

    // a real completed audit's results
    { type: 'move', selector: 'a[href*="/app/audits/"]', duration: 550 },
    { type: 'click', selector: 'a[href*="/app/audits/"]' },
    { type: 'wait', selector: '.gs-exec-summary', timeout: 30000 },
    { type: 'wait', duration: 1000 },
    { type: 'caption', text: 'Dentro un audit: punteggio, competitor, cosa migliorare.', duration: 3200 },
    { type: 'highlight', selector: '.gs-score-range', pad: 6, duration: 2200 },
    { type: 'scroll', selector: '.gs-mp-rankings', duration: 800 },
    { type: 'caption', text: 'Come ti posizioni contro i competitor nelle risposte AI.', duration: 3000 },
    { type: 'highlight', selector: '.gs-mp-rankings', pad: 6, duration: 2000 },
    { type: 'wait', duration: 800 },

    { type: 'endcard', title: 'GeoSuite', subtitle: 'trygeosuite.it', duration: 2800 },
  ],
})
