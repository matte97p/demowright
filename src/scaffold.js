/** `demowright init` — drop a runnable starter config in the target directory. */
import { writeFile, access } from 'node:fs/promises'
import path from 'node:path'

const STARTER = `import { defineDemo } from 'demowright'

// Edit the selectors/text to match your app, then:
//   npx demowright run demowright.config.js -o output/demo.mp4
export default defineDemo({
  name: 'my-demo',
  url: 'http://localhost:3000',
  viewport: { width: 1280, height: 720 },
  theme: { accent: '#e91e63' },
  // music: './assets/track.mp3',
  formats: ['landscape'], // add 'square' and/or 'vertical' for social crops
  steps: [
    { type: 'caption', text: 'This is my app.', duration: 2400 },
    { type: 'highlight', selector: 'nav', duration: 1600 },
    { type: 'zoom', selector: 'nav', scale: 1.3 },
    { type: 'wait', duration: 800 },
    { type: 'zoomReset' },
    { type: 'click', selector: 'a[href="/pricing"]' },
    { type: 'wait', selector: 'h1' },
    { type: 'caption', text: 'And here is the thing it does.', duration: 2600 },
    { type: 'endcard', title: 'My Product', subtitle: 'myproduct.com', duration: 2600 },
  ],
})
`

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function scaffold(dir = process.cwd()) {
  const target = path.join(dir, 'demowright.config.js')
  if (await exists(target)) {
    return { created: false, path: target }
  }
  await writeFile(target, STARTER, 'utf8')
  return { created: true, path: target }
}
