import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddResult, EditPatch, IngestProgress } from '../shared/types.js'
import { registerCidScheme, handleCidProtocol } from './protocol.js'
import { addFromUrl, addFromFile, sweepPartials } from './ingest.js'
import { resolveBin } from './bin.js'
import { libraryRoot, mediaDir } from './paths.js'
import {
  loadLibrary, saveNow, allEdits, addEdit, patchEdit, removeEdit,
  markPlayed, getEdit, unembeddedIds, getVectors, setVector
} from './library.js'

const dirname = fileURLToPath(new URL('.', import.meta.url))

// Must happen before app is ready.
registerCidScheme()

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
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
      preload: join(dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win?.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(dirname, '../renderer/index.html'))
  }
}

function report(url: string, p: Omit<IngestProgress, 'url'>): void {
  win?.webContents.send('ingest:progress', { url, ...p } satisfies IngestProgress)
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    libraryRoot,
    hasYtdlp: Boolean(resolveBin('yt-dlp')),
    hasFfmpeg: Boolean(resolveBin('ffmpeg'))
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
    if (!win) return []
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add edits',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'] }]
    })
    return canceled ? [] : filePaths
  })
}

nativeTheme.themeSource = 'dark'

app.whenReady().then(() => {
  handleCidProtocol()
  loadLibrary()
  sweepPartials()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  saveNow()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => saveNow())
