#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { recordDemo, estimateDurationMs, normalizeDemo } from '../src/index.js'
import { scaffold } from '../src/scaffold.js'

const HELP = `demowright — record polished product demo videos from a script

Usage:
  demowright run <config.js> [options]   capture a demo and render MP4(s)
  demowright init [dir]                  write a starter demowright.config.js
  demowright --help | --version

Options for "run":
  -o, --out <file>      output path (default: output/<name>.mp4)
  -f, --format <list>   comma list: landscape,square,vertical (default from config)
  -m, --music <file>    background music track (overrides config)
      --keep-raw        keep the intermediate .webm and work dir
      --dry-run         validate the config and print the planned timeline; record nothing
`

function fmt(ms) {
  return (ms / 1000).toFixed(1) + 's'
}

/** Print the validated step timeline without launching a browser. */
function printPlan(rawDemo) {
  const d = normalizeDemo(rawDemo)
  console.log('plan "' + d.name + '"  ' + d.steps.length + ' steps, ~' + fmt(estimateDurationMs(d)))
  console.log('  url ' + d.url + '   ' + d.viewport.width + 'x' + d.viewport.height + '   formats ' + d.formats.join(','))
  if (d.voice) console.log('  voice ' + (typeof d.voice === 'function' ? 'custom fn' : d.voice.provider || 'custom'))
  const narrates = (s) => s.say != null || (d.voice && d.voice.fromCaptions && s.type === 'caption')
  d.steps.forEach((s, i) => {
    const detail = narrates(s) ? '🔊 ' : ''
    const what = s.text != null ? JSON.stringify(s.text) : s.selector || s.url || s.key || ''
    console.log('  ' + String(i + 1).padStart(3) + '  ' + s.type.padEnd(12) + ' ' + detail + what)
  })
}

async function loadConfig(configPath) {
  const abs = path.resolve(process.cwd(), configPath)
  const mod = await import(pathToFileURL(abs).href)
  const demo = mod.default || mod.demo || mod
  if (!demo || !demo.steps) {
    throw new Error('config "' + configPath + '" must default-export a demo object with steps')
  }
  return demo
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      format: { type: 'string', short: 'f' },
      music: { type: 'string', short: 'm' },
      'keep-raw': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  })

  if (values.version) {
    const { readFile } = await import('node:fs/promises')
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    )
    console.log(pkg.version)
    return
  }

  const command = positionals[0]
  if (values.help || !command) {
    console.log(HELP)
    return
  }

  if (command === 'init') {
    const res = await scaffold(positionals[1] || process.cwd())
    console.log(
      res.created
        ? '✓ wrote ' + res.path + '\n  edit it, then: npx demowright run ' + path.basename(res.path)
        : '• ' + res.path + ' already exists — left untouched'
    )
    return
  }

  if (command === 'run') {
    const configPath = positionals[1]
    if (!configPath) throw new Error('usage: demowright run <config.js>')
    const rawDemo = await loadConfig(configPath)

    if (values['dry-run']) {
      printPlan(rawDemo)
      return
    }

    const formats = values.format ? values.format.split(',').map((s) => s.trim()).filter(Boolean) : null
    const est = estimateDurationMs(normalizeDemo(rawDemo))
    console.log('▶ recording "' + (rawDemo.name || 'demo') + '" (~' + fmt(est) + ')')

    const { outputs } = await recordDemo(rawDemo, {
      out: values.out,
      formats,
      music: values.music,
      keepRaw: values['keep-raw'],
      onAuth: () => process.stdout.write('  · logging in…\n'),
      onVoice: (n) => process.stdout.write('  · narrating ' + n + ' line(s)…\n'),
      onStep: (i, step) => process.stdout.write('  · ' + String(i + 1).padStart(2) + ' ' + step.type + '\n'),
    })

    console.log('✓ done:')
    for (const o of outputs) console.log('  ' + o.format.padEnd(10) + o.path)
    return
  }

  throw new Error('unknown command "' + command + '" — try: demowright --help')
}

main().catch((err) => {
  console.error('✗ ' + (err && err.message ? err.message : err))
  process.exit(1)
})
