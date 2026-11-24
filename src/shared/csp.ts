/**
 * Content-Security-Policy de la interfaz compilada: sin scripts inline, sin red externa, sin objetos ni
 * formularios. Se aplica dos veces (defensa en profundidad): como <meta> en index.html y como cabecera
 * HTTP en el protocolo app:// (src/main/protocol.ts).
 */
export const CSP_BUILD = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ')

/** La cabecera HTTP admite además frame-ancestors (en un <meta> se ignora). */
export const CSP_HEADER = `${CSP_BUILD}; frame-ancestors 'none'`
