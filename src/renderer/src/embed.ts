import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
// Reached by path rather than by package name on purpose: onnxruntime-web's
// exports map does not expose ./dist, so the bare specifier is unresolvable.
import ortWasm from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url'
import ortMjs from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url'
import { EMBED_MODEL, MOOD_AXES } from '@shared/moods'

// The renderer is Chromium, so run onnxruntime-web. Weights come from the HF CDN
// on first launch and are then served out of the browser cache — cid needs the
// network exactly once, and works offline forever after.
env.allowLocalModels = false
env.useBrowserCache = true

// Left alone, onnxruntime fetches its ~23MB runtime from jsDelivr on every cold
// cache. Vite already emits that exact file into the bundle, so point ort at the
// local copy: same download size on disk, one less thing that can be offline.
// `runtimeFellBack` records if we ever have to undo this.
const ortWasmEnv = env.backends.onnx.wasm!
ortWasmEnv.wasmPaths = { wasm: ortWasm, mjs: ortMjs }
let runtimeFellBack = false

export type ModelStatus =
  | { state: 'idle' }
  | { state: 'loading'; percent: number; label: string }
  | { state: 'ready' }
  | { state: 'error'; message: string }

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

export function loadModel(onStatus: (s: ModelStatus) => void): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise

  const fileProgress = new Map<string, number>()
  extractorPromise = pipeline('feature-extraction', EMBED_MODEL, {
    // q8 weights are ~4x smaller to download and the ranking difference on
    // short titles is not perceptible.
    dtype: 'q8',
    progress_callback: (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === 'progress' && p.file) {
        fileProgress.set(p.file, p.progress ?? 0)
        const values = [...fileProgress.values()]
        const percent = values.reduce((a, b) => a + b, 0) / values.length / 100
        onStatus({ state: 'loading', percent, label: 'fetching the model' })
      } else if (p.status === 'initiate') {
        onStatus({ state: 'loading', percent: 0, label: 'fetching the model' })
      }
    }
  })
    .then((ex) => {
      onStatus({ state: 'ready' })
      return ex as FeatureExtractionPipeline
    })
    .catch((err: unknown) => {
      // Let a later call retry rather than caching the rejection forever.
      extractorPromise = null

      // The bundled runtime is one specific ort build. If transformers ever asks
      // for a different one, the local override is the thing that broke it — drop
      // it and let ort fetch the variant it actually wants.
      if (!runtimeFellBack) {
        runtimeFellBack = true
        console.warn('[cid] bundled onnx runtime rejected, falling back to the CDN', err)
        ortWasmEnv.wasmPaths = undefined
        return loadModel(onStatus)
      }

      const message = err instanceof Error ? err.message : String(err)
      console.error('[cid] embedding model failed to load', err)
      onStatus({ state: 'error', message })
      throw err
    })

  return extractorPromise
}

/** Embed a batch of texts into unit-length vectors (so cosine == dot product). */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const extractor = await loadModel(() => {})
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  const dim = output.dims[output.dims.length - 1]
  const data = output.data as Float32Array
  return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim))
}

export async function embedOne(text: string): Promise<Float32Array> {
  const [vec] = await embed([text])
  return vec
}

let axisVectors: Map<string, Float32Array> | null = null

async function getAxisVectors(): Promise<Map<string, Float32Array>> {
  if (axisVectors) return axisVectors
  const vecs = await embed(MOOD_AXES.map((m) => m.blurb))
  axisVectors = new Map(MOOD_AXES.map((m, i) => [m.key, vecs[i]]))
  return axisVectors
}

export function dot(a: Float32Array | number[], b: Float32Array | number[]): number {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) sum += a[i] * b[i]
  return sum
}

export interface MoodProfile {
  moods: string[]
  scores: Record<string, number>
}

/**
 * Anything whose best axis falls below this isn't really about any of them.
 *
 * Genuine edits land at 0.35–0.57 on their top axis with daylight to the runner
 * up; a video that isn't an edit at all scored a flat 0.23/0.21/0.20 across the
 * board — no axis fits, so the ranking is just noise. Rather than stamp three
 * arbitrary chips on it, leave it unplaced. Changing this needs a
 * LIBRARY_EMBED_VERSION bump, since moods are computed once at embed time.
 */
const MIN_MOOD_SCORE = 0.28

/**
 * Score an edit's vector against every mood axis.
 *
 * Past that floor the cut is relative rather than absolute: raw cosine between a
 * short edit title and a long mood blurb sits in a narrow band, so a fixed
 * threshold either tags everything or nothing. Taking the top axis plus anything
 * within 85% of it gives one to three chips that actually distinguish an edit.
 */
export async function moodProfile(vec: Float32Array): Promise<MoodProfile> {
  const axes = await getAxisVectors()
  const scored = MOOD_AXES.map((m) => ({ key: m.key, score: dot(vec, axes.get(m.key)!) })).sort(
    (a, b) => b.score - a.score
  )
  const best = scored[0]?.score ?? 0
  const moods =
    best < MIN_MOOD_SCORE
      ? []
      : scored
          .filter((s, i) => i === 0 || s.score >= best * 0.85)
          .slice(0, 3)
          .map((s) => s.key)
  const scores: Record<string, number> = {}
  for (const s of scored) scores[s.key] = Number(s.score.toFixed(4))
  return { moods, scores }
}

