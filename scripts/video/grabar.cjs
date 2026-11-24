/**
 * Grabación del vídeo de demostración (npm run build && electron scripts/video/grabar.cjs).
 * Arranca la app compilada con datos NUEVOS (primer arranque real), la maneja con clics y teclas reales
 * (sendInputEvent), dibuja un cursor, los subtítulos y los títulos de escena dentro de la página, y captura
 * la ventana fotograma a fotograma. Las esperas largas del modelo se aceleran (se indica en pantalla).
 * Salida: video/trabajo/frames/*.jpg + video/trabajo/linea-de-tiempo.json (fotogramas y frases).
 *   ZHASKA_VIDEO_HASTA=<escena>  graba solo hasta esa escena (para probar)
 */
const { app, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const work = path.join(root, 'video', 'trabajo')
const framesDir = path.join(work, 'frames')
fs.rmSync(framesDir, { recursive: true, force: true })
fs.mkdirSync(framesDir, { recursive: true })
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zhaska-video-')))
process.env.ZHASKA_USER_DATA = path.join(tmp, 'datos')
process.env.ZHASKA_PROJECTS_DIR = path.join(tmp, 'ZHASKA', 'proyectos')
fs.mkdirSync(process.env.ZHASKA_PROJECTS_DIR, { recursive: true })
const docsDir = path.join(work, 'docs')
const voz = JSON.parse(fs.readFileSync(path.join(work, 'voz.json'), 'utf8'))
const HASTA = process.env.ZHASKA_VIDEO_HASTA || null
/** Salida 1080p; la ventana es de 1600×900 (cabe en la pantalla) y se captura a resolución Retina */
const W = 1920
const H = 1080
const WIN_W = 1600
const WIN_H = 900
const FPS_CAPTURE = 10
/** Zoom de la interfaz: a 1080p el tamaño normal se lee pequeño en un vídeo */
const ZOOM = 1

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`[${new Date().toLocaleTimeString('es-ES')}] ${m}`)

// ───────────── Estado de la grabación ─────────────
let win = null
const frames = [] // { file, dur }
const beats = [] // { key, start, dur }
let videoTime = 0
let speed = 1
let capturing = false
let current = null // frase en curso: { key, start, dur, sentences }
let shownCaption = null

const js = (code) => win.webContents.executeJavaScript(code)

const OVERLAY = `
(() => {
  if (document.getElementById('demo-layer')) return true
  const st = document.createElement('style')
  st.textContent = \`
    #demo-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font-family: Geist, system-ui, sans-serif; }
    #demo-cursor { position: absolute; left: 0; top: 0; width: 26px; height: 26px; transform: translate(960px, 600px); transition: transform 650ms cubic-bezier(.4,.0,.2,1); filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
    #demo-ripple { position: absolute; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; border: 3px solid #8E87FF; opacity: 0; }
    #demo-ripple.go { animation: demo-rip .5s ease-out; }
    @keyframes demo-rip { from { opacity: .9; transform: scale(.3) } to { opacity: 0; transform: scale(1.4) } }
    #demo-caption { position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%); max-width: 1120px; padding: 11px 22px; border-radius: 14px; background: rgba(8,8,12,.86); color: #fff; font-size: 22px; line-height: 1.35; text-align: center; box-shadow: 0 8px 30px rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.08); opacity: 0; transition: opacity .25s; }
    #demo-title { position: absolute; left: 50%; top: 46px; transform: translate(-50%, -12px); padding: 8px 18px; border-radius: 999px; background: linear-gradient(90deg, #6D64F7, #8E87FF); color: #fff; font-size: 19px; font-weight: 600; letter-spacing: .02em; box-shadow: 0 10px 30px rgba(109,100,247,.45); opacity: 0; transition: opacity .35s, transform .35s; }
    #demo-title.on { opacity: 1; transform: translate(-50%, 0); }
    #demo-ff { position: absolute; right: 20px; top: 44px; padding: 6px 12px; border-radius: 9px; background: rgba(8,8,12,.86); color: #F2C063; font-size: 15px; font-weight: 600; opacity: 0; border: 1px solid rgba(242,192,99,.35); }
    #demo-card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; background: radial-gradient(ellipse at 50% 40%, #241F55 0%, #0B0B10 62%); color: #fff; opacity: 0; transition: opacity .6s; }
    #demo-card.on { opacity: 1; }
    #demo-card > * { display: block; line-height: 1.15; }
    #demo-card .logo { display: grid; width: 104px; height: 104px; border-radius: 24px; margin-bottom: 26px; background: linear-gradient(135deg, #8E87FF, #5B52E6); display: grid; place-items: center; font-size: 60px; font-weight: 700; line-height: 1; box-shadow: 0 20px 60px rgba(109,100,247,.55); }
    #demo-card .name { font-size: 70px; font-weight: 700; letter-spacing: .12em; margin-bottom: 12px; }
    #demo-card .sub { font-size: 26px; color: #C9C7E8; margin-bottom: 26px; }
    #demo-card .tags { display: flex; gap: 12px; }
    #demo-card .tags span { font-size: 17px; padding: 7px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,.18); color: #E6E5F5; }
  \`
  document.head.appendChild(st)
  const l = document.createElement('div')
  l.id = 'demo-layer'
  l.innerHTML = '<div id="demo-card"></div><div id="demo-title"></div><div id="demo-ff">▶▶ acelerado</div><div id="demo-caption"></div><div id="demo-ripple"></div>' +
    '<svg id="demo-cursor" viewBox="0 0 24 24"><path d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.6 L12 13.8 L19 13.8 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  document.body.appendChild(l)
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('#demo-layer') && !el.closest('[aria-hidden=true]') }
  const textOf = (el) => (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim()
  window.__demo = {
    find(text, n = 0, sel) {
      const cands = [...document.querySelectorAll(sel || 'button,[role=button],[role=menuitem],[role=tab],a,label,summary,input,textarea,[role=dialog] [class*=cursor-pointer]')].filter(visible)
      let hits = cands.filter((e) => textOf(e) === text || e.getAttribute('aria-label') === text || e.title === text)
      if (!hits.length) hits = cands.filter((e) => textOf(e).includes(text))
      if (!hits.length && !sel) hits = [...document.querySelectorAll('span,div,p')].filter((e) => visible(e) && e.children.length === 0 && textOf(e) === text)
      const el = hits[n]
      if (!el) return null
      const r0 = el.getBoundingClientRect()
      if (r0.top < 0 || r0.bottom > innerHeight) el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    },
    has: (text) => document.body.innerText.toLowerCase().includes(text.toLowerCase()),
    cursor(x, y) { document.getElementById('demo-cursor').style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)' },
    ripple(x, y) { const r = document.getElementById('demo-ripple'); r.style.left = x + 'px'; r.style.top = y + 'px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go') },
    caption(t) { const c = document.getElementById('demo-caption'); if (t) { c.textContent = t; c.style.opacity = 1 } else c.style.opacity = 0 },
    title(t) { const e = document.getElementById('demo-title'); if (t) { e.textContent = t; e.classList.add('on') } else e.classList.remove('on') },
    ff(on, f) { const e = document.getElementById('demo-ff'); e.textContent = '▶▶ acelerado ×' + f; e.style.opacity = on ? 1 : 0 },
    card(html) { const c = document.getElementById('demo-card'); if (html) { c.innerHTML = html; c.classList.add('on') } else c.classList.remove('on') },
  }
  return true
})()`

async function overlay() {
  await js(OVERLAY)
}

// ───────────── Captura ─────────────
async function captureLoop() {
  capturing = true
  let i = 0
  let last = performance.now()
  let prev = null
  while (capturing) {
    const t0 = performance.now()
    // Subtítulo de la frase en curso, repartido por frases según su longitud
    if (current) {
      const elapsed = videoTime - current.start
      const total = current.sentences.reduce((s, x) => s + x.length, 0)
      let acc = 0
      let text = current.sentences[current.sentences.length - 1]
      for (const s of current.sentences) {
        acc += s.length
        if (elapsed <= (acc / total) * current.dur) {
          text = s
          break
        }
      }
      if (elapsed > current.dur + 0.3) text = null
      if (text !== shownCaption) {
        shownCaption = text
        await js(`window.__demo && __demo.caption(${JSON.stringify(text)})`).catch(() => {})
      }
    }
    let img
    try {
      img = await win.webContents.capturePage()
    } catch {
      await wait(50)
      continue
    }
    const now = performance.now()
    if (prev) {
      const dur = (now - last) / 1000 / prev.speed
      prev.dur = dur
      frames.push(prev)
      videoTime += dur
    }
    const sz = img.getSize()
    const file = path.join(framesDir, `${String(i++).padStart(6, '0')}.jpg`)
    if (i === 0) log(`Captura de ${sz.width}×${sz.height}`)
    const buf = (sz.width !== W ? img.resize({ width: W, height: H, quality: 'best' }) : img).toJPEG(88)
    fs.writeFile(file, buf, () => {})
    prev = { file: path.basename(file), speed, dur: 0 }
    last = now
    const spent = performance.now() - t0
    await wait(Math.max(0, 1000 / FPS_CAPTURE - spent))
  }
  if (prev) {
    prev.dur = 1 / FPS_CAPTURE
    frames.push(prev)
    videoTime += prev.dur
  }
}

function setSpeed(f) {
  speed = f
  void js(`window.__demo && __demo.ff(${f > 1}, ${f})`).catch(() => {})
}

/** Una frase de narración: subtítulos sincronizados; dura al menos lo que dura la voz. */
async function beat(key, actions = async () => {}) {
  const v = voz[key]
  if (!v) throw new Error(`Falta la voz de ${key}`)
  await overlay()
  const sentences = v.text.match(/[^.!?:]+[.!?:]+["»]?|[^.!?:]+$/g).map((s) => s.trim()).filter(Boolean)
  current = { key, start: videoTime, dur: v.duration, sentences }
  shownCaption = undefined
  beats.push({ key, start: videoTime, dur: v.duration })
  log(`▶ ${key}`)
  await actions()
  while (videoTime - current.start < v.duration + 0.35) await wait(60)
}

// ───────────── Ratón y teclado reales ─────────────
let cursor = { x: 760, y: 480 }
async function moveTo(x, y) {
  await js(`__demo.cursor(${x}, ${y})`)
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    const px = Math.round(cursor.x + ((x - cursor.x) * i) / steps)
    const py = Math.round(cursor.y + ((y - cursor.y) * i) / steps)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(px * ZOOM), y: Math.round(py * ZOOM) })
    await wait(50)
  }
  cursor = { x, y }
  await wait(120)
}

async function find(text, n = 0, sel, timeout = 20_000) {
  const t = Date.now()
  for (;;) {
    await overlay()
    const p = await js(`__demo.find(${JSON.stringify(text)}, ${n}, ${JSON.stringify(sel ?? null)})`)
    if (p) return p
    if (Date.now() - t > timeout) {
      await shot(`no-encontrado-${text.replace(/[^\w]+/g, '_').slice(0, 30)}`)
      throw new Error(`No se encuentra «${text}» en pantalla`)
    }
    await wait(250)
  }
}

async function click(text, n = 0, sel) {
  const p = typeof text === 'object' ? text : await find(text, n, sel)
  await moveTo(p.x, p.y)
  await js(`__demo.ripple(${p.x}, ${p.y})`)
  const wx = Math.round(p.x * ZOOM)
  const wy = Math.round(p.y * ZOOM)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: wx, y: wy, button: 'left', clickCount: 1 })
  await wait(70)
  win.webContents.sendInputEvent({ type: 'mouseUp', x: wx, y: wy, button: 'left', clickCount: 1 })
  await wait(450)
}

async function type(text, cps = 22) {
  for (const ch of text) {
    win.webContents.insertText(ch)
    await wait(1000 / cps)
  }
  await wait(250)
}

async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode.length === 1 || keyCode === 'Return' || keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' || keyCode === 'Enter' ? '\r' : keyCode, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await wait(350)
}

async function until(cond, timeout, what) {
  const t = Date.now()
  for (;;) {
    if (await js(`(() => { try { return !!(${cond}) } catch { return false } })()`)) return true
    if (Date.now() - t > timeout) {
      await shot(`tiempo-${what.replace(/[^\w]+/g, '_')}`)
      throw new Error(`Tiempo agotado esperando: ${what}`)
    }
    await wait(300)
  }
}

async function shot(name) {
  try {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(work, `${name}.png`), img.toPNG())
  } catch {
    /* sin captura */
  }
}

/** Arrastra un archivo de verdad (contenido real) sobre un elemento, como al soltarlo desde el Finder. */
async function dropFile(file, targetText) {
  const p = await find(targetText)
  await moveTo(p.x, p.y)
  const b64 = fs.readFileSync(file).toString('base64')
  await js(`(() => {
    const bin = atob(${JSON.stringify(b64)}); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const f = new File([bytes], ${JSON.stringify(path.basename(file))}, { type: 'application/pdf' })
    const dt = new DataTransfer(); dt.items.add(f)
    const el = document.elementFromPoint(${p.x}, ${p.y})
    for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
    return true
  })()`)
  await wait(600)
}

const scrollTo = (text) =>
  js(`(() => { const el = [...document.querySelectorAll('div,span,h2,h3')].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(text)}); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return !!el })()`)

const title = async (t, ms = 3200) => {
  await overlay()
  await js(`__demo.title(${JSON.stringify(t)})`)
  setTimeout(() => void js(`window.__demo && __demo.title(null)`).catch(() => {}), ms)
}

const CARD = (sub) =>
  `<div class="logo">Z</div><div class="name">ZHASKA</div><div class="sub">${sub}</div><div class="tags"><span>100 % local</span><span>Ollama · Gemma 4</span><span>Código y oficina</span><span>Sin enviar tus datos</span></div>`

// ───────────── Escenas ─────────────
const ESCENAS = {
  async portada() {
    await js(`__demo.card(${JSON.stringify(CARD('Tu asistente de IA para toda la empresa · mensajes ilimitados'))})`)
    await wait(800)
    await beat('portada.intro')
    await js(`__demo.card(null)`)
    await wait(700)
  },

  async 'asistente-inicial'() {
    await title('1 · Primer arranque')
    await beat('asistente-inicial.bienvenida', async () => {
      await wait(5000)
      await moveTo(560, 430)
    })
    await click('Empezar')
    await beat('asistente-inicial.entorno', async () => {
      await until(`!document.body.innerText.match(/Comprobando|Buscando|Detectando/)`, 60_000, 'comprobaciones del entorno')
      await moveTo(900, 420)
    })
    await click('Continuar')
    await beat('asistente-inicial.modelo', async () => {
      await wait(1500)
      await click('Probar', 0)
      setSpeed(4)
      await until(`document.body.innerText.includes('Respondió')`, 240_000, 'prueba del modelo')
      setSpeed(1)
    })
    await beat('asistente-inicial.herramientas', async () => {
      await click('Probar', 0)
      setSpeed(4)
      await until(`(document.body.innerText.match(/tok\\/s/g) || []).length >= 2`, 300_000, 'prueba de herramientas')
      setSpeed(1)
      await wait(1500)
    })
    await click('Continuar')
    await beat('asistente-inicial.proyecto', async () => {
      await wait(2500)
      await click('Probar el agente con un proyecto de ejemplo')
    })
    await until(`document.querySelector('[aria-label="Enviar"]')`, 60_000, 'proyecto de ejemplo abierto')
    await wait(1200)
  },

  async chat() {
    await title('2 · Modo Chat: el asistente de toda la empresa', 4000)
    await beat('chat.cambiar', async () => {
      await wait(1200)
      await click('Chat', 0, 'button')
      await wait(1500)
      await moveTo(160, 330)
    })
    await beat('chat.ilimitado1', async () => {
      await moveTo(760, 790)
      await wait(2500)
      await moveTo(760, 420)
    })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(docsDir, 'Documentos Quesos del Prado')] })
    await beat('chat.base', async () => {
      await click('Nueva base de conocimiento')
      await wait(700)
      await type('Documentos de la empresa', 18)
      await click('Crear y elegir carpeta')
      setSpeed(2)
      await until(`__demo.has('Documentos indexados (6)')`, 180_000, 'indexar la base')
      setSpeed(1)
      await wait(3000)
      await key('Escape')
    })
    await beat('chat.pregunta', async () => {
      await ask('¿Cuál es el código SAP de CARREFOUR y qué condición de pago tiene?', 'Fuentes')
      await click('Clientes.xlsx', 0, 'button')
      await wait(2500)
    })
    await beat('chat.pregunta2', async () => {
      await ask('¿Qué días cierra la empresa en agosto?')
    })
    await beat('chat.noaparece', async () => {
      await ask('¿Cuál es el teléfono del director general?', 'No aparece en tus documentos')
    })
    await beat('chat.factura', async () => {
      await dropFile(path.join(docsDir, 'Factura F-2026-0412.pdf'), 'Plantillas')
      await until(`__demo.has('Factura F-2026-0412') && !document.body.innerText.match(/Procesando|Extrayendo|En cola|Subiendo/)`, 90_000, 'procesar la factura')
      await wait(800)
      await ask('Resume la factura adjunta: cliente, líneas, total y vencimiento.', '391')
    })
    await beat('chat.factura2', async () => {
      await moveTo(760, 520)
      await wait(2000)
    })
    await beat('chat.correo', async () => {
      await click('Plantillas')
      await wait(900)
      await click('Redactar un correo', 0, '[role=menuitem], button')
      await wait(1800)
      await ask('Redacta un correo breve y formal a CARREFOUR recordando su condición de pago según nuestros documentos y que los pagos se emiten los días 10 y 25.', null, { replace: true })
    })
    await beat('chat.correo2', async () => {
      await moveTo(760, 450)
      await wait(2000)
    })
    await beat('chat.traducir', async () => {
      await ask('Traduce al español: «Nous vous informons que la note de débit ND-5521 d’un montant de 1 250 € sera déduite de votre prochain paiement du 15 décembre.»')
    })
    await beat('chat.privada', async () => {
      await click('Privada')
      await wait(2200)
      await click('6 documentos', 0, 'button')
      await wait(1500)
      const c = await find('Confidencial')
      await moveTo(c.x, c.y)
      await wait(3000)
      await key('Escape')
    })
    await beat('chat.ilimitado2', async () => {
      await moveTo(150, 360)
      await wait(3000)
      await moveTo(760, 790)
    })
  },

  async codigo() {
    await title('3 · Modo Código, para desarrolladores', 4000)
    await click('Código', 0, 'button')
    await wait(1500)
    await beat('codigo.interfaz', async () => {
      for (const [x, y] of [
        [440, 400],
        [800, 360],
        [1250, 320],
      ]) {
        await moveTo(x, y)
        await wait(1300)
      }
    })
    let asked = false
    await beat('codigo.enviar', async () => {
      const hasDraft = await js(`!!document.querySelector('textarea')?.value`)
      if (!hasDraft) {
        await click(await find('', 0, 'textarea'))
        await type('Crea un index.html con una página de bienvenida y un style.css con un diseño limpio.')
      }
      await click('Enviar')
      await wait(2500)
      setSpeed(8)
    })
    const t = Date.now()
    for (;;) {
      if (await js(`__demo.has('Aceptar todo') && !document.querySelector('[aria-label="Detener"]')`)) break
      if (await js(`!!__demo.find('Permitir', 0, 'button')`)) {
        setSpeed(1)
        if (!asked) {
          asked = true
          await beat('codigo.permiso', async () => {
            await wait(3000)
            await click('Permitir', 0, 'button')
          })
        } else await click('Permitir', 0, 'button')
        setSpeed(8)
      }
      if (Date.now() - t > 900_000) throw new Error('El agente no terminó en 15 min')
      await wait(500)
    }
    setSpeed(1)
    await wait(1000)
    await beat('codigo.revisar', async () => {
      await wait(2000)
      await click('Aceptar todo')
      await wait(1200)
    })
    await beat('codigo.editor', async () => {
      await click('index.html', 0, '[role=treeitem], button, div[title]')
      await wait(2000)
      await click('Abrir una terminal en el proyecto')
      await wait(2000)
      await type('ls -la', 14)
      await key('Return')
      await wait(1800)
    })
  },

  async ajustes() {
    await title('4 · Configuración')
    await click('Configuración', 0, 'aside button')
    await wait(1200)
    const sec = async (k, label, extra) =>
      beat(`ajustes.${k}`, async () => {
        await click(label, 0, '[role=dialog] button')
        await wait(1800)
        if (extra) await extra()
      })
    await sec('general', 'General')
    await sec('apariencia', 'Apariencia')
    await sec('editor', 'Editor')
    await sec('atajos', 'Atajos de teclado')
    await sec('modelos', 'Modelos')
    await sec('ollama', 'Ollama')
    await sec('agente', 'Agente y permisos', async () => {
      await moveTo(880, 340)
      await wait(3000)
      await moveTo(880, 510)
    })
    await beat('ajustes.agente2', async () => {
      await scrollTo('Archivos protegidos')
      await wait(4000)
      await scrollTo('Carpetas autorizadas fuera del proyecto')
      await wait(3000)
    })
    await sec('contexto', 'Contexto e indexado')
    await sec('privacidad', 'Privacidad y datos', async () => {
      await wait(5000)
      await scrollTo('Copias de seguridad')
    })
    await sec('acerca', 'Acerca de ZHASKA')
    await key('Escape')
    await wait(800)
  },

  async cierre() {
    await js(`__demo.card(${JSON.stringify(CARD('Mensajes ilimitados · tus datos no salen de la empresa'))})`)
    await wait(900)
    await beat('cierre.final')
    await wait(1500)
  },
}

/** Escribe una pregunta en el chat del asistente, la envía y espera a que termine la respuesta (acelerado). */
async function ask(text, expectText, { replace = false } = {}) {
  const area = await js(`(() => { const t = document.querySelector('textarea'); const r = t.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await click(area)
  if (replace) await key('a', ['meta'])
  await type(text)
  await key('Return')
  await wait(1500)
  setSpeed(3)
  await until(
    `!document.querySelector('[aria-label="Detener"]') && !document.body.innerText.match(/Buscando en tus documentos…|Cargando el modelo…|Leyendo los fragmentos…|Pensando…|Escribiendo…/)${expectText ? ` && __demo.has(${JSON.stringify(expectText)})` : ''}`,
    300_000,
    `respuesta a «${text.slice(0, 30)}»`,
  )
  setSpeed(1)
  await wait(900)
}

app.on('browser-window-created', (_e, w) => {
  if (win) return
  win = w
  w.webContents.on('console-message', (e) => e.level === 'error' && console.log(`  [renderer] ${e.message}`))
  w.webContents.once('did-finish-load', async () => {
    try {
      w.setContentSize(WIN_W, WIN_H)
      w.center()
      w.webContents.setZoomFactor(ZOOM)
      w.webContents.on('did-finish-load', () => w.webContents.setZoomFactor(ZOOM))
      await wait(4000)
      await overlay()
      void captureLoop()
      for (const name of Object.keys(ESCENAS)) {
        log(`── escena ${name}`)
        await ESCENAS[name]()
        if (HASTA === name) break
      }
      capturing = false
      await wait(600)
      fs.writeFileSync(path.join(work, 'linea-de-tiempo.json'), JSON.stringify({ frames, beats, width: W, height: H }, null, 1))
      log(`Listo: ${frames.length} fotogramas, ${videoTime.toFixed(1)} s de vídeo`)
      app.exit(0)
    } catch (e) {
      log(`ERROR: ${e.message}`)
      await shot('error')
      capturing = false
      fs.writeFileSync(path.join(work, 'linea-de-tiempo.json'), JSON.stringify({ frames, beats, width: W, height: H, error: e.message }, null, 1))
      app.exit(1)
    }
  })
})

require(path.join(root, 'out', 'main', 'index.js'))
