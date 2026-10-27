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
    plugins: [react()],
    // electron-vite leaves the renderer unminified; minified, the startup bundle is parsed and compiled faster.
    build: {
      minify: true
    }
  }
})
