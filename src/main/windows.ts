import { app, BrowserWindow, screen, shell } from 'electron'
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

  overlay.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  void overlay.loadURL(pageUrl('overlay'))
  return overlay
}

/** Centre it on whichever screen the pointer is on, not always the primary one. */
function positionOverlay(win: BrowserWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + (workArea.height - OVERLAY_HEIGHT) / 2),
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT
  })
}

export function showOverlay(): void {
  const win = ensureOverlay()
  positionOverlay(win)
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
  win.hide()
}

export function toggleOverlay(): void {
  const win = getOverlayWindow()
  if (win?.isVisible()) hideOverlay()
  else showOverlay()
}
