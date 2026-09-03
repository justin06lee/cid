import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * A GUI Electron app launched from Finder inherits a bare PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) — Homebrew is not on it. So resolve external
 * binaries by looking in the usual places ourselves rather than trusting spawn
 * to find them, which would work in `bun dev` and fail in the packaged .app.
 */
const SEARCH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/local/bin',
  `${process.env.HOME}/.local/bin`,
  '/usr/bin',
  '/bin'
]

const cache = new Map<string, string | null>()

export function resolveBin(name: string): string | null {
  const hit = cache.get(name)
  if (hit !== undefined) return hit

  let found: string | null = null
  for (const dir of SEARCH_DIRS) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) {
      found = candidate
      break
    }
  }
  if (!found) {
    // Last resort: ask a login shell, which does source the user's profile.
    try {
      const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', `command -v ${name}`], {
        encoding: 'utf8',
        timeout: 5000
      }).trim()
      if (out && existsSync(out)) found = out
    } catch {
      found = null
    }
  }
  cache.set(name, found)
  return found
}

export function requireBin(name: string): string {
  const path = resolveBin(name)
  if (!path) {
    throw new Error(
      `${name} not found. Install it with: brew install ${name === 'ffprobe' ? 'ffmpeg' : name}`
    )
  }
  return path
}
