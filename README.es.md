<img src="app-icon.png" width="96" alt="">

# Hypatia's Hoard

Aplicación de estudio local con repaso espaciado, un cuaderno sobre tus propias fuentes, matemáticas exactas y un rol de profesor, controlable por un asistente mediante MCP. Es la segunda versión de Exam Coach. [English](README.md)

## Qué es

Hypatia's Hoard toma todo Exam Coach, una PWA para estudiantes, y lo ejecuta en tu propio PC con un servidor local en Python (`hypatia/`) en `http://127.0.0.1:5187`. El servidor guarda tus datos de estudio en SQLite y los sincroniza con el IndexedDB de la app. Sobre la app original añade control por asistente vía MCP, un rol de profesor (Profesor), un cuaderno sobre tus fuentes y un motor de matemáticas exactas.

Todas las funciones de IA usan modelos locales a través de Hoard Link (incluido en `hypatia/hoard_link/`). Sin modelo en marcha, cada función de IA lo dice en vez de inventar resultados. El pódcast habla con Prospero's Hoard, los embeddings del cuaderno vienen de Borges's Hoard y los PDF escaneados los lee Kafka's Hoard, todo a través del hub de la familia.

En el repositorio no hay contenido de cursos. Las asignaturas llegan como paquetes protegidos con contraseña (`.examcoach.enc`) desde el marketplace o desde un archivo; sus preguntas, PDF y tu progreso se quedan en `data/` y `resources/` de tu PC, ambos ignorados por git.

## Qué hace

### Estudio (todo lo que hacía Exam Coach)
- Asignaturas, temas y cuatro tipos de pregunta (test, desarrollo, completar, práctico) con Markdown y LaTeX.
- Sesiones de práctica: aleatoria, falladas, por tema, repaso espaciado inteligente y examen cronometrado; tarjetas.
- Repaso espaciado con SM-2 o FSRS-5 (retención deseada del 70 al 97 %); las tarjetas conservan su historial SM-2 y el asistente califica con el mismo planificador.
- Estadísticas, temas débiles, conceptos clave, actividades y entregas.
- Lecciones desde un documento: un texto pegado o un archivo (PDF, DOCX, EPUB...) se divide en secciones, se extraen los conceptos clave y se guarda una pregunta por concepto, con flujo de lectura y dominio por concepto.
- Tarjetas de página: lecciones HTML saneadas que se califican como cualquier tarjeta.
- Calendario de estudio: vista previa y descarga de una instantánea ICS de entregas y exámenes.

### Repaso oral
- Las tarjetas pendientes se preguntan en voz alta y se responden hablando; la respuesta se transcribe y se compara por significado con la esperada, de modo que paráfrasis y sinónimos cuentan.
- La corrección se dice en voz alta, la nota se registra en el calendario de repaso y sigue la siguiente tarjeta sola. Funciona sin ratón con teclado y órdenes de voz (repetir, siguiente, parar, «no lo sé»).
- Sin modelo de lenguaje, las tarjetas de test y completar se califican por reglas y las abiertas te piden la nota.

### Ensayo de objeciones
- Una presentación de Cicero's Hoard se convierte en una asignatura con un tema por diapositiva y una pregunta difícil por objeción, cada una con la respuesta que la diapositiva debe sostener y la evidencia literal de sus fuentes. Las objeciones se pueden escribir a mano o dejar que el modelo de lenguaje las redacte a partir de las diapositivas y sus fuentes.
- El texto y las notas de cada diapositiva se comprueban contra sus objeciones; las que no aguantan vuelven a Cicero como defectos y, al comprobar de nuevo tras corregirlas, se cierran allí. Si cambia una fuente que cita una diapositiva (una revisión nueva del informe o de sus datos), la siguiente comprobación reescribe las objeciones de esa diapositiva contra las fuentes tal como están y dice cuáles reescribió. Si en ese momento no responde el modelo, solo revisa sus citas y la objeción queda pendiente: no se juzga contra la respuesta antigua, su defecto sigue en Cicero como estaba y la siguiente comprobación la reescribe aunque la fuente no vuelva a cambiar. Deshacer la comprobación las devuelve como estaban. Las mismas preguntas se pueden ensayar en voz alta con el repaso oral.

### Plan de estudio
- Un plan día a día hasta el examen: repasos programados, tarjetas nuevas repartidas por temas, un simulacro cronometrado semanal y otro antes del examen, ponderados hacia los temas débiles, y un repaso final. Fija la fecha del examen, los minutos diarios, los días de descanso y el tamaño del simulacro; los días sobrecargados se marcan. No interviene ningún modelo.

### Cuaderno sobre tus fuentes
- Respuestas citadas desde tus PDF, guías de estudio, informes, preguntas frecuentes, glosarios, líneas de tiempo, un mapa mental, un resumen de audio a dos voces y un tutor socrático. Una FAQ terminada se puede pasar al banco de práctica.

### Rol de profesor (Profesor)
- Se activa en la cabecera o en Ajustes; el modo estudiante sigue igual.
- Clases y alumnos (alias, correo opcional, nada más), con listas pegadas o CSV.
- Generación de exámenes desde tu banco y tu propio material, con citas: preguntas por tipo, puntos, mezcla de dificultad, versiones A-D, cabecera y exportación a PDF; los borradores se revisan antes de usarlos.
- Rúbricas por pregunta o por examen, propuestas por el modelo local y siempre editables; escala de nota de 0 a 10.
- Entregas por examen y clase: respuestas objetivas en una cuadrícula o CSV, abiertas por texto, PDF o grabación; corrección por lotes con propuestas del modelo que confirmas tú.
- Análisis de clase: acierto por pregunta y tema, opciones erróneas más comunes, criterios débiles, distribución de notas y un examen de «reforzar» construido con los temas débiles.
- Los datos de los alumnos se quedan en tu PC. Sin modelo, la generación y la corrección terminan en un estado explícito `no_model`.

### Matemáticas exactas
- Calculadora en la página de inicio y herramientas `math_*`: aritmética exacta, ecuaciones polinómicas hasta grado 4, derivación, integración (primitivas y definidas), límites, desarrollo y factorización de polinomios, tablas de valores y estadística descriptiva exacta.
- Sistemas lineales de hasta 12 ecuaciones y 8 incógnitas con clasificación (único, infinito, incompatible), soluciones exactas, rangos y verificación; productos, potencias, transpuesta y núcleo de matrices.
- Teoría de números: congruencias lineales y sistemas de congruencias, MCD/MCM/Bézout, conversión de enteros entre bases, fracciones continuas finitas.
- División y MCD de polinomios, fracciones parciales, series de Taylor racionales, interpolación exacta.
- Los resultados traen forma exacta, aproximada y LaTeX. Nada lee ni cambia datos de estudio.

## Cómo ejecutarlo

Python 3.11+ con FTS5 en SQLite (las compilaciones oficiales lo traen); Node 22 solo para compilar la app.

```bat
python -m venv venv
venv\Scripts\pip install -r requirements.txt
npm install
npm run build
venv\Scripts\python -m hypatia
```

Abre http://127.0.0.1:5187. El servidor escucha solo en 127.0.0.1; un guardián de peticiones rechaza hosts ajenos y peticiones entre sitios. Si lo arrancas por segunda vez, avisa de que ya está en marcha.

Asignaturas:
- Desde la app: Marketplace, instalar, escribir la contraseña del paquete.
- Desde un archivo: `python -m hypatia import-package "<archivo>.examcoach.enc" --password "..."` (o `--passwords-file` con un JSON `{"<id del paquete>": "<contraseña>"}`, o `HYPATIA_PACKAGE_PASSWORD`). Un `.examcoach.zip` sin cifrar no necesita contraseña.
- Desde otra instalación de Exam Coach: Ajustes → Sincronización y traer, o `python -m hypatia import-backup examcoach-backup.json`.
- Desde el primer Hypatia (tarjetas): `python -m hypatia migrate-hypatia "data\legacy-v1\hypatia-hoard.db"`; cada mazo se convierte en una asignatura.

| Variable | Por defecto | Significado |
|---|---|---|
| `HYPATIA_DATA_DIR` | `data/` | Base de datos, token, `backend.json`, subidas, salida del estudio, registros |
| `HYPATIA_RESOURCES_DIR` | `resources/` | PDF por asignatura, servidos en `/resources/` e indexados por el cuaderno |
| `HYPATIA_PORT` / `PORT`, `PORT_STRICT=1` | `5187` | Puerto; estricto falla en vez de moverse |
| `HYPATIA_ALLOWED_HOSTS` | | Nombres de host extra (un túnel al móvil) |
| `HYPATIA_LLM_TIMEOUT_S` | `900` | Máximo que puede tardar una llamada al modelo |
| `HYPATIA_LLM_THINKING` / `HYPATIA_LLM_EFFORT` | `0` / sin definir | Nivel de razonamiento de las llamadas al modelo |
| `SCRIBE_URL`, `SCRIBE_TOKEN` | Endpoint de audio de Funes | Preguntas a partir de clases grabadas |
| Hoard Link (`data/backend.json`, `HOARD_*`) | | Resolución de modelos y voces del pódcast |

La app y el servidor se mantienen sincronizados: el servidor guarda cada tabla de la app como registros JSON con una revisión global y marcas de borrado, y en cada ciclo envía los cambios de la app y trae los del servidor.

El menú de donaciones lee `VITE_DONATION_PAYPAL_URL` y `VITE_DONATION_COFFEE_URL` del entorno de compilación. Pon las URL públicas en `.env.local` o en los ajustes de compilación del despliegue y vuelve a compilar. Al recompilar una instalación local existente, si una variable está sin definir se conserva el enlace de la compilación anterior. Un valor vacío desactiva ese enlace. Cada proveedor sigue visible.

## Conexión con Faustus y el Hoard Hub

Declara su relevo de práctica oral, con el requisito de registrar la objeción como pregunta con respuesta de referencia en una asignatura, y el ensayo de objeciones que recibe una presentación editable y devuelve a Cicero los defectos de diapositiva.

- `faustus-plugin.json` es el manifiesto (`id: hypatia`, `HYPATIA_DIR` = esta carpeta). El puente MCP (`python mcp_server.py`) reenvía cada llamada a `POST /api/agent/call` con el token de `data/mcp-token`, arranca el servidor si nadie responde y nunca abre la base de datos.
- Herramientas por grupos:
  - Estudio: asignaturas, temas, preguntas (buscar, leer, añadir, actualizar, borrar, sugerir), `cards_due`, `card_review`, `answer_grade`, `weak_topics`, `exam_mock`, `study_stats`, conceptos clave, lecciones (`lesson_from_document`, `lesson_get`, `concept_mastery`), páginas, entregas, `study_plan`, `study_calendar_export`, `record_get`, `record_patch`.
  - Repaso oral: `oral_card_next`, `oral_card_answer`, `oral_speak`.
  - Ensayo de objeciones: `rehearsal_prepare`, `rehearsal_check`, `rehearsal_get`, `rehearsal_undo`.
  - Cuaderno: `notebook_sources`, `source_add`, `notebook_search`, `notebook_ask`, `studio_generate`, `studio_get`, `studio_to_questions`, `studio_list`, `tutor_turn`.
  - Profesor: clases, alumnos, `exam_generate` (tarea), revisión y exportación a PDF de exámenes, rúbricas, lotes de corrección y entregas, análisis de clase.
  - Matemáticas: `math_compute`, `math_values`, `math_linear_system`, `math_statistics`, `math_matrix`, `math_polynomial_division`, `math_polynomial_gcd`, `math_partial_fractions`, `math_rational_taylor`, `math_continued_fraction`, `math_linear_congruence`, `math_congruence_system`, `math_integer_pair` y otras.
  - Alias de tarjetas del primer Hypatia: `cards_add`, `decks_list` (Links Hoard envía aquí los subrayados, en el mazo «Lecturas»).
- El panel común de Faustus está en todas las vistas principales y recibe la vista actual, los ids reales de los objetos, la selección y los campos del editor sin guardar. Las conversaciones del cuaderno se pueden continuar en Faustus.
- Servicios de la familia a través del hub: Prospero's Hoard habla, Funes's Hoard transcribe (con `faster_whisper` como alternativa local), Borges's Hoard genera embeddings y Kafka's Hoard lee escaneos. `GET /api/family/agenda` sirve fechas y plazos de examen, y las tareas de profesor publican eventos en el bus de la familia.
- La app lleva skills de la biblioteca de la familia para los agentes conectados (`exam-study-plan`, `hoard-study-cards`, `notes-from-templates`), disponibles con las herramientas de skills y en la pestaña Skills del Hub.
- API de registros: [docs/API.md](docs/API.md).

## Estructura del proyecto

| Ruta | Contenido |
| --- | --- |
| `hypatia/` | Servidor Python: API, banco, planificación, calificación, cuaderno, profesor, matemáticas, sincronización |
| `src/` | App React/TypeScript (Vite) |
| `mcp_server.py` | Puente MCP por stdio |
| `faustus-plugin.json` | Manifiesto del plugin de Faustus |
| `resources/` | PDF por asignatura (ignorado por git) |
| `data/` | Base de datos y token (ignorado por git) |
| `tests/` | Pruebas |
| `docs/` | Referencia de la API |

## Desarrollo

```bat
venv\Scripts\pip install pytest reportlab
venv\Scripts\python -m pytest -q tests
npx tsc --noEmit
```

Las pruebas nunca tocan la red ni una app hermana. Licencia: MIT, Luis María Salete Cuartero.
