import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { ffmpegBin, findFfmpeg } from '../src/ffmpeg.js'

test('an ffmpeg is found, and it runs', () => {
  const bin = ffmpegBin()
  assert.ok(bin)
  assert.equal(findFfmpeg(), bin)
  assert.equal(spawnSync(bin, ['-version'], { stdio: 'ignore' }).status, 0)
})

test('DEMOWRIGHT_FFMPEG wins over the bundled binary', async () => {
  const prev = process.env.DEMOWRIGHT_FFMPEG
  process.env.DEMOWRIGHT_FFMPEG = '/opt/custom/ffmpeg'
  try {
    // A fresh module instance, so the resolution runs again with the variable set.
    const mod = await import('../src/ffmpeg.js?env=' + Date.now())
    assert.equal(mod.findFfmpeg(), '/opt/custom/ffmpeg')
  } finally {
    if (prev == null) delete process.env.DEMOWRIGHT_FFMPEG
    else process.env.DEMOWRIGHT_FFMPEG = prev
  }
})
