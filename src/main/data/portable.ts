import { backup, DatabaseSync } from 'node:sqlite'
import { closeSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { crc32, deflateRawSync } from 'node:zlib'
import yauzl from 'yauzl'
import { AppError } from '@core/errors'
import { EXECUTABLE_EXT, unsafeZipName } from '@core/security/zipNames'
import type { Db } from '../db/database'
import { inspectDatabase, stagingDir, type DbSummary } from '../db/restore'

/**
 * Exportar e importar los datos de ZHASKA (Fase 9) en un único archivo `.zhaska` (un ZIP):
 *   manifest.json   — qué contiene y de qué versión es
 *   zhaska.db       — base de datos (proyectos, conversaciones, actividad, ajustes, permisos)
 *   attachments/…   — adjuntos (opcional)
 * Los proyectos NO se incluyen: son tus carpetas y siguen donde están. Las instantáneas de cambios del
 * agente tampoco (se regeneran con el uso).
 *
 * La importación nunca se fía del archivo: solo admite esas rutas exactas, valida cada nombre como el ZIP
 * seguro de los adjuntos, limita tamaños y detecta bombas ZIP, y comprueba la base de datos antes de
 * proponer el cambio. Se aplica al reiniciar, tras guardar una copia del estado actual.
 */

export const EXPORT_FORMAT = 1
const MAX_ENTRIES = 60_000
const MAX_TOTAL = 20 * 1024 ** 3
const MAX_RATIO = 1000
const ZIP32_LIMIT = 0xffff_fff0

export interface ExportManifest {
  app: 'ZHASKA'
  format: number
  appVersion: string
  schemaVersion: number
  createdAt: number
  includesAttachments: boolean
  counts: DbSummary
}

export interface ImportSummary extends DbSummary {
  token: string
  fileName: string
  createdAt: number
  appVersion: string | null
  attachmentFiles: number
  bytes: number
}

// ───────────────────────── ZIP (escritura) ─────────────────────────

function dosDateTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** Escritor ZIP mínimo (deflate, nombres UTF-8). Sin ZIP64: hasta ~4 GB y 65 535 entradas. */
export class ZipWriter {
  private fd: number
  private offset = 0
  private central: Buffer[] = []
  private count = 0

  constructor(file: string) {
    this.fd = openSync(file, 'wx')
  }

  private write(b: Buffer) {
    let done = 0
    while (done < b.length) done += writeSync(this.fd, b, done, b.length - done)
    this.offset += b.length
  }

  add(name: string, data: Buffer, mtime = new Date()) {
    if (this.count >= 65_535) throw new AppError('IO', 'Demasiados archivos para un solo ZIP')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data) >>> 0
    let method = 8
    let body: Buffer = deflateRawSync(data, { level: 6 })
    if (body.length >= data.length) {
      method = 0
      body = data
    }
    if (this.offset + 30 + nameBuf.length + body.length + 46 * (this.count + 1) > ZIP32_LIMIT) throw new AppError('IO', 'La exportación supera 4 GB. Desactiva «Incluir adjuntos» o libera adjuntos antiguos.')
    const { time, date } = dosDateTime(mtime)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(this.offset, 42)
    this.write(lh)
    this.write(nameBuf)
    this.write(body)
    this.central.push(ch, nameBuf)
    this.count++
  }

  finish() {
    const start = this.offset
    for (const b of this.central) this.write(b)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.count, 8)
    end.writeUInt16LE(this.count, 10)
    end.writeUInt32LE(this.offset - start, 12)
    end.writeUInt32LE(start, 16)
    this.write(end)
    closeSync(this.fd)
  }

  abort() {
    try {
      closeSync(this.fd)
    } catch {
      /* ya cerrado */
    }
  }
}

// ───────────────────────── Exportar ─────────────────────────

/** Archivos de adjuntos (attachments/<aa>/<sha256>/…), sin seguir enlaces simbólicos. */
function attachmentFiles(root: string): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = []
  const walk = (dir: string) => {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) out.push({ rel: relative(root, p).split(sep).join('/'), size: st.size })
    }
  }
  for (const aa of existsSync(root) ? readdirSync(root) : []) if (/^[0-9a-f]{2}$/.test(aa)) walk(join(root, aa))
  return out
}

export function exportEstimate(dbPath: string, attachmentsDir: string): { dbBytes: number; attachmentsBytes: number; attachmentFiles: number } {
  const files = attachmentFiles(attachmentsDir)
  const size = (f: string) => (existsSync(f) ? statSync(f).size : 0)
  return { dbBytes: size(dbPath) + size(`${dbPath}-wal`), attachmentsBytes: files.reduce((a, f) => a + f.size, 0), attachmentFiles: files.length }
}

export async function exportData(o: { db: Db; target: string; attachmentsDir: string; includeAttachments: boolean; tmpDir: string; appVersion: string }): Promise<{ file: string; size: number; attachments: number }> {
  mkdirSync(o.tmpDir, { recursive: true })
  const tmpDb = join(o.tmpDir, `export-${randomUUID()}.db`)
  const part = `${o.target}.part`
  rmSync(part, { force: true })
  let zip: ZipWriter | null = null
  try {
    // Instantánea coherente de la base de datos con la API de backup (la app sigue funcionando)
    await backup(o.db, tmpDb)
    const copy = new DatabaseSync(tmpDb)
    copy.exec('PRAGMA journal_mode = DELETE')
    copy.close()
    const counts = inspectDatabase(tmpDb, o.tmpDir)
    const files = o.includeAttachments ? attachmentFiles(o.attachmentsDir) : []
    if (files.length + 2 > MAX_ENTRIES) throw new AppError('IO', `Demasiados archivos de adjuntos (${files.length}). Desactiva «Incluir adjuntos».`)
    const manifest: ExportManifest = { app: 'ZHASKA', format: EXPORT_FORMAT, appVersion: o.appVersion, schemaVersion: counts.schemaVersion, createdAt: Date.now(), includesAttachments: o.includeAttachments, counts }
    zip = new ZipWriter(part)
    zip.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
    zip.add('zhaska.db', readFileSync(tmpDb))
    for (const f of files) zip.add(`attachments/${f.rel}`, readFileSync(join(o.attachmentsDir, ...f.rel.split('/'))))
    zip.finish()
    zip = null
    renameSync(part, o.target)
    return { file: o.target, size: statSync(o.target).size, attachments: files.length }
  } catch (e) {
    zip?.abort()
    rmSync(part, { force: true })
    throw e
  } finally {
    for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) rmSync(f, { force: true })
  }
}

// ───────────────────────── Importar ─────────────────────────

const ATTACHMENT_ENTRY = /^attachments\/([0-9a-f]{2})\/([0-9a-f]{64})\/(.+)$/

function isSqlite(file: string): boolean {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(16)
    return readSync(fd, head, 0, 16, 0) === 16 && head.toString('latin1') === 'SQLite format 3\u0000'
  } finally {
    closeSync(fd)
  }
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((ok, fail) =>
    yauzl.open(file, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true, autoClose: true }, (err, zip) => (err ? fail(new AppError('INVALID_INPUT', `El archivo no es una exportación válida de ZHASKA (${err.message}).`)) : ok(zip!))),
  )
}

/** Comprueba un archivo de importación y lo deja preparado en import/<token>/ (sin tocar tus datos). */
export async function stageImport(o: { file: string; importDir: string; tmpDir: string }): Promise<ImportSummary> {
  const token = randomUUID()
  const dir = stagingDir(o.importDir, token)
  mkdirSync(dir, { recursive: true })
  try {
    let manifest: ExportManifest | null = null
    let attachmentsCount = 0
    if (isSqlite(o.file)) {
      // Una copia de seguridad suelta (.db), p. ej. de la carpeta backups de otro equipo
      copyFileSync(o.file, join(dir, 'zhaska.db'))
    } else {
      const zip = await openZip(o.file)
      if (zip.entryCount > MAX_ENTRIES) {
        zip.close()
        throw new AppError('INVALID_INPUT', 'El archivo tiene demasiadas entradas para ser una exportación de ZHASKA.')
      }
      let total = 0
      await new Promise<void>((done, fail) => {
        const stop = (e: Error) => {
          zip.close()
          fail(e)
        }
        zip.on('error', (e: Error) => fail(new AppError('INVALID_INPUT', `El archivo está dañado: ${e.message}`)))
        zip.on('end', () => done())
        zip.on('entry', (entry: yauzl.Entry) => {
          const name = (entry.fileName as unknown as Buffer).toString('utf8')
          if (name.endsWith('/')) return zip.readEntry() // carpetas implícitas
          const bad = (why: string) => stop(new AppError('INVALID_INPUT', `El archivo no es una exportación válida de ZHASKA: ${why} (${name.slice(0, 120)}).`))
          const unsafe = unsafeZipName(name)
          if (unsafe) return bad(unsafe)
          const att = ATTACHMENT_ENTRY.exec(name)
          if (name !== 'manifest.json' && name !== 'zhaska.db' && !(att && att[2]!.startsWith(att[1]!))) return bad('contiene un elemento inesperado')
          if (att && EXECUTABLE_EXT.has(extname(name).slice(1).toLowerCase())) return bad('contiene un ejecutable')
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) return bad('tiene entradas cifradas')
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff
          if ((mode & 0xf000) === 0xa000) return bad('contiene un enlace simbólico')
          total += entry.uncompressedSize
          if (total > MAX_TOTAL) return bad('ocupa demasiado al descomprimirse')
          if (entry.uncompressedSize > 50 * 1024 ** 2 && entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_RATIO) return bad('posible bomba ZIP')
          if (att) attachmentsCount++
          const target = resolve(dir, ...name.split('/'))
          if (!target.startsWith(dir + sep)) return bad('ruta fuera de la carpeta de importación')
          mkdirSync(resolve(target, '..'), { recursive: true })
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) return stop(new AppError('INVALID_INPUT', `No se pudo leer ${name}: ${err?.message}`))
            pipeline(stream, createWriteStream(target, { flags: 'wx' })).then(
              () => zip.readEntry(),
              (e: Error) => stop(new AppError('INVALID_INPUT', `No se pudo extraer ${name}: ${e.message}`)),
            )
          })
        })
        zip.readEntry()
      })
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ExportManifest
      } catch {
        throw new AppError('INVALID_INPUT', 'Falta manifest.json: no es una exportación de ZHASKA.')
      }
      if (manifest.app !== 'ZHASKA' || typeof manifest.format !== 'number') throw new AppError('INVALID_INPUT', 'No es una exportación de ZHASKA.')
      if (manifest.format > EXPORT_FORMAT) throw new AppError('INVALID_INPUT', 'La exportación es de una versión más nueva de ZHASKA. Actualiza la aplicación antes de importarla.')
      if (!existsSync(join(dir, 'zhaska.db'))) throw new AppError('INVALID_INPUT', 'La exportación no contiene la base de datos.')
    }
    const summary = inspectDatabase(join(dir, 'zhaska.db'), o.tmpDir)
    return {
      ...summary,
      token,
      fileName: basename(o.file),
      createdAt: manifest?.createdAt ?? statSync(o.file).mtimeMs,
      appVersion: manifest?.appVersion ?? null,
      attachmentFiles: attachmentsCount,
      bytes: statSync(o.file).size,
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}
