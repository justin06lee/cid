import type { CidApi } from './index.js'

declare global {
  interface Window {
    cid: CidApi
  }
}

export {}
