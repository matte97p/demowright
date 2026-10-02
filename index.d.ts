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
  /** Base colour of motion scenes (default #07070a). */
  background?: string
}

export type ScenePreset = 'title' | 'list' | 'outro'

export type SceneItem = string | { label: string; hint?: string }

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
  | (Narratable & {
      type: 'caption'
      text: string
      duration?: number
      hold?: boolean
      /** 'words' reveals the caption word by word. */
      style?: 'bar' | 'words'
      /** Words of `text` drawn in the theme accent. */
      accent?: string
    })
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
  | (Narratable & {
      type: 'scene'
      title: string
      preset?: ScenePreset
      subtitle?: string
      /** Words of `title` drawn in the theme accent. */
      accent?: string
      /** Required by the 'list' preset. */
      items?: SceneItem[]
      duration?: number
    })
  /** Shorthand for a scene with preset 'outro'. */
  | (Narratable & { type: 'endcard'; title: string; subtitle?: string; duration?: number })

export type Format = 'landscape' | 'square' | 'vertical'

export interface Backdrop {
  /** 'browser' draws an address bar; 'none' just the rounded window. */
  frame?: 'browser' | 'none'
  /** Share of the frame the window takes, 0.5 to 1 (default 0.86). */
  scale?: number
  /** Address bar text; defaults to the host of the demo url. */
  url?: string
}

export interface Demo {
  name?: string
  /** The page the demo starts on. */
  url: string
  viewport?: Viewport
  theme?: Theme
  /** Show the capture as a window over the animated background. */
  backdrop?: boolean | Backdrop
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
  /** Stops the run: the capture between two steps, recordings not started yet. */
  signal?: AbortSignal
  out?: string
  formats?: Format[]
  music?: string
  workDir?: string
  keepRaw?: boolean
  onStep?: (i: number, step: Step) => void
  onAuth?: () => void
  onVoice?: (lineCount: number) => void
  /** Called before each scene recording (one per scene per format). */
  onScene?: (format: Format, sceneIndex: number) => void
  /** Called before the backdrop of each format is made. */
  onBackdrop?: (format: Format) => void
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

/** A scene step of a capture, in order (what runDemo returns). */
export interface SceneStep {
  step: Step
  /** The first step of the demo: the scene also replaces the page load. */
  opening: boolean
}

/** A stretch of the capture replaced by a scene, in seconds, read from the frames. */
export interface SceneRange extends SceneStep {
  start: number
  end: number
  /** The scene runs to the end of the capture. */
  toEnd: boolean
  /** Seconds into the background loop where the scene's background starts. */
  phase?: number
}

/** One cover found in a video: marker 0 or 1, in seconds. */
export interface MarkerRun {
  marker: 0 | 1
  start: number
  end: number
  toEnd: boolean
}

/** One recorded scene clip: used from `offset`, for `length` seconds. */
export interface SceneClip {
  path: string
  offset: number
  length: number
}

export function defineDemo(demo: Demo): Demo

export function recordDemo(demo: Demo, opts?: RecordOptions): Promise<{ outputs: Output[]; demo: Demo }>

export function runDemo(
  demo: Demo,
  opts?: { workDir?: string; onStep?: (i: number, step: Step) => void; onAuth?: () => void; signal?: AbortSignal }
): Promise<{
  rawVideoPath: string
  workDir: string
  timelapses: Timelapse[]
  narration: Array<{ text: string; atSec: number }>
  scenes: SceneStep[]
}>

export interface BackdropAssets {
  background: string
  chrome: string
  mask: string
  shadow: string
  geometry: { W: number; H: number; ww: number; wh: number; hb: number; total: number; x: number; y: number; radius: number }
}

export function recordBackdrop(
  demo: Demo,
  formats: Format[],
  opts?: { workDir?: string; onBackdrop?: (format: Format) => void; signal?: AbortSignal }
): Promise<Partial<Record<Format, BackdropAssets>>>

/** Find the scene covers in a capture, from its frames. */
export function detectMarkerRuns(file: string, opts?: { maxGapSec?: number; minSec?: number }): Promise<MarkerRun[]>

/** Pair scene steps with the covers found in the capture. Throws on a mismatch. */
export function matchScenes(scenes: SceneStep[], runs: MarkerRun[]): SceneRange[]

export function recordScenes(
  demo: Demo,
  scenes: SceneRange[],
  formats: Format[],
  opts?: { workDir?: string; onScene?: (format: Format, sceneIndex: number) => void; signal?: AbortSignal }
): Promise<Partial<Record<Format, SceneClip[]>>>

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
    /** The scene ranges; pass [] to skip looking for covers in a capture without scenes. */
    scenes?: SceneRange[]
    sceneClips?: Partial<Record<Format, SceneClip[]>>
    /** Colour painted over the markers of covers rendered without clips. */
    background?: string
    /** From recordBackdrop: per format, the background loop and the window images. */
    backdropAssets?: Partial<Record<Format, BackdropAssets>>
  }
): Promise<Output[]>

export function normalizeDemo(demo: Demo): Required<Omit<Demo, 'theme' | 'music' | 'locale' | 'init' | 'auth' | 'voice' | 'backdrop'>> &
  Pick<Demo, 'theme' | 'music' | 'locale' | 'init' | 'auth' | 'voice'> & {
    /** null when off; otherwise every field filled in. */
    backdrop: Required<Backdrop> | null
  }

export function estimateDurationMs(demo: Demo): number

export const STEP_TYPES: Record<string, { required: string[] }>
