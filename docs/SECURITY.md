# Seguridad — ZHASKA

Revisión de la Fase 9 (23-11-2026), completada en la Fase 10 con los fusibles. Recoge el modelo de amenazas, la lista de comprobación oficial de Electron punto por punto, la auditoría de los 88 canales IPC y los límites que conviene conocer. La arquitectura general está en [ARCHITECTURE.md §4 y §9](../ARCHITECTURE.md).

## 1. Modelo de amenazas

| Quién | Qué podría intentar | Defensa principal |
|---|---|---|
| **El modelo de IA** (se equivoca o lo engaña un archivo del proyecto, un adjunto o una web) | Borrar o sobrescribir archivos, ejecutar comandos destructivos, leer secretos, salir del proyecto | Permisos por acción + aprobación del usuario, CommandPolicy, PathGuard, archivos protegidos, instantáneas para deshacer |
| **Contenido que muestra la interfaz** (respuestas del modelo, archivos, adjuntos) | Inyectar HTML o scripts en la ventana | Markdown sin HTML crudo, enlaces no navegables, CSP estricta, sandbox |
| **Un archivo de importación o una copia manipulados** | Escribir fuera de su carpeta, bomba ZIP, base de datos dañada | Lista blanca de rutas, validación de nombres, límites, comprobación de integridad antes de usarlo |
| **La interfaz comprometida** (si algo lograra ejecutar código en ella) | Usar el IPC para tocar el disco o enviar datos fuera | Todo canal valida origen y datos; rutas solo relativas o elegidas por el usuario; ajustes con lista blanca; Ollama solo en este equipo |

Fuera de alcance: alguien con acceso a tu sesión de Windows (puede leer tus archivos igual que ZHASKA) y un sistema operativo ya comprometido.

## 2. Lista de comprobación de Electron

Basada en la [guía oficial de seguridad de Electron](https://www.electronjs.org/docs/latest/tutorial/security). Las comprobaciones automáticas están en `scripts/smoke.cjs` (app real) y `tests/unit/`.

| # | Recomendación | Estado | Dónde |
|---|---|---|---|
| 1 | Cargar solo contenido seguro | ✅ La interfaz se sirve desde `app://zhaska` (archivos de la instalación). La única conexión HTTP es la de main con Ollama en `127.0.0.1` (el ajuste `ollamaHost` solo admite direcciones de este equipo). Las descargas de modelos van por HTTPS | `src/main/protocol.ts`, `src/shared/settings.ts` |
| 2 | Sin Node.js en contenido remoto | ✅ `nodeIntegration: false` (no hay contenido remoto) | `src/main/index.ts` |
| 3 | Aislamiento de contexto | ✅ `contextIsolation: true`; el preload expone un puente mínimo | `src/preload/index.ts` |
| 4 | Sandbox de procesos | ✅ `sandbox: true` en la ventana y `app.enableSandbox()` para todo contenido web | `src/main/index.ts` |
| 5 | Gestionar las peticiones de permisos | ✅ Se deniegan todas (cámara, micrófono, notificaciones, geolocalización…) | `setPermissionRequestHandler` / `setPermissionCheckHandler` |
| 6 | No desactivar `webSecurity` | ✅ `webSecurity: true` | `src/main/index.ts` |
| 7 | Content-Security-Policy | ✅ Estricta, como `<meta>` y además como cabecera HTTP de `app://`: `script-src 'self'`, sin `unsafe-eval`, `connect-src 'self'`, `object-src`, `frame-src` y `frame-ancestors 'none'` | `src/shared/csp.ts` |
| 8 | No activar `allowRunningInsecureContent` | ✅ Valor por defecto (desactivado) | — |
| 9 | Sin funciones experimentales | ✅ No se activan | — |
| 10 | Sin `enableBlinkFeatures` | ✅ No se usa | — |
| 11 | `<webview>` sin `allowpopups` | ✅ No hay `<webview>` | — |
| 12 | Verificar opciones de `<webview>` | ✅ `will-attach-webview` se cancela siempre, en cualquier webContents | `src/main/index.ts` |
| 13 | Limitar la navegación | ✅ `will-navigate` y `will-redirect` se cancelan salvo recargar la misma página | `src/main/index.ts` |
| 14 | Limitar ventanas nuevas | ✅ `setWindowOpenHandler → deny` en todo webContents (`window.open` devuelve `null`, comprobado en la prueba completa) | `src/main/index.ts` |
| 15 | `shell.openExternal` sin contenido no confiable | ✅ Solo con la URL fija de descarga de Ollama. Los enlaces del modelo no son navegables | `src/main/services/ollama.ts`, `Markdown.tsx` |
| 16 | Electron actualizado | ✅ Electron 45.4.1, la última estable (comprobado en npm el 23-11-2026) | `package.json` |
| 17 | Validar el remitente de todo mensaje IPC | ✅ Cada canal comprueba `senderFrame.url` (`app://zhaska` o el servidor de desarrollo) y valida la petición con zod | `src/main/ipc/router.ts` |
| 18 | Protocolo propio en vez de `file://` | ✅ `app://` con comprobación de que la ruta pedida no sale de la carpeta de la interfaz | `src/main/protocol.ts` |
| 19 | Fusibles (*fuses*) de Electron | ✅ **(Fase 10)** Aplicados al empaquetar: `RunAsNode=off`, `EnableNodeOptionsEnvironmentVariable=off`, `EnableNodeCliInspectArguments=off`, `EnableEmbeddedAsarIntegrityValidation=on`, `OnlyLoadAppFromAsar=on`, `EnableCookieEncryption=on`, `GrantFileProtocolExtraPrivileges=off`. Comprobados en `ZHASKA.exe` y en la app de macOS (`scripts/package-e2e.mjs`). En desarrollo no se aplican (romperían `npm run dev`) | `electron-builder.yml` |
| 20 | No exponer APIs de Electron a contenido no confiable | ✅ El preload solo expone `invoke`/`on` con listas blancas (`src/shared/ipc/channels.ts`, verificada por test) y una función para carpetas arrastradas; nunca `ipcRenderer` ni Node | `src/preload/index.ts` |

## 3. Auditoría del IPC

Reglas comunes a los 88 canales (`src/shared/ipc/contract.ts`): esquema zod con longitudes máximas, origen verificado, respuesta `IpcResult` con códigos estables, y en desarrollo también se valida la respuesta. Cambios de la Fase 9 marcados con **(F9)**.

| Grupo | Canales | Qué puede hacer | Protecciones |
|---|---|---|---|
| App y diálogos | `app.info`, `dialog.pickFolder` | Información de versión; selector nativo de carpeta | **(F9)** La carpeta elegida queda «concedida» para abrir o crear proyectos en esta sesión |
| Proyectos | `projects.*` (11) | Abrir, crear, clonar, renombrar, olvidar | **(F9)** Solo carpetas elegidas en el selector, arrastradas a la ventana (canal exclusivo del preload, la ruta sale de `webUtils`) o ya conocidas. Nunca la raíz de un disco, la carpeta personal completa, carpetas del sistema, de credenciales o los datos de ZHASKA (`sensitivePaths.ts`) |
| Carpetas autorizadas | `projects.authorizedDirs`, `.authorizeDir`, `.revokeDir` **(F9)** | Dar al agente lectura de una carpeta externa | La carpeta la elige el usuario en un selector que abre main (la interfaz no envía la ruta); se rechazan las sensibles; máximo 20 |
| Archivos | `fs.*` (7) | Explorar y editar el proyecto (acciones del usuario) | Rutas relativas + `PathGuard` (enlaces, `..`, UNC, nombres reservados, ADS); borrar va a la papelera; escritura con control de conflictos; 20 MB máximo |
| Conversaciones | `conversations.*`, `messages.*` | Historial | **(F9)** `messages.add` solo admite `user`/`assistant` (la interfaz no puede inyectar mensajes de sistema) |
| Ajustes | `settings.getAll`, `settings.set` | Preferencias | **(F9)** Lista blanca de claves con su tipo (`src/shared/settings.ts`); `ollamaHost` solo en este equipo; `projectsDir` debe venir del selector; patrones protegidos sin rutas absolutas ni `..` |
| Ollama y modelos | `ollama.*`, `models.*`, `system.hardware`, `bench.*` | Gestionar el servidor local y los modelos | Nombres de modelo validados; instalar Ollama solo con acción del usuario |
| Chat y agente | `chat.*`, `agent.*`, `activity.*`, `changes.*`, `rules.*` | Tareas, aprobaciones, revisar y deshacer cambios | El agente corre aislado (Agent Host); las aprobaciones llegan con `requestId`; deshacer verifica hashes |
| Adjuntos | `attachments.*` | Subir y ver adjuntos | La interfaz envía bytes, nunca rutas; 50 MB; extracción en un hilo aparte; ZIP seguro |
| Terminal | `terminal.*` | La terminal del usuario | Es una terminal real (como en cualquier IDE): ejecuta lo que el usuario escribe. Datos acotados a 64 KB por mensaje. Lo que ejecuta el **agente** no pasa por aquí: va por `execute_command` con CommandPolicy y aprobación |
| Copias | `backups.list`, `.create`, `.reveal`, `.inspect` **(F9)**, `.restore` **(F9)** | Crear, revisar y restaurar copias | Solo nombres de archivo de la carpeta de copias (patrón estricto, sin rutas); comprobación de integridad y versión; copia del estado actual antes de restaurar; no con tareas en curso |
| Datos **(F9)** | `data.exportEstimate`, `.export`, `.importInspect`, `.importApply`, `.importCancel`, `.lastOperation` | Exportar e importar todo | Los diálogos de archivo los abre main; importación con lista blanca de rutas, nombres validados, sin ejecutables ni enlaces, límites y detección de bombas ZIP; se aplica al reiniciar tras copiar el estado actual |
| Instantáneas **(F9)** | `checkpoints.usage`, `.collect` | Espacio y limpieza | Nunca borra las de cambios pendientes ni las de menos de una hora |

Canal fuera de la lista blanca de la interfaz: `paths.grantDropped`, solo lo invoca el preload con la ruta que devuelve `webUtils.getPathForFile` para una carpeta arrastrada de verdad.

## 4. El agente

### 4.1 Permisos

- Niveles *Preguntar siempre*, *Equilibrado* y *Autónomo*, más una política por acción (leer, escribir, ejecutar, instalar, internet). Internet está bloqueado por defecto.
- **Siempre se pregunta**, sea cual sea el nivel: comandos peligrosos, rutas fuera del proyecto, archivos protegidos (leer o escribir), eliminar archivos (también con un comando, porque no deja instantánea) y cualquier lectura fuera del proyecto que no esté en una carpeta autorizada.
- «Siempre en este proyecto» nunca se puede conceder para esas acciones, y la tarjeta de aprobación no ofrece el botón. **(F9)** Antes, aprobar con «Siempre aquí» un borrado creaba una regla que permitía después cualquier escritura; ya no.
- Comprobado con Gemma 4 en modo autónomo: lee una carpeta autorizada sin preguntar y pide permiso para leer `.env`; al denegarlo, responde sin revelar el contenido.

### 4.2 CommandPolicy (revisada en la Fase 9)

Analiza el comando tokenizado y por subcomandos. Huecos encontrados en la revisión y corregidos, todos con prueba en `tests/unit/security.test.ts`:

| Antes | Ahora |
|---|---|
| `find . -delete` era **seguro** (se ejecutaba sin preguntar) | Peligroso; `find -exec` se analiza por dentro |
| Un salto de línea ocultaba un segundo comando (`echo hola⏎rm -rf src`) | Los saltos de línea separan comandos |
| `/bin/rm -rf`, `\rm -rf`, `VAR=1 rm -rf`, `env rm -rf`, `sudo -u x rm` no se reconocían | Se quita la ruta y los prefijos y se analiza el programa real |
| `ls \| xargs rm`, `Get-ChildItem \| Remove-Item`, bloques `{ }` y subshells `( )` | Se analizan; borrar lo que llega por una tubería es peligroso |
| `powershell -EncodedCommand`, `pwsh -enc` | Peligrosos (código opaco) |
| `$(…)` y `` `…` `` dentro de comillas dobles | Detectados |
| `npm run x` era seguro aunque el script borrase | Se expande el script de package.json (y sus `pre`/`post`) y se juzga lo que ejecuta |
| `cat $HOME/.ssh/id_rsa`, `%USERPROFILE%`, `$env:APPDATA` | Rutas fuera del proyecto |
| `npm i -g`, `cargo install`, `git config --global`, `setx`, registro de Windows, `certutil`, `shred`… | Peligrosos |
| `node -e`/`python -c` con borrados o procesos | Peligrosos; el resto de código en línea, «normal» (nunca seguro) |
| Falsos positivos: `> /dev/null`, `2>&1`, `dir /b` | Ya no se marcan |
| Borrados simples (`rm a.txt`) se ejecutaban sin preguntar en modo autónomo | Siempre preguntan |

**Limitación declarada**: un clasificador no es un sandbox. Siempre puede haber una forma de escribir un comando que no reconozca. Por eso la defensa real es la combinación de aprobación del usuario, instantáneas para deshacer y trabajar siempre en la raíz del proyecto. Un sandbox de verdad (AppContainer / Windows Sandbox) queda para después de la v1.

### 4.3 Archivos protegidos (editables desde la Fase 9)

Por defecto: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc` y `.git/**`. Se editan en Ajustes → Agente y permisos. Leerlos o modificarlos (con herramientas o comandos) pide confirmación; su contenido no aparece en `search_code` (se indica cuántos se omitieron).

### 4.4 Fuera del proyecto

- Las herramientas de archivos **solo modifican el proyecto**.
- Leer fuera: sin preguntar en las carpetas autorizadas para ese proyecto; cualquier otra ruta pide aprobación y se concede solo esa ruta y solo para esa tarea.
- Nunca, ni aprobándolo: los datos de ZHASKA, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, rutas de red (UNC) ni flujos alternativos de NTFS.
- Los enlaces simbólicos que salen de una carpeta autorizada necesitan aprobación.

## 5. Persistencia

- **Copias de la base de datos**: diarias (se conservan 7, configurable), antes de cada migración, manuales y, desde la Fase 9, antes de restaurar y de importar. Son archivos SQLite autónomos (sin `-wal`), creados con la API de backup en línea.
- **Restaurar**: se comprueba la copia (integridad, que sea de ZHASKA y de una versión compatible), se programa y la app se reinicia. Al arrancar, antes de abrir la base de datos: se copia la entrante, se vuelca el WAL actual, se guarda la copia «Antes de restaurar» y, como último paso, se sustituye con un renombrado. Si algo falla, los datos actuales no cambian y la interfaz lo avisa. Prueba de punta a punta: `npm run test:restore`.
- **Exportar / importar**: un archivo `.zhaska` (ZIP) con `manifest.json`, `zhaska.db` y, opcionalmente, los adjuntos. Tu código no se incluye (está en tus carpetas). Importar sustituye los datos tras guardar «Antes de importar»; los adjuntos se añaden sin sobrescribir.
- **Actualizaciones (Fase 10)**: comprobar solo con permiso y tras el asistente; descargar e instalar los decide el usuario; sha512 verificado; copia «Antes de actualizar»; los datos (`%APPDATA%\ZHASKA`) nunca los toca el instalador ni el desinstalador.
- **Instantáneas del agente**: se conservan las de cambios pendientes siempre y el resto durante el plazo configurado (30 días por defecto); la limpieza corre al arrancar y cada día.

## 6. Pendiente

- Validación de todo lo anterior en Windows 11 con la RTX 5060.
- Aviso de seguridad leve de npm en `dompurify` (dependencia de `monaco-editor`).
