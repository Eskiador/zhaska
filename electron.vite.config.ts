import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { rendererShared } from './vite.shared'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core') } },
    build: {
      rollupOptions: {
        // Proceso principal + Agent Host (utilityProcess) + extracción de adjuntos (worker_thread) en out/main/
        input: { index: resolve('src/main/index.ts'), agent: resolve('src/agent/index.ts'), attachments: resolve('src/main/attachments/worker.ts') },
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    ...rendererShared,
    plugins: [react(), tailwindcss(), ...rendererShared.plugins],
  },
})
