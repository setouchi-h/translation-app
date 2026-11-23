import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      // Small scripts would be inlined as data: URLs, which the page's CSP (script-src 'self')
      // refuses. That broke loading the audio worklet in built apps.
      assetsInlineLimit: (filePath) => (filePath.endsWith('.js') ? false : undefined)
    },
    plugins: [react()]
  }
})
