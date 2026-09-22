import { app, BrowserWindow, screen, shell } from 'electron'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = fileURLToPath(new URL('.', import.meta.url))

/** Roughly a phone held upright — most edits are 9:16, so this is the native shape. */
export const OVERLAY_WIDTH = 400
export const OVERLAY_HEIGHT = 712

const preload = join(dirname, '../preload/index.mjs')

/**
 * Which face of the app a window is showing. The renderer reads this off the
 * hash, so both windows share one bundle and one build.
 */
type Face = 'library' | 'overlay'

function pageUrl(face: Face): string {
  const hash = face === 'overlay' ? '#overlay' : ''
  if (process.env.ELECTRON_RENDERER_URL) return `${process.env.ELECTRON_RENDERER_URL}/${hash}`
  // Not loadFile: a file:// page has an opaque origin, and onnxruntime-web
  // boots by import()ing a blob: module, which opaque origins can't do.
  return `cid://app/index.html${hash}`
}

let library: BrowserWindow | null = null
let overlay: BrowserWindow | null = null

/**
 * cid is a menubar app that happens to have a library window. The dock icon
 * follows that window rather than being hidden outright, because an
 * accessory-only app gets no application menu — and no menu means no ⌘V in the
 * "paste a link" field, which is the app's main way in.
 */
export function syncDock(): void {
  if (process.platform !== 'darwin') return
  const open = library !== null && !library.isDestroyed()
  if (open) void app.dock?.show()
  else app.dock?.hide()
}

export function getLibraryWindow(): BrowserWindow | null {
  return library && !library.isDestroyed() ? library : null
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null
}

export function showLibrary(): BrowserWindow {
  const existing = getLibraryWindow()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    app.focus({ steal: true })
    return existing
  }

  library = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#07070a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      // electron-vite emits .mjs here because the package is type:module, and
      // Electron only treats a preload as ESM when the extension says so.
      preload,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // Chromium refuses to autoplay with sound without a user gesture, and
      // both the library player and the panel start playing on their own.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  library.once('ready-to-show', () => {
    library?.show()
    app.focus({ steal: true })
  })

  library.on('closed', () => {
    library = null
    syncDock()
  })

  library.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  void library.loadURL(pageUrl('library'))
  syncDock()
  return library
}

function ensureOverlay(): BrowserWindow {
  const existing = getOverlayWindow()
  if (existing) return existing

  overlay = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    // Transparent so the renderer can round its own corners; a square-cornered
    // slab floating over everything looks like a bug.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      // A hidden window is throttled to ~1fps by default, which makes the first
      // second after a summon stutter.
      backgroundThrottling: false
    }
  })

  // 'floating' rather than the default: high enough to sit over ordinary
  // windows, low enough that it never covers a system alert.
  overlay.setAlwaysOnTop(true, 'floating')
  // The point of a summonable panel is that it shows up wherever you already
  // are, including on top of a fullscreen app.
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  overlay.on('closed', () => {
    overlay = null
  })

  // Fires for our own setBounds too; rememberIfMoved tells the two apart.
  overlay.on('move', () => {
    if (overlay) rememberIfMoved(overlay)
  })

  overlay.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  void overlay.loadURL(pageUrl('overlay'))
  return overlay
}

/* ── where the panel sits ──────────────────────────────────────────────────
   Until you move it, every summon centres the panel on whichever screen the
   pointer is on. Drag it somewhere and that spot is where it lives from then
   on — across summons and across launches — until the menu bar menu puts it
   back in the middle. */

interface Point {
  x: number
  y: number
}

/** Where the user left the panel, or null if they never moved it. */
let pinned: Point | null = null
let pinnedLoaded = false
/** Where cid itself last put it — how a drag is told apart from our own setBounds. */
let placed: Point | null = null
let pinnedSaveTimer: NodeJS.Timeout | null = null

function pinnedFile(): string {
  return join(app.getPath('userData'), 'panel.json')
}

function loadPinned(): void {
  if (pinnedLoaded) return
  pinnedLoaded = true
  try {
    const p = JSON.parse(readFileSync(pinnedFile(), 'utf8')) as Partial<Point>
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) pinned = { x: p.x!, y: p.y! }
  } catch {
    // No file yet, or one we can't read: either way, centre it.
  }
}

function writePinned(): void {
  pinnedSaveTimer = null
  try {
    if (pinned) writeFileSync(pinnedFile(), JSON.stringify(pinned))
    else rmSync(pinnedFile(), { force: true })
  } catch (err) {
    console.warn('[cid] could not save the panel position:', err)
  }
}

/** Write any pending position now — called on quit, so a last drag isn't lost. */
export function flushPanelPosition(): void {
  if (!pinnedSaveTimer) return
  clearTimeout(pinnedSaveTimer)
  writePinned()
}

function rememberIfMoved(win: BrowserWindow): void {
  const [x, y] = win.getPosition()
  if (placed && Math.abs(x - placed.x) <= 1 && Math.abs(y - placed.y) <= 1) return
  pinned = { x, y }
  placed = pinned
  // 'move' fires continuously through a drag on macOS; write once it settles.
  if (pinnedSaveTimer) clearTimeout(pinnedSaveTimer)
  pinnedSaveTimer = setTimeout(writePinned, 300)
}

export function isOverlayPinned(): boolean {
  loadPinned()
  return pinned !== null
}

/** Forget the dragged-to spot; the panel goes back to centring under the pointer. */
export function resetOverlayPosition(): void {
  pinnedLoaded = true
  pinned = null
  if (pinnedSaveTimer) clearTimeout(pinnedSaveTimer)
  writePinned()
  const win = getOverlayWindow()
  if (win?.isVisible()) placeOverlay(win)
}

/**
 * `p` if the panel is still reachable there, pulled fully onto its screen if it
 * now hangs off an edge (a resolution change, a rearranged display). Null when
 * nothing of it would show — the monitor it lived on is unplugged — because a
 * panel summoned somewhere invisible looks exactly like the shortcut broke.
 */
function stillOnScreen(p: Point): Point | null {
  const rect = { ...p, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }
  const { bounds } = screen.getDisplayMatching(rect)
  const overlapsX = rect.x < bounds.x + bounds.width && rect.x + rect.width > bounds.x
  const overlapsY = rect.y < bounds.y + bounds.height && rect.y + rect.height > bounds.y
  if (!overlapsX || !overlapsY) return null
  // max-of-min rather than min-of-max: on a screen shorter than the panel, keep
  // the top — and the search box — on screen, not the bottom.
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))
  return {
    x: clamp(p.x, bounds.x, bounds.x + bounds.width - OVERLAY_WIDTH),
    y: clamp(p.y, bounds.y, bounds.y + bounds.height - OVERLAY_HEIGHT)
  }
}

/** Centre it on whichever screen the pointer is on, not always the primary one. */
function centredUnderPointer(): Point {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + (workArea.height - OVERLAY_HEIGHT) / 2)
  }
}

function placeOverlay(win: BrowserWindow): void {
  loadPinned()
  const spot = (pinned && stillOnScreen(pinned)) ?? centredUnderPointer()
  // Set before moving: the 'move' this causes must read as ours, not a drag.
  placed = spot
  win.setBounds({ ...spot, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT })
}

export function showOverlay(): void {
  const win = ensureOverlay()
  // Already up — a second launch, the tray menu — so leave it where it is
  // rather than yanking it back to its saved spot mid-drag.
  if (!win.isVisible()) placeOverlay(win)
  win.show()
  // With the dock icon hidden the app is an accessory, and showing a window
  // does not by itself make the app active — without this the panel appears
  // but keystrokes keep going to whatever you were using.
  app.focus({ steal: true })
  win.focus()
  win.webContents.send('overlay:shown')
}

export function hideOverlay(): void {
  const win = getOverlayWindow()
  if (!win || !win.isVisible()) return
  // Tell the renderer first: hiding a window does not stop its <video>, and an
  // invisible window playing audio is the worst possible outcome here.
  win.webContents.send('overlay:hidden')
  // 'move' already caught any drag on macOS and Windows; this covers platforms
  // that don't report moves while the window is being dragged.
  rememberIfMoved(win)
  win.hide()
}

export function toggleOverlay(): void {
  const win = getOverlayWindow()
  if (win?.isVisible()) hideOverlay()
  else showOverlay()
}
