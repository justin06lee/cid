import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      // transformers.js ships both node and browser entrypoints; the renderer is
      // Chromium, so force the browser one or it drags in onnxruntime-node.
      conditions: ['browser', 'import', 'module', 'default'],
      alias: { '@shared': resolve('src/shared') }
    },
    // The renderer root is src/renderer, but the onnx runtime it bundles lives in
    // the repo's node_modules, one level above it.
    server: { fs: { allow: [resolve('.')] } },
    build: {
      target: 'chrome130',
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
