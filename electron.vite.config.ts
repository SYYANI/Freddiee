import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const packageJSON = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // CommonJS output needs no ESM shim; the shim's import detection misreads strings such as "Finalizing import".
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/main/index.ts'),
          babeldocWorker: resolve('electron/main/babeldocWorker.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('electron/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: '.',
    define: {
      __APP_VERSION__: JSON.stringify(packageJSON.version)
    },
    build: { rollupOptions: { input: resolve('index.html') } },
    plugins: [react()]
  }
})
