import { net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CSP_HEADER } from '@shared/csp'

/**
 * Protocolo propio app://zhaska/… para servir la interfaz compilada (en lugar de file://).
 * Debe registrarse como privilegiado ANTES de `app.whenReady()`.
 */
export function registerAppSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])
}

export function serveRenderer(rendererDir: string) {
  const root = path.resolve(rendererDir)
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'zhaska') return new Response('Not found', { status: 404 })
    const rel = decodeURIComponent(url.pathname)
    const file = path.resolve(root, `.${rel === '/' ? '/index.html' : rel}`)
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      // CSP también como cabecera (además del <meta>) y sin adivinar tipos de contenido
      const headers = new Headers(res.headers)
      if (file.endsWith('.html')) headers.set('Content-Security-Policy', CSP_HEADER)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    })
  })
}

export const APP_URL = 'app://zhaska/index.html'
