import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AddResult, Edit, EditPatch, IngestProgress } from '../shared/types.js'

const api = {
  info: (): Promise<{ libraryRoot: string; hasYtdlp: boolean; hasFfmpeg: boolean }> =>
    ipcRenderer.invoke('app:info'),

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
