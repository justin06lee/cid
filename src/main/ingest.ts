import { spawn } from 'node:child_process'
import { readdirSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Edit, IngestProgress } from '../shared/types.js'
import { mediaDir, thumbsDir } from './paths.js'
import { requireBin, resolveBin } from './bin.js'
import { hasEdit, allEdits } from './library.js'

type Report = (p: Omit<IngestProgress, 'url'>) => void

interface ProbeFormat {
  vcodec?: string
  acodec?: string
  height?: number
}

interface ProbeInfo {
  id?: string
  extractor_key?: string
  title?: string
  description?: string
  uploader?: string
  channel?: string
  tags?: string[]
  categories?: string[]
  duration?: number
  width?: number
  height?: number
  webpage_url?: string
  formats?: ProbeFormat[]
}

function run(
  bin: string,
  args: string[],
  onLine?: (line: string, stream: 'out' | 'err') => void
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let outBuf = ''
    let errBuf = ''

    const pump = (
      chunk: string,
      buf: string,
      stream: 'out' | 'err'
    ): string => {
      buf += chunk
      const lines = buf.split(/\r?\n|\r/)
      buf = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine?.(line, stream)
      return buf
    }

    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString()
      stdout += s
      if (onLine) outBuf = pump(s, outBuf, 'out')
    })
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      if (onLine) errBuf = pump(s, errBuf, 'err')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * YouTube rotates which internal player clients it will serve media to, and the
 * one yt-dlp picks by default periodically starts answering 403 mid-download —
 * as it did while this was being written, where the default resolved formats
 * fine and then refused the actual bytes, while `mweb` worked. Pinning a single
 * client would just move the breakage, so each attempt is tried in turn and the
 * first that works is reused for the rest of the ingest.
 */
const PLAYER_CLIENTS: string[][] = [
  [], // whatever yt-dlp thinks is best today
  ['--extractor-args', 'youtube:player_client=mweb'],
  ['--extractor-args', 'youtube:player_client=web_embedded,tv_embedded'],
  ['--extractor-args', 'youtube:player_client=web_safari,ios,tv']
]

/**
 * Retrying only helps when the failure is YouTube gatekeeping. A deleted or
 * private video fails identically on every client, so don't spend four round
 * trips discovering that.
 */
function looksGateKept(stderr: string): boolean {
  return /403|forbidden|no video formats|needs to be reloaded|sign in to confirm|failed to extract|player response|throttl/i.test(
    stderr
  )
}

/**
 * Failures no amount of retrying fixes: the video isn't there, or isn't ours to
 * have. Worth detecting separately from gatekeeping so a dead link reports in a
 * second or two instead of grinding through every client and every format.
 */
function looksFatal(stderr: string): boolean {
  return /private video|has been removed|does not exist|no video could be found|unavailable in your|account associated|is not available|removed by the uploader/i.test(
    stderr
  )
}

/**
 * Escape hatch for the cases no player client fixes — age-gated or
 * login-walled videos. `CID_COOKIES_FROM_BROWSER=chrome` (or firefox, safari,
 * brave…) lends yt-dlp your existing session.
 */
function userArgs(): string[] {
  const out: string[] = []
  const browser = process.env.CID_COOKIES_FROM_BROWSER?.trim()
  if (browser) out.push('--cookies-from-browser', browser)
  const extra = process.env.CID_YTDLP_ARGS?.trim()
  if (extra) out.push(...extra.split(/\s+/))
  return out
}

interface Attempt {
  result: { code: number; stdout: string; stderr: string }
  /** The client flags that worked, so the download can skip straight to them. */
  variant: string[]
}

async function runYtdlp(
  bin: string,
  args: string[],
  preferred: string[] | null,
  onLine?: (line: string, stream: 'out' | 'err') => void
): Promise<Attempt> {
  const ladder = preferred
    ? [preferred, ...PLAYER_CLIENTS.filter((v) => v.join() !== preferred.join())]
    : PLAYER_CLIENTS

  let last: Attempt | null = null
  for (const variant of ladder) {
    const result = await run(bin, [...args, ...variant, ...userArgs()], onLine)
    if (result.code === 0) return { result, variant }
    last = { result, variant }
    if (looksFatal(result.stderr) || !looksGateKept(result.stderr)) break
  }
  return last!
}

function ytdlpError(stderr: string, fallback: string): Error {
  const line = stderr.split('\n').filter(Boolean).pop() || fallback
  if (/sign in to confirm|age|private|login|cookies/i.test(stderr)) {
    return new Error(
      `${line} — try relaunching with CID_COOKIES_FROM_BROWSER=chrome (or firefox/safari/brave)`
    )
  }
  return new Error(line)
}

/* ── what to download ─────────────────────────────────────────────────── */

/** Anything taller than this is downscaled. `CID_MAX_HEIGHT` overrides it. */
function maxHeight(): number {
  const raw = Number(process.env.CID_MAX_HEIGHT)
  return Number.isFinite(raw) && raw >= 144 ? Math.floor(raw) : 1440
}

/**
 * Quality first, then a codec this machine can decode cheaply.
 *
 * The order is the whole point. `res,fps` come before `vcodec`, so a 1440p
 * stream beats a 1080p one whatever it's encoded with, but at equal resolution
 * h264 still wins — it's the only codec Apple Silicon decodes in hardware. The
 * previous sort led with `res:1080,vcodec:h264`, and since h264 is the last
 * codec YouTube publishes above 1080p, asking for it *was* the resolution cap.
 *
 * `+hdr` prefers SDR on purpose: Chromium tone-maps HDR into an SDR window
 * badly, and a washed-out grey edit next to a grid of normal ones reads as a
 * broken download rather than as a colour-management subtlety.
 */
const FORMAT_SORT = 'res,fps,+hdr,vcodec:h264,acodec:aac,ext:mp4:m4a'

interface Rung {
  label: string
  format: string
}

/**
 * Tried in order until one produces a file that actually holds both a picture
 * and a sound. They trade quality for how many ways the audio can go missing:
 * the first merges the two best separate streams, the last takes a file that
 * was already muxed at the source and therefore cannot lose its audio in the
 * process of being put together.
 */
function formatLadder(maxH: number): Rung[] {
  return [
    { label: 'best', format: `bv*[height<=?${maxH}]+ba/bv*+ba` },
    {
      label: 'mp4-native',
      format: `bv*[height<=?${maxH}][ext=mp4]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]`
    },
    { label: 'pre-muxed', format: `b[height<=?${maxH}]/b` }
  ]
}

/**
 * Whether the source has any audio at all. Some edits are genuinely silent, and
 * those must not be retried three times and then rejected for missing a track
 * that was never there.
 */
function sourceHasAudio(info: ProbeInfo): boolean {
  const formats = info.formats
  // No format list (or a single pre-muxed file): assume there is audio, since
  // guessing wrong the other way silently accepts a mute download.
  if (!formats || formats.length === 0) return true
  return formats.some((f) => f.acodec && f.acodec !== 'none')
}

/* ── what actually landed ─────────────────────────────────────────────── */

interface MediaFacts {
  duration: number
  width: number
  height: number
  hasVideo: boolean
  hasAudio: boolean
  vcodec: string | null
  acodec: string | null
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  disposition?: Record<string, number>
}

/**
 * Read the streams a file really contains. Returns null when ffprobe isn't
 * installed — unverifiable is not the same as bad, and the app already tells
 * you to install ffmpeg rather than refusing to work without it.
 */
async function probeMedia(mediaPath: string): Promise<MediaFacts | null> {
  const ffprobe = resolveBin('ffprobe')
  if (!ffprobe) return null
  try {
    const { stdout } = await run(ffprobe, [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      mediaPath
    ])
    const parsed = JSON.parse(stdout) as {
      streams?: FfprobeStream[]
      format?: { duration?: string }
    }
    const streams = parsed.streams ?? []
    // Cover art is carried as a video stream. Counting it as the picture is how
    // an audio-only file passes for a video.
    const video = streams.find(
      (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
    )
    const audio = streams.find((s) => s.codec_type === 'audio')
    return {
      duration: Number(parsed.format?.duration) || 0,
      width: Number(video?.width) || 0,
      height: Number(video?.height) || 0,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      vcodec: video?.codec_name ?? null,
      acodec: audio?.codec_name ?? null
    }
  } catch {
    return null
  }
}

/** Keep ids safe as filenames and as cid:// path segments. */
function slugId(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)
  return clean || randomBytes(6).toString('hex')
}

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi'])

function findMediaFile(dir: string, id: string): string | null {
  const matches = readdirSync(dir).filter(
    (f) => f.startsWith(`${id}.`) && VIDEO_EXTS.has(extname(f).toLowerCase())
  )
  if (matches.length === 0) return null
  // The merged output is exactly `<id>.<ext>`. Per-stream leftovers carry the
  // format id (`<id>.f299.mp4`) and must never win however large they are: one
  // of them is routinely an audio-only .mp4, and adopting it puts an edit in
  // the library that opens to a black rectangle.
  const merged = matches.filter((f) => basename(f, extname(f)) === id)
  const pool = merged.length > 0 ? merged : matches
  pool.sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size)
  return pool[0]
}

/** Drop every scratch file yt-dlp wrote for this id, optionally sparing one. */
function sweepId(id: string, keep?: string | null): void {
  for (const f of readdirSync(mediaDir)) {
    if (!f.startsWith(`${id}.`) || f === keep) continue
    rmSync(join(mediaDir, f), { force: true })
  }
}

/**
 * Pull a still from ~35% in — far enough past the intro to be representative.
 * `thumbnail` then picks the most distinctive frame out of the next couple of
 * seconds, which is what keeps posters off the fades and hard cuts that a
 * fixed offset lands on surprisingly often.
 */
async function makeThumb(mediaPath: string, id: string, durationSec: number): Promise<string | null> {
  const ffmpeg = requireBin('ffmpeg')
  const at = Math.max(0, Math.min(durationSec * 0.35, Math.max(0, durationSec - 0.5)))
  const thumbName = `${id}.jpg`
  const { code } = await run(ffmpeg, [
    '-y',
    '-ss', at.toFixed(2),
    '-i', mediaPath,
    '-an', '-sn',
    '-frames:v', '1',
    '-vf', 'thumbnail=60,scale=720:-2',
    '-q:v', '2',
    join(thumbsDir, thumbName)
  ])
  return code === 0 ? thumbName : null
}

function newEdit(fields: Partial<Edit> & Pick<Edit, 'id' | 'file' | 'title'>): Edit {
  return {
    thumb: null,
    description: '',
    uploader: null,
    sourceUrl: null,
    tags: [],
    moods: [],
    moodScores: {},
    durationSec: 0,
    width: 0,
    height: 0,
    hasAudio: true,
    addedAt: Date.now(),
    playCount: 0,
    lastPlayedAt: null,
    starred: false,
    ...fields
  }
}

export async function addFromUrl(url: string, report: Report): Promise<Edit> {
  const ytdlp = requireBin('yt-dlp')

  report({ stage: 'resolving', percent: null, message: 'reading the page…' })
  const probe = await runYtdlp(ytdlp, ['-J', '--no-playlist', '--no-warnings', url], null)
  if (probe.result.code !== 0) {
    throw ytdlpError(probe.result.stderr, 'yt-dlp could not read that URL')
  }

  let info: ProbeInfo
  try {
    info = JSON.parse(probe.result.stdout) as ProbeInfo
  } catch {
    throw new Error('yt-dlp returned something that was not video metadata')
  }

  const id = slugId(`${info.extractor_key ?? 'web'}-${info.id ?? randomBytes(4).toString('hex')}`)
  if (hasEdit(id)) throw new Error('already in your library')

  const title = info.title?.trim() || 'downloading…'
  const wantAudio = sourceHasAudio(info)
  let variant = probe.variant
  let file: string | null = null
  let facts: MediaFacts | null = null
  let problem = 'download failed'

  try {
    for (const rung of formatLadder(maxHeight())) {
      // Nothing from a previous rung may survive into this one — findMediaFile
      // would happily adopt the last attempt's orphaned audio stream.
      sweepId(id)
      report({ stage: 'downloading', percent: 0, message: title })

      const dl = await runYtdlp(
        ytdlp,
        [
          '--no-playlist',
          '--no-warnings',
          '--newline',
          // DASH and HLS sources arrive as hundreds of small fragments; fetching
          // a few at a time is most of the wall-clock difference on a long edit.
          '--concurrent-fragments', '4',
          '-f', rung.format,
          '-S', FORMAT_SORT,
          '--merge-output-format', 'mp4',
          '--remux-video', 'mp4',
          '-o', join(mediaDir, `${id}.%(ext)s`),
          url
        ],
        variant,
        (line) => {
          const m = /\[download\]\s+([\d.]+)%/.exec(line)
          if (m) {
            report({ stage: 'downloading', percent: Number(m[1]) / 100, message: title })
          } else if (/^\[(Merger|VideoRemuxer|ExtractAudio)\]/.test(line)) {
            report({ stage: 'processing', percent: 1, message: 'muxing…' })
          }
        }
      )

      if (dl.result.code !== 0) {
        if (looksFatal(dl.result.stderr)) throw ytdlpError(dl.result.stderr, 'download failed')
        problem = ytdlpError(dl.result.stderr, 'download failed').message
        continue
      }
      variant = dl.variant

      const candidate = findMediaFile(mediaDir, id)
      if (!candidate) {
        problem = 'download finished but no video file landed on disk'
        continue
      }

      const probed = await probeMedia(join(mediaDir, candidate))
      // No ffprobe means no verdict. Take the file rather than refusing to work.
      if (!probed) {
        file = candidate
        break
      }
      if (!probed.hasVideo) {
        problem = 'that came back as audio only, with no picture'
        continue
      }
      if (wantAudio && !probed.hasAudio) {
        problem = 'the audio track went missing while the streams were merged'
        continue
      }

      file = candidate
      facts = probed
      break
    }

    if (!file) throw new Error(problem)
    // Keep the winner, bin every fragment and false start around it.
    sweepId(id, file)
  } catch (err) {
    sweepId(id)
    throw err
  }

  report({ stage: 'processing', percent: 1, message: 'grabbing a frame…' })
  const mediaPath = join(mediaDir, file)
  const durationSec = facts?.duration || info.duration || 0
  const thumb = await makeThumb(mediaPath, id, durationSec)

  return newEdit({
    id,
    file,
    thumb,
    title: info.title?.trim() || basename(file, extname(file)),
    description: info.description?.trim() ?? '',
    uploader: info.uploader ?? info.channel ?? null,
    sourceUrl: info.webpage_url ?? url,
    // The uploader's own tags are free, hand-written vibe signal — keep them.
    tags: [...new Set([...(info.tags ?? []), ...(info.categories ?? [])])]
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 24),
    durationSec,
    width: facts?.width || info.width || 0,
    height: facts?.height || info.height || 0,
    // Unverifiable counts as "has audio": the badge exists to explain a silent
    // edit, not to cast doubt on every edit added without ffprobe installed.
    hasAudio: facts ? facts.hasAudio : true
  })
}

/** Adopt a file you already downloaded yourself. Copies it into the library. */
export async function addFromFile(sourcePath: string, report: Report): Promise<Edit> {
  const ext = extname(sourcePath).toLowerCase()
  if (!VIDEO_EXTS.has(ext)) throw new Error(`${ext || 'that'} is not a video file`)

  const id = slugId(`local-${basename(sourcePath, ext)}-${randomBytes(3).toString('hex')}`)
  const file = `${id}${ext}`

  report({ stage: 'processing', percent: null, message: 'copying into the library…' })
  copyFileSync(sourcePath, join(mediaDir, file))

  const mediaPath = join(mediaDir, file)
  const facts = await probeMedia(mediaPath)
  if (facts && !facts.hasVideo) {
    rmSync(mediaPath, { force: true })
    throw new Error('that file has no video track')
  }

  let thumb: string | null = null
  try {
    thumb = await makeThumb(mediaPath, id, facts?.duration ?? 0)
  } catch {
    // A missing thumbnail is cosmetic; the edit is still perfectly playable.
    thumb = null
  }

  return newEdit({
    id,
    file,
    thumb,
    // Filenames from yt-dlp/downloaders usually carry the original title.
    title: basename(sourcePath, ext).replace(/[_.]+/g, ' ').trim(),
    durationSec: facts?.duration ?? 0,
    width: facts?.width ?? 0,
    height: facts?.height ?? 0,
    hasAudio: facts ? facts.hasAudio : true
  })
}

/**
 * `<id>.f299.mp4`, `<id>.fdash-1790554372399339a.m4a` — yt-dlp's per-stream
 * files, left behind whenever a merge never happened.
 *
 * Anchored end to end rather than just looking for `.f`, because the media
 * folder is the user's own and this deletes things. An id from slugId() is
 * only `[A-Za-z0-9_-]`, so a real library file has exactly one dot and a
 * leftover exactly two — which is what keeps `holiday.footage.final.mov` (too
 * many dots) and `My Edit v2.1.mp4` (spaces, and no `f`) out of the net.
 */
const STREAM_LEFTOVER = /^[A-Za-z0-9_-]+\.f[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/

/**
 * Clear scratch files left behind by an aborted download.
 *
 * Only safe to call when nothing is in flight — hence startup, and not after
 * each ingest, where it would delete a concurrent download's `.part` out from
 * under it. Anything the library points at is spared regardless.
 */
export function sweepPartials(): void {
  const live = new Set(allEdits().map((e) => e.file))
  for (const f of readdirSync(mediaDir)) {
    if (live.has(f)) continue
    if (f.endsWith('.part') || f.endsWith('.ytdl') || STREAM_LEFTOVER.test(f)) {
      rmSync(join(mediaDir, f), { force: true })
    }
  }
}
