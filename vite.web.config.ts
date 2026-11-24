// Servidor solo-renderer para revisar la UI en un navegador (sin Electron).
// La app real se ejecuta con `npm run dev`.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { rendererShared } from './vite.shared'

export default defineConfig({
  ...rendererShared,
  plugins: [react(), tailwindcss(), ...rendererShared.plugins],
  server: { port: 5199, strictPort: true },
})
