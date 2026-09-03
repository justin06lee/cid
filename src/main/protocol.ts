import { protocol } from 'electron'
import { createReadStream, statSync, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join, basename, extname, normalize } from 'node:path'
import { mediaDir, thumbsDir } from './paths.js'

/**
 * Everything the renderer loads comes over a custom `cid://` scheme:
 *
 *   cid://app/index.html   the packaged renderer
 *   cid://media/<file>     a video from the library
 *   cid://thumb/<file>     its poster frame
 *
 * The app page is served from here rather than file:// for a specific reason:
 * onnxruntime-web boots by wrapping its wasm glue in a Blob and import()ing the
 * blob: URL, and a file:// page has an opaque origin that cannot import modules.
 * Under cid://app the page has a real origin and the embedder loads.
 *
 * Media needs its own scheme regardless: Chromium won't let the page read
 * arbitrary file:// URLs, and `net.fetch(file://)` ignores Range, so <video>
 * could play but never seek.
 */
export function registerCidScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'cid',
      // No bypassCSP: the page's own Content-Security-Policy should still apply
      // to everything it loads, including our media.
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** Where the built renderer lives; set by main before the first load. */
let rendererDir: string | null = null

export function serveRendererFrom(dir: string): void {
  rendererDir = dir
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
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
    const decoded = decodeURIComponent(url.pathname)

    let path: string
    if (url.host === 'app') {
      if (!rendererDir) return new Response('renderer not mounted', { status: 500 })
      // The renderer has nested asset paths, so normalize the whole path and
      // then verify it stayed inside the bundle.
      const target = normalize(join(rendererDir, decoded === '/' ? '/index.html' : decoded))
      if (!target.startsWith(rendererDir)) return new Response('forbidden', { status: 403 })
      path = target
    } else {
      const root = url.host === 'thumb' ? thumbsDir : url.host === 'media' ? mediaDir : null
      if (!root) return new Response('unknown cid host', { status: 404 })
      // basename() collapses any ../ before it can escape the library dir.
      const name = basename(decoded)
      if (!name) return new Response('not found', { status: 404 })
      path = join(root, name)
    }

    if (!existsSync(path)) return new Response('not found', { status: 404 })
    const name = basename(path)

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
