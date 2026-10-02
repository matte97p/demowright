import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineDemo } from '../src/index.js'

// The bundled local site, with every motion feature: an opening scene, a word
// caption, a list scene, the backdrop and the end card. Also what CI renders to
// measure dropped frames (scripts/frame-check.mjs).
const here = path.dirname(fileURLToPath(import.meta.url))
const siteUrl = pathToFileURL(path.join(here, 'site', 'index.html')).href

export default defineDemo({
  name: 'scenes',
  url: siteUrl,
  viewport: { width: 1280, height: 720 },
  theme: { accent: '#f2529a' },
  backdrop: { url: 'app.example.com' },
  formats: ['landscape', 'square', 'vertical'],
  steps: [
    { type: 'scene', title: 'Your demo, as code. Always current.', accent: 'code.', subtitle: 'demowright', duration: 2800 },
    { type: 'caption', text: 'Too many items in the sidebar.', style: 'words', accent: 'Too many', duration: 2400 },
    { type: 'highlight', selector: '.sidebar', pad: 4, duration: 1200 },
    {
      type: 'scene',
      preset: 'list',
      title: 'Or: just ask.',
      accent: 'ask.',
      items: [{ label: 'Type the question', hint: 'in plain words' }, { label: 'The assistant picks the tool', hint: 'and runs it' }, 'Read the answer'],
      duration: 3000,
    },
    { type: 'move', selector: '#q', duration: 600 },
    { type: 'type', selector: '#q', text: 'How does ChatGPT see me?', perChar: 40 },
    { type: 'click', selector: '#ask' },
    { type: 'wait', selector: '#result .done', timeout: 15000 },
    { type: 'wait', duration: 800 },
    { type: 'endcard', title: 'demowright', subtitle: 'demo as code', duration: 2600 },
  ],
})
