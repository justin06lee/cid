import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AddResult, AppInfo, Edit, EditPatch, IngestProgress } from '../shared/types.js'

const api = {
  info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  list: (): Promise<Edit[]> => ipcRenderer.invoke('library:list'),
  vectors: (): Promise<Record<string, number[]>> => ipcRenderer.invoke('library:vectors'),
  unembedded: (): Promise<string[]> => ipcRenderer.invoke('library:unembedded'),
  commitEmbedding: (
    id: string,
    vector: number[],
    moods: string[],
    moodScores: Record<string, number>
  ): Promise<boolean> =>
    ipcRenderer.invoke('library:commitEmbedding', id, vector, moods, moodScores),

  patch: (id: string, patch: EditPatch): Promise<Edit | null> =>
    ipcRenderer.invoke('library:patch', id, patch),
  remove: (id: string): Promise<boolean> => ipcRenderer.invoke('library:remove', id),
  played: (id: string): Promise<void> => ipcRenderer.invoke('library:played', id),
  reveal: (id: string): Promise<void> => ipcRenderer.invoke('library:reveal', id),
  openSource: (id: string): Promise<void> => ipcRenderer.invoke('library:openSource', id),
  openFolder: (): Promise<void> => ipcRenderer.invoke('library:openFolder'),

  addUrl: (url: string): Promise<AddResult> => ipcRenderer.invoke('ingest:url', url),
  addFiles: (paths: string[]): Promise<AddResult[]> => ipcRenderer.invoke('ingest:files', paths),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('ingest:pickFiles'),

  hideOverlay: (): Promise<void> => ipcRenderer.invoke('overlay:hide'),
  openLibraryFromOverlay: (): Promise<void> => ipcRenderer.invoke('overlay:openLibrary'),

  /** Fired every time the panel is summoned — the cue to roll a fresh edit. */
  onOverlayShown: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('overlay:shown', listener)
    return () => ipcRenderer.off('overlay:shown', listener)
  },
  /** Fired just before the panel hides, while it can still stop its audio. */
  onOverlayHidden: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('overlay:hidden', listener)
    return () => ipcRenderer.off('overlay:hidden', listener)
  },
  /**
   * Fired when edits are added or removed, in every window — including the ones
   * that did not make the change. The panel outlives the library window and
   * would otherwise never hear about anything added after it was first summoned.
   */
  onLibraryChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('library:changed', listener)
    return () => ipcRenderer.off('library:changed', listener)
  },
  onOpenAdd: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('library:openAdd', listener)
    return () => ipcRenderer.off('library:openAdd', listener)
  },

  onIngestProgress: (cb: (p: IngestProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: IngestProgress): void => cb(p)
    ipcRenderer.on('ingest:progress', listener)
    return () => ipcRenderer.off('ingest:progress', listener)
  },

  /**
   * Since Electron 32 a dropped File no longer exposes `.path`; webUtils is the
   * only way to get a real filesystem path out of a drag-and-drop.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('cid', api)

export type CidApi = typeof api
