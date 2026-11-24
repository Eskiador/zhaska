# Propuesta para IT: asistente de IA local para la oficina

> Documento para presentar a IT y a la dirección antes de usar el asistente con documentos de la empresa.
> Describe qué hace ZHASKA, qué datos toca, dónde quedan y cómo se controlan los riesgos. Los datos medidos
> salen de las pruebas automáticas del proyecto (`tests/eval/assistant.eval.ts`, `npm run smoke`).

## 1. Qué es

Un asistente de inteligencia artificial que funciona **dentro de un ordenador de la empresa**, sin conexión a
servicios externos (ni ChatGPT, ni Claude, ni Google, ni Microsoft). Sirve para:

- **Preguntar a los documentos internos** (procedimientos, tarifas, listados de clientes, calendarios…). Cada
  respuesta indica de qué documento y página sale cada dato, para poder comprobarlo.
- **Resumir, redactar correos, traducir** (por ejemplo, notas de cargo en francés, alemán o polaco) y **pasar
  datos de un documento a una tabla**.

No sustituye a ninguna aplicación de la empresa ni escribe en ellas: solo lee y propone texto.

## 2. Cómo funciona (por dentro)

| Pieza | Qué es | Dónde se ejecuta |
|---|---|---|
| ZHASKA | Aplicación de escritorio (Electron), instalador por usuario sin permisos de administrador | El PC del usuario |
| Ollama | Servidor de modelos de IA, escuchando solo en `127.0.0.1` | El mismo PC |
| Gemma 4 (Google, licencia abierta) | Modelo de lenguaje que redacta las respuestas | El mismo PC (tarjeta gráfica) |
| EmbeddingGemma | Modelo pequeño que convierte el texto en un índice para buscar por significado | El mismo PC |
| Índice | Texto troceado de los documentos y sus vectores, en una base de datos SQLite | `%APPDATA%\ZHASKA` del usuario |

Flujo de una pregunta: el usuario pregunta → se buscan los fragmentos relevantes en el índice local (por
palabras y por significado) → se pasan al modelo junto con la pregunta → el modelo responde citando los
fragmentos → la app comprueba que las citas existen y avisa si no.

## 3. Datos: qué toca y dónde quedan

- **Documentos**: se **leen** de las carpetas que el usuario elige en el selector. Nunca se copian, mueven,
  modifican ni borran. El asistente no tiene ninguna herramienta para escribir o ejecutar nada.
- **Índice**: fragmentos de texto y vectores en `%APPDATA%\ZHASKA` (perfil del usuario). Se borra al quitar la
  carpeta o la base de conocimiento.
- **Conversaciones**: se guardan en la misma base de datos local, salvo las **privadas**, que solo existen en
  memoria y desaparecen al cerrar la app.
- **Bases confidenciales**: una base marcada como confidencial solo se puede usar en conversaciones privadas;
  nada de lo que se pregunte o se responda sobre ella se escribe en disco.
- **Adjuntos** del chat: se procesan en local, en un proceso aislado, y se guardan fuera de cualquier carpeta de
  trabajo.

## 4. Red

- La app solo habla con Ollama en `127.0.0.1` (el propio PC). La dirección de Ollama no se puede cambiar a un
  servidor de otra máquina desde la interfaz.
- Conexiones a internet que existen y **solo ocurren si el usuario las pide**: descargar un modelo (una vez,
  desde el registro de Ollama), buscar actualizaciones de ZHASKA (opcional; se puede desactivar) e instalar Ollama.
- Comprobado en las pruebas automáticas: durante la indexación, la búsqueda y las respuestas, **todas** las
  peticiones de red van a `127.0.0.1`.

## 5. Riesgos y cómo se controlan

| Riesgo | Control |
|---|---|
| La IA se equivoca o inventa un dato | Cita obligatoria de la fuente; si no lo encuentra debe decir «No aparece en tus documentos»; la app avisa si cita fuentes inexistentes o da cifras sin citar; aviso permanente de comprobar importes y fechas en el original |
| Fuga de documentos | Sin conexión externa; sin herramientas de escritura ni de envío; índice en el perfil del usuario |
| Acceso a carpetas sensibles | No se pueden indexar la raíz del disco, la carpeta personal completa, carpetas del sistema ni de credenciales |
| Documentos maliciosos (PDF, ZIP…) | Lectura en un proceso aislado; los ZIP y ejecutables no se indexan; comprobación del tipo real de cada archivo |
| Ataque al propio PC | El asistente es tan seguro como el equipo donde se ejecuta: aplica la política habitual de IT (antivirus, cifrado de disco, cuentas) |
| Instrucciones escondidas dentro de un documento | El asistente no puede ejecutar nada, así que como mucho afectarían al texto de la respuesta, que el usuario revisa |

## 6. Resultados medidos

Evaluación automática (`tests/eval/assistant.eval.ts`, 24-11-2026) sobre 8 documentos de una empresa ficticia (Word, Excel con varias hojas, PDF, texto): 12 preguntas con la respuesta en los documentos y 4 sin ella.

| Modelo | Aciertos | Citas correctas | Preguntas sin respuesta → «No aparece» | Datos inventados | Tiempo medio* |
|---|---|---|---|---|---|
| Gemma 4 E4B | 12/12 | 12/12 | 4/4 | 0 | 20 s |
| Gemma 4 12B | 12/12 | 12/12 | 4/4 | 0 | 49 s |

\* En un Mac M4. En el PC de referencia (RTX 5060 8 GB), el E4B genera texto unas 10 veces más rápido que el 12B (148 frente a 14 tokens/s), así que la diferencia será mayor. Indexar los 8 documentos tardó 1,2 s.

Red durante toda la evaluación: solo `127.0.0.1`. En una prueba anterior, con un PDF de prueba cuyo texto estaba cortado, los dos modelos respondieron que el texto estaba incompleto en vez de inventar las fechas.

## 7. Opciones para la empresa

1. **Prueba en un solo PC** (estado actual): un usuario, con documentos que IT autorice. Sin coste.
2. **Servidor interno** (no construido; requiere aprobación): un equipo dentro de la red con una tarjeta
   gráfica de 16–24 GB de VRAM, al que 5–10 personas acceden **desde el navegador** sin instalar nada. Haría falta:
   - inicio de sesión de los usuarios (idealmente con las cuentas de la empresa);
   - permisos por base de conocimiento (quién ve qué documentos);
   - registro de auditoría (quién preguntó qué y cuándo), según lo que decida IT;
   - copia de seguridad del índice y actualización del servidor.

## 8. Qué se pide a IT

- Autorizar (o no) el uso de documentos internos con el asistente en un PC concreto durante una prueba.
- Indicar qué carpetas o tipos de documento se pueden usar y cuáles no.
- Si la prueba sale bien, valorar la opción del servidor interno.
