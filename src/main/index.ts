import {
  app, ipcMain, dialog, shell, nativeTheme,
  Tray, Menu, nativeImage, globalShortcut
} from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddResult, EditPatch, IngestProgress } from '../shared/types.js'
import { registerCidScheme, handleCidProtocol, serveRendererFrom } from './protocol.js'
import { addFromUrl, addFromFile, sweepPartials } from './ingest.js'
import { resolveBin } from './bin.js'
import { libraryRoot, mediaDir } from './paths.js'
import {
  showLibrary, getLibraryWindow, showOverlay, hideOverlay, toggleOverlay, syncDock
} from './windows.js'
import {
  loadLibrary, saveNow, allEdits, addEdit, patchEdit, removeEdit,
  markPlayed, getEdit, unembeddedIds, getVectors, setVector
} from './library.js'

const dirname = fileURLToPath(new URL('.', import.meta.url))

/** Verbatim files (the menubar icon and its @2x) rather than bundled assets, so
 *  macOS can still find `trayTemplate@2x.png` sitting next to the 1x by name. */
const resourcesDir = app.isPackaged
  ? join(process.resourcesPath, 'resources')
  : join(dirname, '../../resources')

export const SUMMON_ACCELERATOR = 'CommandOrControl+Shift+Return'

// Must happen before app is ready.
registerCidScheme()

let tray: Tray | null = null
let shortcutRegistered = false

function report(url: string, p: Omit<IngestProgress, 'url'>): void {
  getLibraryWindow()?.webContents.send('ingest:progress', { url, ...p } satisfies IngestProgress)
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Pull up an edit',
      accelerator: SUMMON_ACCELERATOR,
      click: () => showOverlay()
    },
    ...(shortcutRegistered
      ? []
      : [
          {
            label: '⚠ ⌘⇧↵ is taken by another app',
            enabled: false
          } as const
        ]),
    { type: 'separator' },
    { label: 'Library…', click: () => showLibrary() },
    {
      label: 'Add an edit…',
      click: () => {
        showLibrary().webContents.send('library:openAdd')
      }
    },
    { label: 'Open library folder', click: () => void shell.openPath(libraryRoot) },
    { type: 'separator' },
    { label: 'Quit cid', role: 'quit' }
  ])
}

function createTray(): void {
  const image = nativeImage.createFromPath(join(resourcesDir, 'trayTemplate.png'))
  // Template images get recoloured by macOS for light/dark menu bars and
  // inverted on click; without this the glyph stays black on a dark menu bar.
  image.setTemplateImage(true)

  tray = new Tray(image)
  tray.setToolTip('cid — pull up an edit')

  // Left click is the app's whole purpose, so it summons rather than opening a
  // menu. The menu is on right click, where nothing else wants to be.
  tray.on('click', () => toggleOverlay())
  tray.on('right-click', () => tray?.popUpContextMenu(buildTrayMenu()))
}

function registerShortcut(): void {
  shortcutRegistered = globalShortcut.register(SUMMON_ACCELERATOR, () => toggleOverlay())
  if (!shortcutRegistered) {
    console.warn(`[cid] could not register ${SUMMON_ACCELERATOR} — another app owns it`)
  }
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    libraryRoot,
    hasYtdlp: Boolean(resolveBin('yt-dlp')),
    hasFfmpeg: Boolean(resolveBin('ffmpeg')),
    summonAccelerator: SUMMON_ACCELERATOR,
    summonRegistered: shortcutRegistered
  }))

  ipcMain.handle('library:list', () => allEdits())
  ipcMain.handle('library:vectors', () => getVectors())
  ipcMain.handle('library:unembedded', () => unembeddedIds())

  ipcMain.handle(
    'library:commitEmbedding',
    (_e, id: string, vector: number[], moods: string[], moodScores: Record<string, number>) => {
      if (!getEdit(id)) return false
      setVector(id, vector)
      patchEdit(id, { moods })
      const edit = getEdit(id)
      if (edit) edit.moodScores = moodScores
      return true
    }
  )

  ipcMain.handle('library:patch', (_e, id: string, patch: EditPatch) => patchEdit(id, patch) ?? null)
  ipcMain.handle('library:remove', (_e, id: string) => removeEdit(id))
  ipcMain.handle('library:played', (_e, id: string) => {
    markPlayed(id)
  })

  ipcMain.handle('library:reveal', (_e, id: string) => {
    const edit = getEdit(id)
    if (edit) shell.showItemInFolder(join(mediaDir, edit.file))
  })
  ipcMain.handle('library:openSource', (_e, id: string) => {
    const edit = getEdit(id)
    if (edit?.sourceUrl) shell.openExternal(edit.sourceUrl)
  })
  ipcMain.handle('library:openFolder', () => shell.openPath(libraryRoot))

  ipcMain.handle('overlay:hide', () => hideOverlay())
  ipcMain.handle('overlay:openLibrary', () => {
    hideOverlay()
    showLibrary()
  })

  ipcMain.handle('ingest:url', async (_e, url: string): Promise<AddResult> => {
    try {
      const edit = await addFromUrl(url, (p) => report(url, p))
      addEdit(edit)
      saveNow()
      report(url, { stage: 'done', percent: 1, message: edit.title })
      return { ok: true, edit }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report(url, { stage: 'error', percent: null, message })
      return { ok: false, error: message }
    } finally {
      sweepPartials()
    }
  })

  ipcMain.handle('ingest:files', async (_e, paths: string[]): Promise<AddResult[]> => {
    const results: AddResult[] = []
    for (const path of paths) {
      try {
        const edit = await addFromFile(path, (p) => report(path, p))
        addEdit(edit)
        results.push({ ok: true, edit })
      } catch (err) {
        results.push({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    saveNow()
    return results
  })

  ipcMain.handle('ingest:pickFiles', async () => {
    const parent = getLibraryWindow()
    if (!parent) return []
    const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
      title: 'Add edits',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'] }]
    })
    return canceled ? [] : filePaths
  })
}

nativeTheme.themeSource = 'dark'

// A second copy would fight over the global shortcut and the library file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showOverlay())

  app.whenReady().then(() => {
    serveRendererFrom(join(dirname, '../renderer'))
    handleCidProtocol()
    loadLibrary()
    sweepPartials()
    registerIpc()
    createTray()
    registerShortcut()

    // A menubar app throwing a full window at you on launch is wrong, but an
    // empty library has nothing to summon and needs somewhere to add from. With
    // a stocked library, launching does the thing the app exists for.
    if (allEdits().length === 0) {
      showLibrary()
    } else {
      // Drop the dock icon before showing the panel, not after: hiding it
      // deactivates the app, which would pull focus straight back off the panel.
      syncDock()
      showOverlay()
    }

    app.on('activate', () => showLibrary())
  })
}

app.on('window-all-closed', () => {
  // Never quit here: closing the library window drops cid back to the menu bar,
  // which is where it is supposed to live.
  saveNow()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  saveNow()
})

app.on('before-quit', () => saveNow())
