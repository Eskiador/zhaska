/**
 * CommandPolicy (ARCHITECTURE §9.3, revisada en la Fase 9): clasifica un comando de shell ANTES de ejecutarlo.
 * - safe: lectura o tareas de desarrollo habituales (git status, tsc --noEmit, npm test…)
 * - normal: el resto
 * - dangerous: borrados recursivos o irrecuperables, privilegios, instaladores y herramientas del sistema,
 *   configuración sensible, Git destructivo, código ejecutado desde una cadena o una descarga…
 * Además detecta uso de red, rutas fuera del proyecto, borrados (se preguntan siempre) y archivos protegidos.
 *
 * Analiza el comando TOKENIZADO y por subcomandos (&& || ; | & saltos de línea, subshells y bloques { }),
 * quitando prefijos que esconden el programa real (VAR=1, env, sudo, xargs, npx, /bin/rm, \rm…), y expande
 * los scripts de package.json (`npm run x`, `npm test`) para juzgar lo que de verdad se ejecuta.
 *
 * LIMITACIÓN DECLARADA: un clasificador no es un sandbox. La defensa real es la aprobación del usuario,
 * los puntos de restauración y que el directorio de trabajo sea siempre la raíz del proyecto.
 */

export interface CommandAssessment {
  level: 'safe' | 'normal' | 'dangerous'
  network: boolean
  outsideProject: boolean
  /** Borra archivos: se pregunta siempre, también en modo autónomo (no hay instantánea que lo deshaga) */
  deletes: boolean
  /** Primer archivo protegido que menciona (patrón que coincide) */
  protectedPath?: string
  reasons: string[]
}

export interface PolicyContext {
  /** ¿Esta ruta absoluta está dentro del proyecto? */
  isInsideProject?: (abs: string) => boolean
  /** Contenido de un script de package.json, o null si no existe */
  npmScript?: (name: string) => string | null
  /** Patrón protegido que coincide con esta ruta relativa (o undefined) */
  protectedHit?: (rel: string) => string | undefined
}

interface Tok {
  v: string
  op?: true
}

/**
 * Tokeniza respetando comillas simples y dobles; separa los operadores de control y de redirección.
 * Los saltos de línea separan comandos (como `;`). `2>&1` y similares se descartan (no escriben en disco).
 */
function lex(cmd: string): { tokens: Tok[]; substitution: boolean } {
  const tokens: Tok[] = []
  let cur = ''
  let quoted = false
  let quote: '"' | "'" | null = null
  let substitution = false
  const push = () => {
    if (cur || quoted) tokens.push({ v: cur })
    cur = ''
    quoted = false
  }
  const op = (v: string) => {
    push()
    tokens.push({ v, op: true })
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote) {
      if (c === quote) quote = null
      else {
        // Dentro de comillas dobles la shell sigue sustituyendo $(…) y `…`
        if (quote === '"' && (c === '`' || (c === '$' && cmd[i + 1] === '('))) substitution = true
        cur += c
      }
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      quoted = true
      continue
    }
    if (c === '\n' || c === '\r') {
      op(';')
      continue
    }
    if (/\s/.test(c)) {
      push()
      continue
    }
    // `\;` (find -exec … \;) es un `;` literal
    if (c === '\\' && cmd[i + 1] === ';') {
      push()
      tokens.push({ v: ';' })
      i++
      continue
    }
    if (c === '>') {
      // El número justo antes de > es el descriptor (2>archivo, 2>&1), no un argumento
      const start = i - cur.length
      if (/^[0-9]$/.test(cur) && (start === 0 || /\s/.test(cmd[start - 1]!))) cur = ''
      // >&1, >&2, >&-: duplicar descriptores no escribe en disco
      if (cmd[i + 1] === '&' && /[0-9-]/.test(cmd[i + 2] ?? '')) {
        push()
        i += 2
        continue
      }
    }
    if (c === '&' && cmd[i + 1] === '>') {
      op(cmd[i + 2] === '>' ? '>>' : '>')
      i += cmd[i + 2] === '>' ? 2 : 1
      continue
    }
    // {} literal (find -exec … {} \;)
    if (c === '{' && cmd[i + 1] === '}') {
      cur += '{}'
      i++
      continue
    }
    const two = cmd.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === '>>') {
      op(two)
      i++
      continue
    }
    if (c === '$' && cmd[i + 1] === '(') {
      substitution = true
      op('$(')
      i++
      continue
    }
    if (c === '`') substitution = true
    if (';|&><`(){}'.includes(c)) {
      // ${VAR} no es un bloque
      if (c === '{' && cur.endsWith('$')) {
        cur += c
        continue
      }
      if (c === '}' && /\$\{[^}]*$/.test(cur)) {
        cur += c
        continue
      }
      op(c)
      continue
    }
    cur += c
  }
  push()
  return { tokens, substitution }
}

/** Tokens del comando (sin comillas). */
export function tokenize(cmd: string): string[] {
  return lex(cmd).tokens.map((t) => t.v)
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '(', ')', '{', '}', '$(', '`'])

interface Segment {
  words: string[]
  writes: string[]
  reads: string[]
  pipedIn: boolean
}

function split(tokens: Tok[]): Segment[] {
  const out: Segment[] = []
  let cur: Segment = { words: [], writes: [], reads: [], pipedIn: false }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.op && SEPARATORS.has(t.v)) {
      if (cur.words.length || cur.writes.length || cur.reads.length) out.push(cur)
      cur = { words: [], writes: [], reads: [], pipedIn: t.v === '|' }
      continue
    }
    if (t.op && (t.v === '>' || t.v === '>>' || t.v === '<')) {
      const target = tokens[i + 1]
      if (target && !target.op) {
        ;(t.v === '<' ? cur.reads : cur.writes).push(target.v)
        i++
      }
      continue
    }
    cur.words.push(t.v)
  }
  if (cur.words.length || cur.writes.length || cur.reads.length) out.push(cur)
  return out
}

/** Divide en subcomandos (compatibilidad). */
export function segments(tokens: string[]): string[][] {
  return split(tokens.map((v) => (SEPARATORS.has(v) || v === '>' || v === '>>' || v === '<' ? { v, op: true as const } : { v }))).map((s) => s.words)
}

/** Nombre real del programa: sin ruta, sin `\` inicial, sin extensión de Windows y en minúsculas. */
const progName = (t: string) =>
  t
    .replace(/^\\+/, '')
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1|com)$/, '')

const lowerArgs = (args: string[]) => args.map((a) => a.toLowerCase())
const has = (args: string[], ...flags: string[]) => lowerArgs(args).some((a) => flags.includes(a))
const hasShortFlag = (args: string[], letter: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter))
/** Parámetros abreviables de PowerShell: -Recurse, -Rec, -r… */
const psParam = (args: string[], full: string, min = 1) => args.some((a) => a.startsWith('-') && a.length - 1 >= min && full.startsWith(a.slice(1).toLowerCase()))

const NULL_DEVICES = new Set(['/dev/null', 'nul', 'nul:', '$null', '/dev/stdout', '/dev/stderr'])
const POSIX_TOP = new Set(['etc', 'usr', 'bin', 'sbin', 'var', 'tmp', 'opt', 'home', 'root', 'dev', 'proc', 'sys', 'lib', 'lib64', 'boot', 'mnt', 'media', 'srv', 'private', 'system', 'library', 'applications', 'users', 'volumes', 'cores', 'nix', 'snap', 'run'])
const PATH_VARS = /^(\$\{?|\$env:|%)(home|userprofile|homepath|homedrive|appdata|localappdata|programdata|programfiles|programfiles\(x86\)|systemroot|windir|systemdrive|temp|tmp|tmpdir|oldpwd|onedrive|public|allusersprofile|xdg_[a-z_]+)\b/i

/** ¿Es una ruta absoluta (o relativa al usuario) en lugar de un modificador como `/s` o `-r`? */
export function isAbsolutePath(t: string): boolean {
  if (/^[a-zA-Z]:([\\/]|$)/.test(t) || t.startsWith('\\\\') || t.startsWith('~') || PATH_VARS.test(t)) return true
  if (t.startsWith('/') && t.length > 1) {
    const first = t.slice(1).split('/')[0]!.toLowerCase()
    // `/s`, `/q`, `/im`, `/a:h`… son modificadores de Windows, salvo que sean directorios raíz POSIX conocidos
    if (!t.slice(1).includes('/') && /^[a-z?]{1,3}(:\S*)?$/i.test(t.slice(1)) && !POSIX_TOP.has(first)) return false
    return true
  }
  return false
}

const hasDotDot = (t: string) => /(^|[\\/])\.\.([\\/]|$)/.test(t)

const SYSTEM_INSTALLERS = new Set(['winget', 'choco', 'scoop', 'msiexec', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'snap', 'port', 'zypper', 'flatpak', 'install-module', 'install-package', 'install-script'])
const PRIVILEGE = new Set(['sudo', 'su', 'runas', 'doas', 'pkexec', 'gsudo'])
const SYSTEM_TOOLS = new Set([
  'format', 'diskpart', 'bcdedit', 'shutdown', 'reboot', 'halt', 'poweroff', 'takeown', 'icacls', 'cacls', 'mkfs', 'dd', 'fdisk', 'parted',
  'reg', 'regedit', 'sc', 'netsh', 'set-executionpolicy', 'chown', 'launchctl', 'systemctl', 'crontab', 'schtasks', 'setx', 'diskutil', 'csrutil',
  'nvram', 'mount', 'umount', 'vssadmin', 'wmic', 'bitsadmin', 'certutil', 'mshta', 'rundll32', 'regsvr32', 'stop-computer', 'restart-computer',
  'set-mppreference', 'add-mppreference', 'ufw', 'iptables', 'firewall-cmd', 'chattr', 'chflags', 'security', 'clear-recyclebin', 'bootcfg',
])
const WIPE = new Set(['shred', 'wipe', 'srm', 'sdelete'])
const DELETE = new Set(['rm', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'rmdir', 'rd', 'trash', 'rimraf', 'del-tree', 'deltree'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'powershell', 'pwsh', 'cmd'])
const EVAL = new Set(['eval', 'iex', 'invoke-expression', 'invoke-command', 'icm'])
const NETWORK_TOOLS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'telnet', 'rsync', 'start-bitstransfer'])
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const NPX = new Set(['npx', 'pnpx', 'bunx'])
const INLINE: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  bun: ['-e', '--eval'],
  python: ['-c'],
  python3: ['-c'],
  py: ['-c'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
}
const DESTRUCTIVE_CODE = /\b(rmSync|rmdirSync|unlinkSync|rm\s*\(|rmdir\s*\(|unlink\s*\(|rimraf|removeSync|emptyDir|rmtree|os\.remove|os\.unlink|os\.rmdir|send2trash|child_process|execSync|spawnSync|execFile|subprocess|os\.system|os\.popen|Remove-Item|system\s*\()/i
/** Comandos de solo lectura: no preguntan (salvo en «Preguntar siempre») */
const SAFE_SIMPLE = new Set([
  'ls', 'dir', 'pwd', 'cat', 'type', 'echo', 'printf', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'findstr', 'get-childitem', 'gci',
  'get-content', 'gc', 'tree', 'which', 'where', 'whoami', 'cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'get-location', 'write-output',
  'write-host', 'select-string', 'sls', 'measure-object', 'sort', 'uniq', 'diff', 'file', 'stat', 'du', 'date', 'true',
])
const VERSION_ONLY = new Set(['node', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'py', 'pip', 'pip3', 'git', 'tsc', 'deno', 'bun', 'go', 'cargo', 'rustc', 'java', 'dotnet', 'npx'])
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe', 'grep', 'ls-tree', 'cat-file'])

const MAX_DEPTH = 4

class Analyzer {
  dangerous = false
  network = false
  outside = false
  deletes = false
  protectedPath: string | undefined
  reasons: string[] = []

  constructor(private readonly ctx: PolicyContext) {}

  private flag(reason: string) {
    this.dangerous = true
    this.reasons.push(reason)
  }

  /** Evalúa una cadena de comando completa. Devuelve true si todos sus subcomandos son seguros. */
  command(cmd: string, depth: number): boolean {
    const { tokens, substitution } = lex(cmd)
    if (substitution) this.flag('Usa sustitución de comandos')
    const segs = split(tokens)
    let allSafe = segs.length > 0
    segs.forEach((s, idx) => {
      if (!this.segment(s.words, s, idx > 0 && s.pipedIn, depth)) allSafe = false
    })
    return allSafe && !substitution
  }

  private checkPath(t: string, write: boolean): boolean {
    if (!t || t.startsWith('-')) {
      // --out=/ruta
      const eq = t.indexOf('=')
      if (eq < 0) return true
      t = t.slice(eq + 1)
      if (!t) return true
    }
    let ok = true
    const inside = this.ctx.isInsideProject ?? (() => false)
    if ((isAbsolutePath(t) && !inside(t)) || hasDotDot(t)) {
      this.outside = true
      this.reasons.push(`${write ? 'Escribe' : 'Usa una ruta'} fuera del proyecto (${t})`)
      ok = false
    }
    if (this.ctx.protectedHit && !isAbsolutePath(t)) {
      const rel = t.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
      const hit = rel && this.ctx.protectedHit(rel)
      if (hit) {
        this.protectedPath ??= hit
        this.reasons.push(`Usa un archivo protegido (${t})`)
        ok = false
      }
    }
    return ok
  }

  /** Quita prefijos que esconden el programa real. Devuelve las palabras restantes. */
  private unwrap(words: string[]): { words: string[]; piped: boolean } {
    let w = [...words]
    let piped = false
    for (let guard = 0; guard < 10 && w.length; guard++) {
      const n = progName(w[0]!)
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) {
        w = w.slice(1)
        continue
      }
      if (PRIVILEGE.has(n)) {
        this.flag('Pide privilegios elevados')
        w = w.slice(1)
        while (w[0]?.startsWith('-') || w[0]?.startsWith('/user')) w = w.slice(w[0] === '-u' || w[0] === '-g' ? 2 : 1)
        continue
      }
      if (n === 'env') {
        w = w.slice(1)
        while (w[0] && (w[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w = w.slice(w[0] === '-u' ? 2 : 1)
        continue
      }
      if (['nohup', 'time', 'command', 'builtin', 'exec', 'call', 'stdbuf', 'caffeinate'].includes(n)) {
        w = w.slice(1)
        while (w[0]?.startsWith('-')) w = w.slice(1)
        continue
      }
      if (n === 'nice') {
        w = w.slice(1)
        if (w[0] === '-n') w = w.slice(2)
        else if (w[0]?.startsWith('-')) w = w.slice(1)
        continue
      }
      if (n === 'timeout') {
        w = w.slice(1)
        while (w[0]?.startsWith('-')) w = w.slice(1)
        w = w.slice(1) // duración
        continue
      }
      if (n === 'xargs') {
        w = w.slice(1)
        while (w[0]?.startsWith('-')) w = w.slice(/^-[IdLnPsE]$/.test(w[0]) ? 2 : 1)
        piped = true
        continue
      }
      if (NPX.has(n) || (PKG.has(n) && ['exec', 'dlx', 'x'].includes((w[1] ?? '').toLowerCase()))) {
        const offline = has(w, '--no-install', '--offline', '--no')
        if (!offline) this.network = true
        w = w.slice(NPX.has(n) ? 1 : 2)
        while (w[0]?.startsWith('-')) w = w.slice(w[0] === '-p' || w[0] === '--package' ? 2 : 1)
        if (w[0] === '--') w = w.slice(1)
        continue
      }
      if (n === 'start' && w.length > 1) {
        // cmd: start "título" programa
        w = w.slice(1)
        while (w[0]?.startsWith('/')) w = w.slice(1)
        continue
      }
      break
    }
    return { words: w, piped }
  }

  /** Analiza un subcomando. Devuelve true si es seguro. */
  private segment(rawWords: string[], seg: Pick<Segment, 'writes' | 'reads'>, pipedIn: boolean, depth: number): boolean {
    let safe = true
    for (const t of seg.writes) {
      if (NULL_DEVICES.has(t.toLowerCase())) continue
      safe = false
      this.checkPath(t, true)
    }
    for (const t of seg.reads) if (!this.checkPath(t, false)) safe = false

    const { words, piped } = this.unwrap(rawWords)
    pipedIn = pipedIn || piped
    if (!words.length) return safe && !this.dangerous
    const name = progName(words[0]!)
    const args = words.slice(1)
    const la = lowerArgs(args)
    const sub = la[0]

    for (const a of args) if (!this.checkPath(a, false)) safe = false
    if (args.some((a) => /^(https?|ftp):\/\//i.test(a) || /^git@[\w.-]+:/.test(a)) && !['echo', 'printf', 'write-host', 'write-output'].includes(name)) this.network = true

    // --- Privilegios, sistema, instaladores
    if (name === 'start-process' && psParam(args, 'verb', 2)) this.flag('Pide privilegios elevados')
    if (SYSTEM_INSTALLERS.has(name) || (name === 'brew' && ['install', 'uninstall', 'upgrade', 'reinstall', 'tap', 'remove', 'rm'].includes(sub ?? ''))) {
      this.flag('Instala o desinstala software del sistema')
      this.network = true
    }
    if (SYSTEM_TOOLS.has(name)) this.flag(`Herramienta del sistema: ${words[0]}`)
    if (['set-itemproperty', 'new-itemproperty', 'remove-itemproperty', 'sp'].includes(name) && args.some((a) => /^(hk(lm|cu|cr|u|cc)|registry)::?/i.test(a))) this.flag('Modifica el registro de Windows')
    if (args.some((a) => /::Set(Environment)?Variable/i.test(a)) || (name === 'defaults' && ['write', 'delete'].includes(sub ?? ''))) this.flag('Modifica una configuración sensible del sistema')
    const globalPkg = has(args, '-g', '--global', '--location=global')
    if (PKG.has(name) && globalPkg && ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'link'].includes(sub ?? '')) {
      this.flag('Instala o desinstala software global')
      this.network = true
    }
    if ((name === 'cargo' || name === 'go') && sub === 'install') this.flag('Instala un programa en el sistema')
    if ((name === 'pipx' && sub === 'install') || (name === 'dotnet' && sub === 'tool' && la[1] === 'install' && globalPkg)) this.flag('Instala un programa en el sistema')
    if (PKG.has(name) && (sub === 'config' || sub === 'set') && ['set', 'delete', 'edit'].includes(la[1] ?? (sub === 'set' ? 'set' : ''))) this.flag('Modifica la configuración global del gestor de paquetes')

    // --- Borrados
    const recursive =
      (name === 'rm' && (hasShortFlag(args, 'r') || hasShortFlag(args, 'R') || has(args, '--recursive'))) ||
      ((name === 'rmdir' || name === 'rd') && (has(args, '/s') || psParam(args, 'recurse', 1))) ||
      ((name === 'del' || name === 'erase') && (has(args, '/s') || psParam(args, 'recurse', 1))) ||
      ((name === 'remove-item' || name === 'ri') && psParam(args, 'recurse', 1)) ||
      name === 'rimraf' ||
      name === 'deltree' ||
      name === 'del-tree'
    if (DELETE.has(name) || WIPE.has(name) || (name === 'git' && sub === 'rm')) {
      this.deletes = true
      safe = false
      if (recursive) this.flag('Borrado recursivo')
      if (WIPE.has(name)) this.flag('Borrado irrecuperable')
      if (pipedIn) this.flag('Borra lo que recibe por una tubería')
    }
    if (name === 'cipher' && args.some((a) => /^\/w/i.test(a))) this.flag('Borrado irrecuperable')
    if (name === 'chmod' && hasShortFlag(args, 'R')) this.flag('Cambio recursivo de permisos')
    if (name === 'kill' && args.includes('-1')) this.flag('Termina todos los procesos')

    // --- find: -delete y -exec
    if (name === 'find') {
      if (la.includes('-delete')) {
        this.deletes = true
        this.flag('Borra los archivos que encuentra')
        safe = false
      }
      const ex = la.findIndex((a) => ['-exec', '-execdir', '-ok', '-okdir'].includes(a))
      if (ex >= 0) {
        safe = false
        const end = args.findIndex((a, i) => i > ex && (a === ';' || a === '+'))
        const inner = args.slice(ex + 1, end < 0 ? undefined : end)
        if (inner.length) this.segment(inner, { writes: [], reads: [] }, true, depth + 1)
      }
      if (la.some((a) => a.startsWith('-fprint') || a === '-fls')) safe = false
    }

    // --- Git
    if (name === 'git') {
      // Opciones globales: -C dir, -c clave=valor, --git-dir=…
      let i = 0
      while (i < la.length && la[i]!.startsWith('-')) {
        if (la[i] === '-c') {
          safe = false
          if (/^(core\.(hookspath|sshcommand|pager|editor|fsmonitor)|alias\.)/i.test(la[i + 1] ?? '')) this.flag('Configura Git para ejecutar otro programa')
        }
        i += la[i] === '-c' || la[i] === '-C' ? 2 : 1
      }
      const g = la[i]
      const rest = la.slice(i + 1)
      const destructive =
        (g === 'push' && (rest.some((a) => ['--force', '-f', '--force-with-lease', '--delete', '-d', '--mirror', '--prune'].includes(a) || /^\+|^:/.test(a)))) ||
        (g === 'reset' && rest.includes('--hard')) ||
        (g === 'clean' && rest.some((a) => /^-[a-z]*f/i.test(a) || a === '--force')) ||
        (g === 'checkout' && (rest.includes('--') || rest.includes('.') || rest.includes('-f') || rest.includes('--force'))) ||
        (g === 'restore' && !rest.includes('--staged')) ||
        (g === 'stash' && ['drop', 'clear'].includes(rest[0] ?? '')) ||
        (g === 'branch' && rest.some((a) => ['-d', '-D', '--delete', '-f', '--force'].includes(a))) ||
        (g === 'reflog' && ['expire', 'delete'].includes(rest[0] ?? '')) ||
        (g === 'gc' && rest.some((a) => a.startsWith('--prune'))) ||
        (g === 'update-ref' && rest.includes('-d')) ||
        g === 'filter-branch' ||
        g === 'filter-repo'
      if (destructive) this.flag('Operación de Git que puede perder trabajo')
      if (g === 'config' && rest.some((a) => ['--global', '--system'].includes(a)) && !rest.some((a) => ['--get', '--list', '-l', '--get-all'].includes(a))) this.flag('Modifica la configuración global de Git')
      if (['push', 'pull', 'fetch', 'clone', 'submodule', 'ls-remote'].includes(g ?? '')) this.network = true
      const readOnlyBranch = g === 'branch' && rest.every((a) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '--all', '--remotes'].includes(a))
      const readOnlyRemote = g === 'remote' && !['add', 'remove', 'rm', 'rename', 'set-url', 'prune', 'set-head', 'set-branches'].includes(rest[0] ?? '')
      const readOnlyStash = g === 'stash' && ['list', 'show'].includes(rest[0] ?? '')
      if (!(SAFE_GIT.has(g ?? '') || readOnlyBranch || readOnlyRemote || readOnlyStash) || (g === 'diff' && rest.some((a) => a.startsWith('--output')))) safe = false
      return safe && !this.dangerous
    }

    // --- Shells y evaluación de cadenas
    if (EVAL.has(name)) this.flag('Ejecuta código de una cadena')
    if (SHELLS.has(name)) {
      const codeFlag = la.some((a) => ['-c', '/c', '/k', '/r'].includes(a) || /^-(c|co|com|comm|comma|comman|command)$/.test(a) || /^-e(c|n|nc|nco|ncod|ncode|ncoded|ncodedc|ncodedco|ncodedcom|ncodedcomm|ncodedcomma|ncodedcomman|ncodedcommand)?$/.test(a))
      if (codeFlag) this.flag('Ejecuta código de una cadena')
      else if (pipedIn || args.length === 0) this.flag('Ejecuta lo que recibe por una tubería')
      safe = false
    }

    // --- Código en línea (node -e, python -c…)
    const inlineFlags = INLINE[name]
    if (inlineFlags) {
      const k = args.findIndex((a) => inlineFlags.includes(a))
      if (k >= 0) {
        safe = false
        const code = args.slice(k + 1).join(' ')
        if (DESTRUCTIVE_CODE.test(code)) this.flag('Ejecuta código que borra archivos o lanza procesos')
        if (/["'`(\s]([a-zA-Z]:\\|\/(etc|usr|bin|Users|home|var|System|Library)\/)/.test(` ${code}`)) {
          this.outside = true
          this.reasons.push('El código usa rutas fuera del proyecto')
        }
      }
    }

    // --- Red
    if (NETWORK_TOOLS.has(name)) this.network = true
    if (PKG.has(name) && ['install', 'i', 'add', 'ci', 'update', 'upgrade', 'up', 'dlx', 'create', 'publish', 'init', 'outdated', 'audit', 'info', 'view'].includes(sub ?? '')) this.network = true
    if ((name === 'pip' || name === 'pip3' || ((name === 'python' || name === 'python3' || name === 'py') && la[0] === '-m' && la[1] === 'pip')) && la.some((a) => ['install', 'download'].includes(a))) this.network = true
    if ((PKG.has(name) && sub === 'publish') || (name === 'cargo' && sub === 'publish') || name === 'twine') {
      this.flag('Publica un paquete')
      this.network = true
    }

    // --- Scripts de package.json: se juzga lo que ejecutan de verdad
    if (PKG.has(name)) {
      const BUILTIN = new Set(['install', 'i', 'add', 'ci', 'update', 'upgrade', 'up', 'remove', 'rm', 'uninstall', 'un', 'exec', 'dlx', 'x', 'create', 'publish', 'init', 'config', 'set', 'get', 'ls', 'list', 'outdated', 'audit', 'info', 'view', 'why', 'link', 'pack', 'prune', 'dedupe', 'cache', 'store', 'version', '-v', '--version', 'help'])
      const script = sub === 'run' || sub === 'run-script' ? la[1] : sub === 'test' || sub === 't' ? 'test' : name !== 'npm' && sub && !BUILTIN.has(sub) && !sub.startsWith('-') ? args[0] : undefined
      if (script && this.ctx.npmScript && depth < MAX_DEPTH) {
        const scriptName = sub === 'run' || sub === 'run-script' ? args[1]! : script
        const bodies = [`pre${scriptName}`, scriptName, `post${scriptName}`].map((s) => [s, this.ctx.npmScript!(s)] as const).filter((x): x is readonly [string, string] => !!x[1])
        if (!bodies.length && scriptName !== 'test') safe = false
        for (const [label, body] of bodies) {
          const before = this.reasons.length
          const innerSafe = this.command(body, depth + 1)
          for (let r = before; r < this.reasons.length; r++) this.reasons[r] = `Script «${label}» de package.json: ${this.reasons[r]}`
          if (!innerSafe && this.dangerous) safe = false
        }
        return safe && !this.dangerous && !this.outside
      }
      if (sub === 'test' || sub === 't' || ((sub === 'run' || sub === 'run-script') && !!args[1]) || sub === 'ls' || sub === 'list' || sub === 'outdated' || (sub === 'run' && !args[1])) return safe && !this.dangerous
      return false
    }

    // --- ¿Seguro?
    const isSafe =
      (SAFE_SIMPLE.has(name) && !(name === 'find' && !safe)) ||
      (VERSION_ONLY.has(name) && args.length === 1 && ['-v', '--version', '-version', 'version', '-V'].includes(args[0]!)) ||
      (name === 'tsc' && has(args, '--noemit')) ||
      name === 'pytest' ||
      ((name === 'python' || name === 'python3' || name === 'py') && la[0] === '-m' && ['pytest', 'unittest', 'py_compile', 'compileall'].includes(la[1] ?? ''))
    return safe && isSafe && !this.dangerous
  }
}

/**
 * @param ctxOrInside contexto de la política, o (compatibilidad) la función que decide si una ruta absoluta
 *   está dentro del proyecto.
 */
export function assessCommand(command: string, ctxOrInside: PolicyContext | ((abs: string) => boolean) = {}): CommandAssessment {
  const ctx: PolicyContext = typeof ctxOrInside === 'function' ? { isInsideProject: ctxOrInside } : ctxOrInside
  const a = new Analyzer(ctx)
  const allSafe = a.command(command, 0)
  const dangerous = a.dangerous || a.outside
  return {
    level: dangerous ? 'dangerous' : allSafe && !a.protectedPath ? 'safe' : 'normal',
    network: a.network,
    outsideProject: a.outside,
    deletes: a.deletes,
    ...(a.protectedPath ? { protectedPath: a.protectedPath } : {}),
    reasons: [...new Set(a.reasons)],
  }
}
