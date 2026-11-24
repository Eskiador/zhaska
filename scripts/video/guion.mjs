/**
 * Guion del vídeo de demostración de ZHASKA: escenas y frases de narración (voz «Mónica», español de España).
 * Protagonista: el modo Chat, para toda la empresa. El modo Código, más breve, para desarrolladores.
 * Mensaje que se repite: mensajes ilimitados (sin cuotas, sin suscripción, sin pago por uso).
 * Cada frase («beat») se graba sincronizada con lo que pasa en pantalla (scripts/video/grabar.cjs).
 * Los datos de ejemplo son de una empresa ficticia (Quesos del Prado S.L.).
 */
export const ESCENAS = [
  {
    id: 'portada',
    titulo: 'ZHASKA',
    beats: [
      {
        id: 'intro',
        texto:
          'Esto es ZHASKA: un asistente de inteligencia artificial para toda la empresa que funciona por completo en tu ordenador. Sin enviar tus documentos a nadie, y con mensajes ilimitados: sin cuotas, sin suscripciones y sin pagar por cada pregunta.',
      },
    ],
  },
  {
    id: 'asistente-inicial',
    titulo: '1 · Primer arranque',
    beats: [
      { id: 'bienvenida', texto: 'La primera vez que abres ZHASKA aparece un asistente de cuatro pasos. Todo se ejecuta en tu equipo, tus archivos no salen de él y tú decides qué puede hacer la inteligencia artificial.' },
      { id: 'entorno', texto: 'Primero comprueba tu equipo de verdad: el sistema, la memoria, la tarjeta gráfica, el espacio en disco y Ollama, el motor que ejecuta los modelos. Si Ollama no está instalado, se instala con un botón.' },
      { id: 'modelo', texto: 'Después recomienda un modelo según tu equipo. Aquí, Gemma 4 ya está descargado. Con Probar, el modelo responde en tu propio ordenador y se mide su velocidad.' },
      { id: 'herramientas', texto: 'Esta segunda prueba comprueba que el modelo sabe usar herramientas reales. Una vez descargado, el modelo es tuyo: puedes usarlo sin límite de mensajes.' },
      { id: 'proyecto', texto: 'En el último paso se crea un proyecto de ejemplo para la parte de programación, que veremos al final. Pero empecemos por lo que sirve a toda la empresa: el modo Chat.' },
    ],
  },
  {
    id: 'chat',
    titulo: '2 · Modo Chat: el asistente de toda la empresa',
    beats: [
      { id: 'cambiar', texto: 'Arriba de la barra lateral cambias entre Chat y Código, como en la aplicación de Claude. El modo Chat es para cualquier persona de la oficina: administración, compras, ventas o logística. No hace falta saber programar.' },
      { id: 'ilimitado1', texto: 'Y aquí está lo importante: puedes escribir todos los mensajes que quieras. No hay límite diario, ni cuotas, ni coste por pregunta, porque el modelo funciona en tu propio ordenador.' },
      { id: 'base', texto: 'Para que responda sobre tu empresa, creas una base de conocimiento y eliges una carpeta con tus documentos: procedimientos, tarifas, listados de clientes o calendarios. ZHASKA los lee en tu equipo y crea un índice. Los archivos nunca se modifican ni se envían a ningún sitio.' },
      { id: 'pregunta', texto: 'Ahora preguntamos algo que está en un Excel de clientes. La respuesta cita el documento del que sale el dato, y puedes desplegar el fragmento o abrir el original para comprobarlo.' },
      { id: 'pregunta2', texto: 'Otra pregunta, esta vez sobre un PDF del calendario laboral. Pregunta lo que quieras, las veces que quieras: los mensajes son ilimitados.' },
      { id: 'noaparece', texto: 'Si la respuesta no está en tus documentos, lo dice claramente, en lugar de inventarse un dato. En las pruebas, ZHASKA no inventó ni un solo dato.' },
      { id: 'factura', texto: 'También puedes adjuntar un documento directamente: un PDF, un Word, un Excel o una imagen. Le pasamos una factura y le pedimos un resumen con el total y el vencimiento.' },
      { id: 'factura2', texto: 'Resúmenes de facturas, albaranes o contratos, uno detrás de otro, sin límite de mensajes y sin que el documento salga de tu ordenador.' },
      { id: 'correo', texto: 'Las plantillas te ayudan con las tareas de cada día. Por ejemplo, redactar un correo a un cliente con los datos de tus propios documentos.' },
      { id: 'correo2', texto: 'El correo queda listo para copiarlo y enviarlo tú. ZHASKA nunca envía nada por su cuenta.' },
      { id: 'traducir', texto: 'Y si te llega un documento en francés, en alemán, en polaco o en inglés, te lo traduce y te señala los importes y las fechas.' },
      { id: 'privada', texto: 'Para temas delicados, las conversaciones privadas no se guardan en el disco y desaparecen al cerrar ZHASKA. Y una base marcada como confidencial solo se puede usar en conversaciones privadas.' },
      { id: 'ilimitado2', texto: 'Recuerda: mensajes ilimitados para todo el equipo. Sin suscripciones por usuario, sin cuotas mensuales y sin que tus datos salgan de la empresa. La única diferencia la marca la potencia del ordenador: cuanto mejor sea, más rápido responde.' },
    ],
  },
  {
    id: 'codigo',
    titulo: '3 · Modo Código, para desarrolladores',
    beats: [
      { id: 'interfaz', texto: 'El modo Código está pensado para desarrolladores. Tiene un chat con un agente de programación, el panel de actividad y, a la derecha, el editor con la terminal.' },
      { id: 'enviar', texto: 'Le pedimos que cree una página web. El agente explora el proyecto, planifica y propone los cambios, y en el panel de actividad ves cada paso real. Mientras trabaja, aceleramos el vídeo.' },
      { id: 'permiso', texto: 'Antes de crear o modificar archivos, te pide permiso: una vez, siempre en este proyecto, o lo deniegas.' },
      { id: 'revisar', texto: 'Los cambios quedan como una propuesta que puedes revisar, aceptar o rechazar. Si rechazas, el archivo vuelve exactamente a como estaba. También aquí, los mensajes son ilimitados.' },
      { id: 'editor', texto: 'El editor es el mismo que usa Visual Studio Code, y abajo hay una terminal real en la carpeta del proyecto.' },
    ],
  },
  {
    id: 'ajustes',
    titulo: '4 · Configuración',
    beats: [
      { id: 'general', texto: 'Veamos todos los ajustes. En General eliges el idioma, la carpeta donde se crean los proyectos y si se abre el último proyecto al iniciar.' },
      { id: 'apariencia', texto: 'En Apariencia, el tema, la densidad de la interfaz, más amplia o más compacta, y la opción de reducir las animaciones.' },
      { id: 'editor', texto: 'En Editor, el tamaño de la letra, la tabulación, el ajuste de línea y el minimapa. Y para la terminal, el tamaño de letra y qué terminal usar: PowerShell, cmd o Git Bash.' },
      { id: 'atajos', texto: 'Atajos de teclado reúne todas las combinaciones: por ejemplo, Control K para buscar, o Control Mayúsculas M para cambiar entre Chat y Código.' },
      { id: 'modelos', texto: 'En Modelos eliges el modelo activo y el modelo de visión para las imágenes. El banco de pruebas mide en tu equipo la velocidad real. Sea cual sea el modelo, los mensajes siguen siendo ilimitados.' },
      { id: 'ollama', texto: 'En Ollama ves el estado del servidor local, los modelos cargados en memoria y cuánto ocupan de la tarjeta gráfica. Puedes liberar memoria, iniciarlo o detenerlo, y consultar sus registros.' },
      { id: 'agente', texto: 'Agente y permisos decide qué puede hacer la inteligencia artificial en los proyectos: preguntar siempre, equilibrado o autónomo, y para cada acción, si se permite, si pregunta o si se bloquea. Los comandos peligrosos y los borrados siempre piden confirmación.' },
      { id: 'agente2', texto: 'Más abajo están los archivos protegidos, como las claves, que nunca se leen sin preguntar; las carpetas autorizadas fuera del proyecto, solo de lectura; y los permisos concedidos, que puedes revocar.' },
      { id: 'contexto', texto: 'En Contexto e indexado decides cuánto texto considera el modelo a la vez, el máximo de pasos por tarea, la temperatura, el razonamiento y la verificación automática del código.' },
      { id: 'privacidad', texto: 'En Privacidad y datos ves qué sale de tu equipo: por defecto, nada, salvo buscar actualizaciones si lo activas. Aquí están las copias de seguridad diarias, que puedes restaurar, y la opción de exportar e importar todos tus datos.' },
      { id: 'acerca', texto: 'Y en Acerca de ZHASKA, la versión y el rendimiento medido en tu equipo: el tiempo de arranque y la memoria de cada proceso.' },
    ],
  },
  {
    id: 'cierre',
    titulo: 'ZHASKA',
    beats: [
      {
        id: 'final',
        texto:
          'ZHASKA: un asistente de inteligencia artificial para toda la empresa, en tu propio ordenador. Tus documentos no salen de la empresa, y los mensajes son ilimitados: pregunta todo lo que necesites, cada día, sin pagar por uso. Gracias por ver este recorrido.',
      },
    ],
  },
]
