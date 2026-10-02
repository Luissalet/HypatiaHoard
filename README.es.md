# Hypatia's Hoard — Exam Coach 2, con Faustus

[English](README.md)

Hypatia's Hoard es la segunda versión de [Exam Coach](https://github.com/Mlgpigeon/ExamCoach), pensada para correr en tu PC y para que la maneje un asistente. Exam Coach se queda como estaba: una PWA pública que usaron alumnos. Hypatia lo incluye entero y añade:

- **Un servidor local** (Python, `hypatia/`) que sirve la app en `http://127.0.0.1:5187`, guarda tus datos de estudio en SQLite y los sincroniza con el IndexedDB de la app.
- **Control por asistente**: 48 herramientas MCP para que Faustus (o cualquier cliente MCP) te examine con repaso espaciado, monte simulacros sobre tus temas flojos, corrija respuestas abiertas, haga cálculos exactos, añada o proponga preguntas a partir de tu propio material y lleve el rol de profesor.
- **Rol Profesor**: clases, exámenes generados desde tu banco y tu propio material con citas, versiones A/B, rúbricas, corrección en lote con propuestas del modelo que tú confirmas, notas y análisis de la clase. Los datos de alumnos se quedan en tu PC.
- **Un cuaderno sobre tus fuentes**: respuestas con citas de tus PDFs, guía de estudio, resumen ejecutivo, FAQ, glosario, cronología, mapa mental, resumen en audio a dos voces y tutor socrático.
- **Solo modelos locales**, a través de Hoard Link (copiado en `hypatia/hoard_link/`), el mismo backend compartido que usa el resto de la familia Hoard. El podcast habla con la voz de Prospero's Hoard. Sin ningún modelo en marcha, cada función de IA devuelve igualmente el material para que el asistente haga el trabajo, y la app desactiva los botones que necesitan un modelo.

En este repositorio no hay contenido de ninguna asignatura. Las asignaturas llegan como **paquetes con contraseña** (`.examcoach.enc`) desde el marketplace o desde un fichero; sus preguntas, sus PDFs y tu progreso se quedan en `data/` y `resources/` en tu PC, ambas ignoradas por git.

## Todo lo que hacía Exam Coach

Asignaturas, temas y cuatro tipos de pregunta (test, desarrollo, completar, práctico) con Markdown y LaTeX; sesiones de práctica (aleatoria, falladas, por tema, inteligente SM-2, examen cronometrado); repaso espaciado con SM-2 o FSRS-5 (Ajustes → Repaso espaciado, con una retención deseada del 70 al 97 %; las preguntas conservan su historial SM-2 y el asistente califica con el mismo planificador); flashcards; modo lectura; modo escucha (PDF a voz con Piper en el navegador); visor y herramientas PDF; conceptos clave; exámenes a medida; extracción de preguntas con IA; evaluación continua y entregables; marketplace de asignaturas con paquetes cifrados; packs de contribución; sincronización por Gist; importar/exportar Anki; estadísticas. El mapa completo está en [FEATURES.md](FEATURES.md).

Lo que cambia: la app la sirve el servidor local (base `/`), la extracción con IA puede usar tu modelo local (proveedor «Hypatia») y aparece una página **Cuaderno** en cada asignatura.

## Arrancar (Windows)

```bat
python -m venv venv
venv\Scripts\pip install -r requirements.txt
npm install
npm run build
venv\Scripts\python -m hypatia
```

Abre http://127.0.0.1:5187. Hace falta Python 3.11+ con FTS5 en SQLite (las versiones oficiales lo traen) y Node 22 solo para compilar la app. El servidor solo escucha en 127.0.0.1 y rechaza hosts ajenos y peticiones de otros sitios.

## Asignaturas (paquetes con contraseña)

- Desde la app: **Marketplace**, instalar y escribir la contraseña del paquete. La app la guarda, la siguiente sincronización manda la asignatura al servidor y al abrir el Cuaderno se suben sus PDFs.
- Desde un fichero, directo al servidor (también copia los PDFs del paquete a `resources/<asignatura>/` para el cuaderno):

```bat
venv\Scripts\python -m hypatia import-package "C:\ruta\vision-artificial.examcoach.enc" --password "..."
venv\Scripts\python -m hypatia import-package "C:\ruta\vision-artificial.examcoach.enc" --passwords-file "C:\ruta\passwords.json"
```

`--passwords-file` es un JSON `{"<id del paquete>": "<contraseña>"}`; también vale `HYPATIA_PACKAGE_PASSWORD`. Un `.examcoach.zip` sin cifrar no necesita contraseña.

- Desde otra instalación de Exam Coach: en la app, **Ajustes → Sincronización (Gist)** y descargar; o `python -m hypatia import-backup examcoach-backup.json`.

## Faustus

`faustus-plugin.json` es el manifiesto (`id: hypatia`, `HYPATIA_DIR` = esta carpeta). El puente MCP (`python mcp_server.py`) nunca abre la base de datos: reenvía cada llamada a `POST /api/agent/call` con el token de `data/mcp-token` y arranca el servidor si no responde nadie.

Herramientas de estudio: `subjects_list`, `topics_list`, `questions_search`, `question_get`, `questions_add`, `question_update`, `question_delete`, `cards_due`, `card_review`, `answer_grade`, `weak_topics`, `exam_mock`, `study_stats`, `key_concepts`, `key_concept_add`, `questions_suggest`, `questions_suggest_accept`, `deliverables_upcoming`.
Matemáticas exactas: `math_compute` evalúa operaciones, resuelve ecuaciones polinómicas de grado hasta 4 y deriva fórmulas localmente. Las potencias se escriben con `**`. Devuelve resultado exacto, aproximado (si es numérico) y LaTeX sin leer ni cambiar datos de estudio.
Profesor: ver [Rol Profesor](#rol-profesor).
Cuaderno: `notebook_sources`, `source_add`, `notebook_search`, `notebook_ask`, `studio_generate`, `studio_get`, `studio_to_questions`, `studio_list`, `tutor_turn`. `studio_to_questions` pasa una FAQ terminada al banco de práctica y omite duplicados si se repite.
Alias heredados de Hypatia 1 (tarjetas): `cards_add`, `decks_list`. `cards_add` recibe `{deck, cards: [{front, back, tags, source, source_ref}]}`; `source_ref` (por ejemplo `hoard://links/highlight/<id>`, que envía Links Hoard por un subrayado) se guarda con la tarjeta como `sourceRef`, no forma parte del hash de contenido (la misma tarjeta de otro sitio sigue siendo la misma; un duplicado que no tenía referencia la toma), viaja por la sincronización y se ve como una etiqueta *Origen* en el editor de preguntas.

### En la familia

- **Agenda.** `GET /api/family/agenda` (con el token de esta aplicación; `?from=&to=&sphere=`) responde al contrato de la agenda de la familia: la fecha de examen de cada asignatura (`exam`, prioridad alta en la última semana), la fecha de la cabecera de un examen de profesor cuando es una fecha de verdad (`exam`), las entregas pendientes con su día y hora (`deadline`, o `exam` si son pruebas) y, para hoy, un elemento `cards` de todo el día «N tarjetas para repasar hoy» cuando hay tarjetas que tocan. Solo salen nombres de asignaturas, títulos de examen y recuentos, nunca el nombre ni las respuestas de un alumno. El manifiesto dice `"x-family": {"agenda": true}`.
- **Eventos de trabajo.** Los trabajos de profesor (`exam_generate`, `grading_run`) publican en el bus los eventos de trabajo canónicos: `hypatia.job.queued`, `started`, `progress` (como mucho cada 3 segundos, con `eta_s` en cuanto hay avance), `done`, `failed` (`no_model`, `no_sources` y errores, con el motivo en `error`) y `cancelled`, cada uno con `{job_id, title, kind: "teacher", progress 0..1, gpu: false, eta_s, url, error}` (la url abre el examen o la tanda). Sustituyen a `hypatia.teacher_job.*`, que el hub traduce a estos, así que los nombres antiguos ya no se envían.

## Rol Profesor

Un interruptor en la cabecera (y en **Ajustes → Rol**) activa las pantallas de profesor. El modo Estudiante sigue igual: un profesor puede seguir practicando.

- **Clases**: grupos (nombre, curso, año, asignaturas) y alumnos (nombre visible o alias, email opcional solo como referencia tuya, nada más). Pega una lista o un CSV (`Nombre;Apellidos;Correo`, o `Apellidos, Nombre` por línea).
- **Generar examen**: asignatura, temas, número de preguntas por tipo (TEST, DESARROLLO, COMPLETAR, PRACTICO), puntos por tipo, mezcla de dificultad, duración, versiones A–D (orden de preguntas y opciones barajado, mismo contenido), cabecera (centro, curso, fecha, instrucciones) y penalización del test. Origen: el banco, el modelo local redactando desde las fuentes indexadas de la asignatura, o el banco primero y el modelo para lo que falte. Cada pregunta generada cita el pasaje del que sale (archivo, página o apartado) y es un **borrador** hasta que la apruebas al banco. Imprime un PDF con cada versión, el solucionario por versión y las rúbricas; el examen se guarda también como examen practicable de la asignatura.
- **Rúbricas**: por pregunta o por examen, criterios con peso y niveles (descriptor + puntos). «Proponer rúbrica» se lo pide al modelo local (sin modelo: una plantilla fija); siempre editable. Escala 0–10 con una decimal y las bandas habituales (Suspenso < 5, Aprobado 5–6,9, Notable 7–8,9, Sobresaliente ≥ 9), configurable.
- **Entregas**: un lote por examen y clase. Las respuestas objetivas, en una rejilla (alumnos × número de pregunta impreso en su versión) o pegando un CSV (`alumno;version;1;2;…`), puntuadas con la misma lógica de la app. Las abiertas, por texto, PDF (su texto) o foto (solo con modelo de visión; si no, se escribe). «Corregir con IA» corre en segundo plano en el servidor y solo **propone**: nivel por criterio, puntos, justificación, citas literales comprobadas contra la respuesta (las que no aparecen se descartan) y confianza. Revisión lado a lado (respuesta | rúbrica | propuesta), aceptar o cambiar, y confirmar: solo entonces se guardan la nota, la banda y el feedback (aciertos, errores, temas y conceptos clave que repasar). CSV de notas de la clase y PDF de feedback.
- **Análisis**: acierto por pregunta y tema, opciones erróneas, huecos y criterios flojos más comunes, distribución de notas; «Reforzar» crea un examen de práctica (sesiones, tarjetas, SM-2) con los temas flojos, para la clase o para un alumno.

Sin el servidor local (build público) funciona todo salvo lo que necesita modelo, que lo dice. Sin modelo, la generación y la corrección terminan en un estado `no_model` explícito y no se inventa nada.

**Dónde viven los datos.** En IndexedDB (Dexie versión 9: `teacherClasses`, `teacherStudents`, `teacherExams`, `rubrics`, `gradingBatches`, `submissions`, `gradingProposals`, `teacherSettings`) y en tablas propias del servidor (`teacher_records`, `teacher_jobs`), sincronizadas con `/api/teacher/sync/*` (gana la última escritura por registro). **No** pasan por la sincronización de estudio, porque esa sube la misma copia completa que usa el Gist; tener un canal aparte es lo que mantiene nombres, respuestas y notas de alumnos fuera del Gist, el banco global, los contribution packs, los paquetes y cualquier otra exportación. Toda función de exportación pasa por `src/data/studentPrivacy.ts#guardPublicExport`, que quita las tablas de profesor y rechaza cualquier campo de alumno; hay tests sobre exportaciones reales. Las prácticas de «Reforzar» nunca llevan el nombre de un alumno.

Herramientas de profesor (Faustus): `teacher_classes`, `teacher_class_create`, `teacher_students_add`, `exam_generate` (trabajo), `exam_get`, `exam_drafts_review`, `exam_export_pdf`, `rubric_propose`, `rubric_set`, `grading_batch_create`, `grading_submit_answers`, `grading_run` (trabajo), `grading_review`, `grading_confirm`, `grades_report`, `class_analysis`, `class_reinforce`, `teacher_job`. Responden a cosas como «hazme un examen de 10 preguntas del tema 3 con dos versiones», «corrige las entregas del examen X con la rúbrica» o «¿qué tema ha ido peor en 2ºB?» (`class_analysis` → `worstTopic`). El PDF del servidor (`exam_export_pdf`) imprime las fórmulas como LaTeX; el «Imprimir PDF» de la app las dibuja.

## Cómo se sincronizan la app y el servidor

El servidor guarda cada tabla de la app como registros JSON con una revisión global y marcas de borrado. En cada ciclo la app sube su copia completa y los borrados pendientes, baja lo que cambió desde su última revisión, lo fusiona con el mismo código que usa el sync de Gist y aplica los borrados del servidor. `hypatia/merge.py` es un port de `mergeBackup` (asignaturas por nombre, temas por asignatura y título, preguntas por hash de contenido, se conservan notas, destacadas y fechas de examen locales, y se combinan las estadísticas SM-2); un test ejecuta el TypeScript con node para demostrar que `hypatia/hashing.py` da los mismos hashes.

## Configuración

| Variable | Por defecto | Qué es |
|---|---|---|
| `HYPATIA_DATA_DIR` | `data/` | Base de datos, token, `backend.json`, subidas, salidas del estudio, logs |
| `HYPATIA_RESOURCES_DIR` | `resources/` | PDFs por asignatura (`resources/<slug>/Temas/…`: los de `import-package` y cada PDF que adjuntas a un tema en la app), servidos en `/resources/` e indexados por el cuaderno |
| `HYPATIA_PORT` / `PORT`, `PORT_STRICT=1` | `5187` | Puerto; en modo estricto falla en vez de moverse |
| `HYPATIA_ALLOWED_HOSTS` | | Hosts extra (un túnel al móvil) |
| `HYPATIA_LLM_TIMEOUT_S` | `900` | Lo máximo que puede tardar una llamada al modelo |
| `HYPATIA_LLM_THINKING` | `0` | `1` deja pensar a `high` cada llamada que no pida su propio nivel (más lento) |
| `HYPATIA_LLM_EFFORT` | sin fijar | `off`/`low`/`medium`/`high`/`max` impone un nivel de razonamiento a todas las llamadas. Sin fijar, cada tarea elige el suyo: corregir y responder en el cuaderno `medium`, redactar preguntas `high`, guías de estudio y briefings `max`, tomar notas en bloque `off` |
| `HYPATIA_PROSPERO_URL` | `Prospero's Hoard/data/url` hermano, si no `http://127.0.0.1:8815` | Estudio de voz para el podcast |
| `SCRIBE_URL`, `SCRIBE_TOKEN` | Audio de Funes en `http://127.0.0.1:8813/audio`; sobrescrituras opcionales de URL/token | Preguntas a partir de clases grabadas |
| Hoard Link (`data/backend.json`, `HOARD_*`) | | Resolución de modelos; `backend.json` admite también `{"podcast": {"engine": "piper", "voices": ["es_ES-davefx-medium", "es_ES-sharvard-medium"]}}` |

## Desde Hypatia 1 (tarjetas)

```bat
venv\Scripts\python -m hypatia migrate-hypatia "data\legacy-v1\hypatia-hoard.db"
```

Cada mazo antiguo pasa a ser una asignatura y cada tarjeta una pregunta de desarrollo en el tema «Tarjetas», con su estado SM-2. Se puede ejecutar dos veces sin duplicar.

## Tests

```bat
venv\Scripts\pip install pytest reportlab
venv\Scripts\python -m pytest -q tests
npx tsc --noEmit
```

Ningún test sale a la red ni toca otra app de la familia (`tests/test_family.py` cubre `source_ref`, los eventos de trabajo y la agenda). Algunos ejecutan el TypeScript con node (necesitan `npm install`): paridad de hashes y del núcleo de profesor, la migración Dexie 8→9 y el filtro de exportaciones (con `fake-indexeddb`).

## Licencia

MIT, Luis María Salete Cuartero.
