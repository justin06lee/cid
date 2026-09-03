import { protocol } from 'electron'
import { createReadStream, statSync, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join, basename, extname } from 'node:path'
import { mediaDir, thumbsDir } from './paths.js'

/**
 * Media is served over a custom `cid://` scheme rather than file://, because the
 * renderer is a localhost/file page and Chromium blocks it from reading arbitrary
 * file:// URLs. Registering our own scheme also lets us implement Range properly,
 * which `net.fetch(file://)` does not — without it, <video> can play but not seek.
 *
 *   cid://media/<filename>
 *   cid://thumb/<filename>
 */
export function registerCidScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'cid',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
    }
  ])
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

export function handleCidProtocol(): void {
  protocol.handle('cid', async (request) => {
    const url = new URL(request.url)
    const root = url.host === 'thumb' ? thumbsDir : url.host === 'media' ? mediaDir : null
    if (!root) return new Response('unknown cid host', { status: 404 })

    // basename() collapses any ../ before it can escape the library dir.
    const name = basename(decodeURIComponent(url.pathname))
    const path = join(root, name)
    if (!name || !existsSync(path)) return new Response('not found', { status: 404 })

    const size = statSync(path).size
    const type = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.get('Range')

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        const start = m[1] ? Number(m[1]) : 0
        const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
        if (start >= size || start > end) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` }
          })
        }
        const stream = Readable.toWeb(
          createReadStream(path, { start, end })
        ) as unknown as ReadableStream<Uint8Array>
        return new Response(stream, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        })
      }
    }

    const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }
    })
  })
}
