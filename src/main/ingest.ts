import { spawn } from 'node:child_process'
import { readdirSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Edit, IngestProgress } from '../shared/types.js'
import { mediaDir, thumbsDir } from './paths.js'
import { requireBin } from './bin.js'
import { hasEdit } from './library.js'

type Report = (p: Omit<IngestProgress, 'url'>) => void

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
  // If a merge left both the muxed output and a leftover stream, prefer the biggest.
  matches.sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size)
  return matches[0]
}

/** Pull a still from ~35% in — far enough past the intro to be representative. */
async function makeThumb(mediaPath: string, id: string, durationSec: number): Promise<string | null> {
  const ffmpeg = requireBin('ffmpeg')
  const at = Math.max(0, Math.min(durationSec * 0.35, Math.max(0, durationSec - 0.5)))
  const thumbName = `${id}.jpg`
  const { code } = await run(ffmpeg, [
    '-y',
    '-ss', at.toFixed(2),
    '-i', mediaPath,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '3',
    join(thumbsDir, thumbName)
  ])
  return code === 0 ? thumbName : null
}

async function probeDuration(mediaPath: string): Promise<{ duration: number; width: number; height: number }> {
  try {
    const ffprobe = requireBin('ffprobe')
    const { stdout } = await run(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      mediaPath
    ])
    const parsed = JSON.parse(stdout)
    return {
      duration: Number(parsed?.format?.duration) || 0,
      width: Number(parsed?.streams?.[0]?.width) || 0,
      height: Number(parsed?.streams?.[0]?.height) || 0
    }
  } catch {
    return { duration: 0, width: 0, height: 0 }
  }
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
  const probe = await run(ytdlp, ['-J', '--no-playlist', '--no-warnings', url])
  if (probe.code !== 0) {
    throw new Error(probe.stderr.split('\n').filter(Boolean).pop() || 'yt-dlp could not read that URL')
  }

  let info: ProbeInfo
  try {
    info = JSON.parse(probe.stdout) as ProbeInfo
  } catch {
    throw new Error('yt-dlp returned something that was not video metadata')
  }

  const id = slugId(`${info.extractor_key ?? 'web'}-${info.id ?? randomBytes(4).toString('hex')}`)
  if (hasEdit(id)) throw new Error('already in your library')

  report({ stage: 'downloading', percent: 0, message: info.title ?? 'downloading…' })
  const dl = await run(
    ytdlp,
    [
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '-f', 'bv*+ba/b',
      // Prefer h264/aac in mp4 — Chromium plays that everywhere without a fight.
      '-S', 'res:1080,vcodec:h264,acodec:aac,ext:mp4:m4a',
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '-o', join(mediaDir, `${id}.%(ext)s`),
      url
    ],
    (line) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(line)
      if (m) {
        report({ stage: 'downloading', percent: Number(m[1]) / 100, message: info.title ?? 'downloading…' })
      } else if (/^\[(Merger|VideoRemuxer|ExtractAudio)\]/.test(line)) {
        report({ stage: 'processing', percent: 1, message: 'muxing…' })
      }
    }
  )
  if (dl.code !== 0) {
    throw new Error(dl.stderr.split('\n').filter(Boolean).pop() || 'download failed')
  }

  const file = findMediaFile(mediaDir, id)
  if (!file) throw new Error('download finished but no video file landed on disk')

  report({ stage: 'processing', percent: 1, message: 'grabbing a frame…' })
  const mediaPath = join(mediaDir, file)
  const probed = await probeDuration(mediaPath)
  const durationSec = probed.duration || info.duration || 0
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
    width: probed.width || info.width || 0,
    height: probed.height || info.height || 0
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
  const probed = await probeDuration(mediaPath)
  let thumb: string | null = null
  try {
    thumb = await makeThumb(mediaPath, id, probed.duration)
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
    durationSec: probed.duration,
    width: probed.width,
    height: probed.height
  })
}

/** Clear yt-dlp scratch files (.part/.ytdl) left behind by an aborted download. */
export function sweepPartials(): void {
  for (const f of readdirSync(mediaDir)) {
    if (f.endsWith('.part') || f.endsWith('.ytdl')) rmSync(join(mediaDir, f), { force: true })
  }
}
