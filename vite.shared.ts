import { resolve } from 'node:path'
import type { Plugin, UserConfig } from 'vite'
import pkg from './package.json'
import { CSP_BUILD } from './src/shared/csp'

/**
 * Content-Security-Policy del renderer.
 * - build: estricta (sin scripts inline, sin red externa).
 * - dev: relajada solo lo necesario para HMR y el preámbulo de React Refresh.
 */
const CSP_DEV = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' ws: http://localhost:*",
  "object-src 'none'",
].join('; ')

function cspPlugin(): Plugin {
  let isBuild = false
  return {
    name: 'zhaska-csp',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    transformIndexHtml(html) {
      const csp = isBuild ? CSP_BUILD : CSP_DEV
      return html.replace('<!-- CSP -->', `<meta http-equiv="Content-Security-Policy" content="${csp}" />`)
    },
  }
}

export const rendererShared = {
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [cspPlugin()],
  worker: { format: 'es' as const },
} satisfies UserConfig & { plugins: Plugin[] }
