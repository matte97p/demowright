/**
 * Optional voiceover synthesis.
 *
 * Off by default. When a demo sets `voice`, every step that carries a `say`
 * string (and, with `fromCaptions`, every `caption`) becomes a narration line.
 * Lines are synthesized to small audio files here; the render stage delays each
 * one to the moment its step ran and ducks the music under it.
 *
 * `voice` is pluggable and dependency-free:
 *  - { provider: 'openai',   voice?, model?, speed?, apiKeyEnv? }   uses OPENAI_API_KEY
 *  - { provider: 'elevenlabs', voice: '<id>', model?, apiKeyEnv? }  uses ELEVENLABS_API_KEY
 *  - { synthesize: async (text, cfg) => Buffer|Uint8Array }         bring your own
 *  - a bare function  async (text) => Buffer|Uint8Array
 *
 * API keys are read from the environment by name (never from the config), the
 * same way `auth` handles credentials — so nothing secret lives in the repo.
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Built-in providers. Each returns the spoken `text` as audio bytes (mp3). */
const PROVIDERS = {
  async openai(text, cfg) {
    const envName = cfg.apiKeyEnv || 'OPENAI_API_KEY'
    const key = process.env[envName]
    if (!key) throw new Error('[demowright] voice provider "openai" needs env ' + envName)
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini-tts',
        voice: cfg.voice || 'alloy',
        input: text,
        response_format: 'mp3',
        ...(cfg.speed ? { speed: cfg.speed } : {}),
        // gpt-4o-mini-tts honors a free-text style/language instruction; tts-1
        // ignores it. Use it to pin accent/tone (e.g. natural Italian).
        ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
      }),
    })
    if (!res.ok) {
      throw new Error('[demowright] openai TTS failed (' + res.status + '): ' + (await res.text()).slice(0, 200))
    }
    return Buffer.from(await res.arrayBuffer())
  },

  async elevenlabs(text, cfg) {
    const envName = cfg.apiKeyEnv || 'ELEVENLABS_API_KEY'
    const key = process.env[envName]
    if (!key) throw new Error('[demowright] voice provider "elevenlabs" needs env ' + envName)
    const voiceId = cfg.voice || cfg.voiceId
    if (!voiceId) throw new Error('[demowright] voice provider "elevenlabs" needs "voice" (a voiceId)')
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId), {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: cfg.model || 'eleven_multilingual_v2' }),
    })
    if (!res.ok) {
      throw new Error('[demowright] elevenlabs TTS failed (' + res.status + '): ' + (await res.text()).slice(0, 200))
    }
    return Buffer.from(await res.arrayBuffer())
  },
}

/** Resolve the `voice` config to a `(text, cfg) => bytes` function. */
function resolveSynth(voice) {
  if (typeof voice === 'function') return voice
  if (voice && typeof voice.synthesize === 'function') return voice.synthesize
  if (voice && PROVIDERS[voice.provider]) return PROVIDERS[voice.provider]
  throw new Error(
    '[demowright] unknown voice provider "' + (voice && voice.provider) + '" (use openai|elevenlabs, ' +
      'a "synthesize" function, or pass a function)'
  )
}

/**
 * Synthesize each narration cue to a file. Identical lines are synthesized once
 * and reused. Returns [{ path, atSec }] aligned to the input cues; an empty list
 * when voice is off or there are no cues.
 */
export async function synthesizeNarration(cues, voice, workDir) {
  if (!voice || !cues || !cues.length) return []
  const synth = resolveSynth(voice)
  const cfg = typeof voice === 'object' ? voice : {}
  const cache = new Map()
  const out = []
  let k = 0
  for (const cue of cues) {
    let file = cache.get(cue.text)
    if (!file) {
      const bytes = await synth(cue.text, cfg)
      file = path.join(workDir, 'narr-' + k++ + '.mp3')
      await writeFile(file, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
      cache.set(cue.text, file)
    }
    out.push({ path: file, atSec: cue.atSec })
  }
  return out
}
