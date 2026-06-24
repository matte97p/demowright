// Type definitions for demowright.
// Mirrors the runtime schema validated in src/steps.js.

export interface Viewport {
  width: number
  height: number
}

export interface Theme {
  /** Accent colour for the cursor ring, highlight, captions and end card. */
  accent?: string
  /** CSS font-family stack for overlay text. */
  font?: string
}

export interface AuthField {
  selector: string
  /** Name of an env var to read the value from (preferred — keeps secrets out of the config). */
  env?: string
  /** Literal value (use only for non-secret fields). */
  value?: string
}

export interface Auth {
  url: string
  fields: AuthField[]
  /** Selector of the submit/login button. */
  submit: string
  /** Wait for this selector to be visible after submit. */
  waitFor?: string
  /** Wait for the URL to match (string or glob) after submit. */
  waitUrl?: string
  perChar?: number
  /** Selectors to click after login (e.g. dismiss a first-run tour) before capture. */
  after?: string[]
}

export type VoiceProvider = 'openai' | 'elevenlabs'

export interface VoiceConfig {
  provider?: VoiceProvider
  /** Provider voice id/name (e.g. 'alloy' for openai, a voiceId for elevenlabs). */
  voice?: string
  voiceId?: string
  model?: string
  speed?: number
  /** Style/language instruction for models that support it (e.g. gpt-4o-mini-tts). */
  instructions?: string
  /** Env var holding the API key (defaults: OPENAI_API_KEY / ELEVENLABS_API_KEY). */
  apiKeyEnv?: string
  /** Narrate every caption's text when it has no explicit `say`. */
  fromCaptions?: boolean
  /** Bring-your-own synthesizer; returns audio bytes for `text`. */
  synthesize?: (text: string, cfg: VoiceConfig) => Promise<Uint8Array | Buffer>
}

/** A config object, or a bare synthesizer function `(text) => bytes`. */
export type Voice = VoiceConfig | ((text: string, cfg?: VoiceConfig) => Promise<Uint8Array | Buffer>)

/** Narration text spoken when this step runs (requires a `voice` on the demo). */
interface Narratable {
  say?: string
}

export type Step =
  | (Narratable & { type: 'caption'; text: string; duration?: number; hold?: boolean })
  | (Narratable & { type: 'captionHide' })
  | (Narratable & { type: 'goto'; url: string })
  | (Narratable & { type: 'move'; selector?: string; x?: number; y?: number; duration?: number })
  | (Narratable & { type: 'click'; selector: string; duration?: number; settle?: number })
  | (Narratable & { type: 'type'; selector: string; text: string; perChar?: number; clear?: boolean })
  | (Narratable & { type: 'key'; key: string })
  | (Narratable & {
      type: 'select'
      selector: string
      value?: string
      label?: string
      index?: number
      contains?: string
      duration?: number
      settle?: number
    })
  | (Narratable & { type: 'highlight'; selector: string; pad?: number; duration?: number })
  | (Narratable & { type: 'highlightHide' })
  | (Narratable & { type: 'zoom'; selector: string; scale?: number; duration?: number })
  | (Narratable & { type: 'zoomReset'; duration?: number })
  | (Narratable & { type: 'scroll'; selector?: string; y?: number; duration?: number })
  | (Narratable & { type: 'wait'; duration?: number; selector?: string; timeout?: number; timelapse?: number })
  | (Narratable & { type: 'endcard'; title: string; subtitle?: string; duration?: number })

export type Format = 'landscape' | 'square' | 'vertical'

export interface Demo {
  name?: string
  /** The page the demo starts on. */
  url: string
  viewport?: Viewport
  theme?: Theme
  /** Background music track (path). */
  music?: string | null
  /** Music level, 0–1 (default 0.18). */
  musicVolume?: number
  /** Social crops to render (default ['landscape']). */
  formats?: Format[]
  fps?: number
  /** Browser locale for the recording context, e.g. 'it-IT'. */
  locale?: string | null
  /** JS run before the app's own scripts on every page (addInitScript). */
  init?: string
  auth?: Auth
  voice?: Voice
  steps: Step[]
}

export interface RecordOptions {
  out?: string
  formats?: Format[]
  music?: string
  workDir?: string
  keepRaw?: boolean
  onStep?: (i: number, step: Step) => void
  onAuth?: () => void
  onVoice?: (lineCount: number) => void
}

export interface Output {
  format: Format
  path: string
}

export interface Timelapse {
  start: number
  end: number
  factor: number
}

export function defineDemo(demo: Demo): Demo

export function recordDemo(demo: Demo, opts?: RecordOptions): Promise<{ outputs: Output[]; demo: Demo }>

export function runDemo(
  demo: Demo,
  opts?: { workDir?: string; onStep?: (i: number, step: Step) => void; onAuth?: () => void }
): Promise<{
  rawVideoPath: string
  workDir: string
  timelapses: Timelapse[]
  narration: Array<{ text: string; atSec: number }>
}>

export function renderVideo(
  rawVideoPath: string,
  opts?: {
    out?: string
    formats?: Format[]
    music?: string
    musicVolume?: number
    fps?: number
    workDir?: string
    timelapses?: Timelapse[]
    narration?: Array<{ path: string; atSec: number }>
  }
): Promise<Output[]>

export function normalizeDemo(demo: Demo): Required<Omit<Demo, 'theme' | 'music' | 'locale' | 'init' | 'auth' | 'voice'>> &
  Pick<Demo, 'theme' | 'music' | 'locale' | 'init' | 'auth' | 'voice'>

export function estimateDurationMs(demo: Demo): number

export const STEP_TYPES: Record<string, { required: string[] }>
