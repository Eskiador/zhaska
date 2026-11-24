# Probar ZHASKA en Windows

Guía para validar la Fase 10 en el PC de destino (Windows 10 22H2 o 11, x64; referencia: RTX 5060 8 GB, Ryzen 7 5800X, 16 GB). El criterio es: **instalación limpia en un Windows sin Node, Python ni Git → asistente inicial → primera tarea del agente**, y **actualizar de una versión a la siguiente conservando los datos**.

## 1. Conseguir el instalador

Hay dos formas. El resultado es el mismo: `ZHASKA-Setup-0.1.0.exe`.

**A. Desde el Mac de desarrollo.** El generador del instalador (NSIS) que trae electron-builder para macOS es un programa para Intel; en un Mac con Apple Silicon necesita **Rosetta 2** (una vez; en el Mac de desarrollo ya está instalada desde el 23-11-2026):

```bash
softwareupdate --install-rosetta --agree-to-license
```

```bash
npm run dist:win
```

El instalador queda en `dist/ZHASKA-Setup-0.1.0.exe` (unos 160 MB). Mientras no exista el repositorio de GitHub, se genera sin canal de actualizaciones (la app lo indica en Acerca de). Sin Rosetta se puede generar igualmente la app de Windows sin instalador (`npx electron-builder --win dir --x64`, carpeta `dist/win-unpacked`), que es la que usan las pruebas automáticas.

**B. Con GitHub Actions** (cuando exista el repositorio): al subir una etiqueta `v0.1.0`, el flujo `.github/workflows/release.yml` pasa todas las pruebas en `windows-latest`, genera el instalador y crea un **borrador** de versión en GitHub Releases. El borrador no llega a nadie hasta que lo publicas tú.

## 2. Instalar

1. Copia el `.exe` al PC y ábrelo.
2. El instalador no está firmado (decisión del 22-11-2026), así que Windows SmartScreen mostrará «Windows protegió su PC». Pulsa **Más información → Ejecutar de todas formas**.
3. El instalador está en español. Se instala solo para tu usuario y no pide permisos de administrador. Puedes cambiar la carpeta; por defecto es `%LOCALAPPDATA%\Programs\ZHASKA`.
4. Crea accesos directos en el escritorio y el menú Inicio y abre ZHASKA al terminar.

Comprueba:
- El programa está en `%LOCALAPPDATA%\Programs\ZHASKA` y tus datos en `%APPDATA%\ZHASKA` (carpetas separadas).
- En **Configuración → Acerca de ZHASKA** aparece la versión y «Fase 10».

## 3. Asistente inicial

Cada paso se comprueba de verdad:

| Paso | Qué comprobar |
|---|---|
| Entorno local | «Sistema compatible» (Windows 10 22H2 o 11, x64), memoria, **GPU con CUDA** (RTX 5060, 8 GB), espacio en disco. Si Ollama no está, **Instalar** lo descarga e instala; luego «Ollama encontrado». Node, Python y Git aparecen como «no encontrado» y eso es correcto: no hacen falta. |
| Modelo | Recomendado para tu equipo: Gemma 4 12B. **Descargar y continuar**, con progreso y velocidad. Al terminar, **Probar** (respuesta corta) y **Prueba de herramientas** (el modelo usa `list_files` en un proyecto de ejemplo temporal; debe decir «calculadora.ts»). Anota los tok/s. |
| Primer proyecto | Deja activada o desactiva «Buscar actualizaciones automáticamente» (solo envía la versión instalada). Pulsa **Probar el agente con un proyecto de ejemplo**: se crea `mi-primer-proyecto` y la primera tarea queda escrita en el chat. |

**Primera tarea del agente**: envía la tarea. En el panel de actividad verás cada paso; aprueba la creación de archivos (modo Equilibrado), revisa el diff y acéptalo. El resultado son `index.html` y `style.css` en el proyecto.

Si algo falla con Ollama, **Configuración → Ollama → Ver registros** (cuando lo arrancó ZHASKA). Los datos de la app están en `%APPDATA%\ZHASKA`.

## 4. Actualización de 0.1.0 a 0.1.1

Mientras no exista el repositorio de GitHub, la actualización se prueba con un canal local.

1. En el Mac (con Rosetta):

   ```bash
   node scripts/update-e2e.mjs --win
   ```

   Genera `dist/e2e-0.1.0/ZHASKA-Setup-0.1.0.exe` (configurado para buscar actualizaciones en `http://127.0.0.1:45789/`) y, en `dist/e2e-0.1.1/`, la versión nueva: solo hacen falta `latest.yml`, `ZHASKA-Setup-0.1.1.exe` y `ZHASKA-Setup-0.1.1.exe.blockmap`.
2. En el PC, instala la 0.1.0 de prueba, ábrela, crea algo (un proyecto, una conversación, cambia un ajuste) y adjunta un archivo.
3. Copia esos tres archivos al PC, juntos en una carpeta, junto con `scripts\serve-updates.ps1`, y sírvelos (no instala nada; se para con Ctrl+C):

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\ruta\serve-updates.ps1 -Folder C:\ruta\e2e-0.1.1
   ```

4. En ZHASKA: **Configuración → Acerca de ZHASKA → Buscar ahora**. Debe aparecer «Disponible la versión 0.1.1» y el aviso en la barra de estado.
5. **Descargar 0.1.1**: progreso y, al terminar, «descargada y verificada (sha512)».
6. **Reiniciar e instalar**: se guarda una copia «Antes de actualizar», el instalador se aplica en silencio (sin administrador) y ZHASKA se vuelve a abrir.
7. Comprueba: aviso «ZHASKA se actualizó a la versión 0.1.1»; **Acerca de** dice 0.1.1; siguen tus proyectos, conversaciones, adjuntos y ajustes; en **Privacidad y datos → Copias** aparece «Antes de actualizar».

## 5. Rendimiento de referencia

Con Ollama en marcha y el modelo descargado:
- En la app: **Configuración → Modelos → Banco de pruebas** (velocidad, contexto y llamadas a herramientas).
- Desde el código (si tienes Node en el PC): `ZHASKA_EVAL_MODEL=gemma4:12b-it-qat npm run eval:agent` (7 tareas reales del agente).

## 6. Desinstalar

**Configuración de Windows → Aplicaciones → ZHASKA → Desinstalar**. El desinstalador quita el programa y **no borra tus datos** (`%APPDATA%\ZHASKA`) ni tus proyectos. Si quieres borrarlos, hazlo a mano después.
