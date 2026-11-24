/**
 * Una fase de la prueba de restauración (la lanza scripts/restore-e2e.cjs, no se usa sola).
 * Arranca la app compilada con los datos de ZHASKA_USER_DATA y ejecuta la fase ZHASKA_RESTORE_PHASE:
 *   1 → guarda una copia, cambia los datos y pide restaurarla (la app se reinicia)
 *   2 → comprueba la restauración, exporta, cambia los datos e importa lo exportado (se reinicia)
 *   3 → comprueba la importación
 * app.relaunch() se sustituye por una marca en disco: el lanzador arranca la siguiente fase.
 */
const { app, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const phase = process.env.ZHASKA_RESTORE_PHASE
const out = process.env.ZHASKA_RESTORE_OUT
const exportFile = path.join(path.dirname(process.env.ZHASKA_USER_DATA), 'exportado.zhaska')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const save = (extra = {}) => fs.writeFileSync(out, JSON.stringify({ phase, results, ...extra }))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.relaunch = () => fs.writeFileSync(`${out}.relaunch`, String(Date.now()))
dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportFile })
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exportFile] })
setTimeout(() => {
  check('la fase terminó a tiempo', false)
  save()
  app.exit(2)
}, 120_000).unref()

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code)
    const invoke = async (channel, req) => {
      const r = await js(`window.zhaska.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req)})`)
      if (!r.ok) throw new Error(`${channel}: ${r.error.message}`)
      return r.data
    }
    const temperature = async () => (await invoke('settings.getAll')).temperature
    try {
      await wait(1500)
      if (phase === '1') {
        await invoke('settings.set', { key: 'onboardingDone', value: true })
        await invoke('settings.set', { key: 'temperature', value: 0.3 })
        const b = await invoke('backups.create')
        await invoke('settings.set', { key: 'temperature', value: 0.8 })
        check('estado inicial: copia con 0.3 y datos actuales con 0.8', (await temperature()) === 0.8, b.file)
        save({ backup: b.file })
        const r = await invoke('backups.restore', { file: b.file })
        check('la restauración se programa y la app se reinicia', r.restarting)
        save({ backup: b.file })
        // Tras 400 ms main cierra todo, «reinicia» (marca) y sale
      } else if (phase === '2') {
        check('tras reiniciar, los datos vuelven a la copia (0.3)', (await temperature()) === 0.3, String(await temperature()))
        const backups = await invoke('backups.list')
        check('se guardó una copia del estado anterior para deshacer', backups.some((b) => b.reason === 'pre-restore'), backups.map((b) => b.reason).join(', '))
        await wait(300)
        const text = await js('document.body.innerText')
        check('la interfaz avisa de que se restauró la copia', text.includes('Copia restaurada'))
        await invoke('settings.set', { key: 'temperature', value: 0.55 })
        const ex = await invoke('data.export', { includeAttachments: true })
        check('exportar a un archivo .zhaska', ex && fs.existsSync(exportFile), ex ? `${ex.size} B` : '')
        await invoke('settings.set', { key: 'temperature', value: 0.99 })
        const sum = await invoke('data.importInspect')
        check('el archivo se comprueba antes de importarlo', sum && sum.projects >= 0 && sum.fileName === 'exportado.zhaska')
        save()
        const r = await invoke('data.importApply', { token: sum.token })
        check('la importación se programa y la app se reinicia', r.restarting)
        save()
      } else if (phase === '3') {
        check('tras reiniciar, están los datos importados (0.55)', (await temperature()) === 0.55, String(await temperature()))
        const backups = await invoke('backups.list')
        check('se guardó una copia del estado anterior a importar', backups.some((b) => b.reason === 'pre-import'))
        await wait(300)
        check('la interfaz avisa de que se importaron los datos', (await js('document.body.innerText')).includes('Datos importados'))
        save()
        app.exit(0)
      }
    } catch (e) {
      check('sin excepciones', false, e.message)
      save()
      app.exit(1)
    }
  })
})

require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
