import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineDemo } from '../src/index.js'

// Point the demo at the bundled local site (portable across machines).
const here = path.dirname(fileURLToPath(import.meta.url))
const siteUrl = pathToFileURL(path.join(here, 'site', 'index.html')).href

// The narrative mirrors the GeoSuite "geobot" story on purpose: a crowded
// sidebar → "just ask" → the assistant runs the right tool by itself.
export default defineDemo({
  name: 'local-demo',
  url: siteUrl,
  viewport: { width: 1280, height: 720 },
  theme: { accent: '#e91e63' },
  formats: ['landscape'],
  steps: [
    { type: 'caption', text: '18 voci nella sidebar.\nTrova tu quella giusta.', duration: 2800 },
    { type: 'highlight', selector: '.sidebar', pad: 4, duration: 1500 },
    { type: 'zoom', selector: '.sidebar', scale: 1.18 },
    { type: 'wait', duration: 900 },
    { type: 'zoomReset' },
    { type: 'highlightHide' },
    { type: 'caption', text: 'Oppure: chiedi e basta.', duration: 2200 },
    { type: 'move', selector: '#q', duration: 700 },
    { type: 'type', selector: '#q', text: 'Come mi vede ChatGPT rispetto ai competitor?', perChar: 40 },
    { type: 'click', selector: '#ask' },
    { type: 'caption', text: "L'assistente lancia il tool da solo.", duration: 2600 },
    { type: 'wait', selector: '#result .done', timeout: 15000 },
    { type: 'wait', duration: 600 },
    { type: 'zoom', selector: '.assistant', scale: 1.25 },
    { type: 'wait', duration: 1600 },
    { type: 'zoomReset' },
    { type: 'endcard', title: 'demowright', subtitle: 'demo as code', duration: 2600 },
  ],
})
