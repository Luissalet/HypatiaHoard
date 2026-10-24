# Hypatia's Hoard — Exam Coach 2, con Faustus

[English](README.md)

## Calculadora exacta

**Sistema de congruencias** combina condiciones `x ≡ r (mod m)` desde el inicio,
API `POST /api/math/congruence-system` y la nueva MCP `math_congruence_system`.
Recibe `constraints` con al menos un par de cadenas `residue`/`modulus` enteras
decimales con signo. Admite módulos no coprimos y normaliza los negativos; cero
es inválido. Para2mod6 y5mod9 devuelve la familia completa `x=14+k*18`, k cualquier
entero. Un sistema incompatible devuelve `no_solution`, la primera condición en
conflicto, clase previa, MCD y resto de compatibilidad distinto de cero. La
solución incluye condiciones normalizadas, residuo canónico no negativo,
período positivo igual al MCM y comprobaciones exactas; período1 significa todos
los enteros. Conserva cifras mayores que la precisión de JavaScript como cadenas
y los límites de conversión del runtime. El panel permite añadir/quitar filas,
copiar resultado/comprobación y corregir errores sin perder datos; editar o
cerrar descarta respuestas viejas. No enumera residuos, usa modelos, añade
dependencias ni cambia el banco. Combina residuos; la herramienta individual
conserva la resolución de `a*x=b` módulo m. Contraste matemático:
[congruencias generalizadas de SymPy](https://docs.sympy.org/latest/modules/ntheory.html#sympy.ntheory.modular.solve_congruence).
La implementación reutiliza el resolvedor lineal nativo; catálogo combinado68
=48Estudio+18Profesor.

**Congruencias lineales** resuelve `a*x ≡ b (mod m)` con la misma función nativa
en el panel del inicio, API `POST /api/math/linear-congruence` y MCP
`math_linear_congruence`. Introduce `a`, `b`, `modulus` como cadenas decimales
con signo; un módulo negativo se normaliza a su valor absoluto y cero da error.
Para35,14,28 devuelve toda la familia `x=2+k*4`, siete residuos distintos módulo28,
el MCD, su identidad de Bézout y el resto de compatibilidad. Si el MCD no divide
b, devuelve `no_solution`; período1 significa cualquier entero. Con b=1 obtiene
un inverso modular cuando existe. Conserva cifras mayores que la precisión de
JavaScript y los límites de conversión del runtime. Permite copiar solución y
comprobación y corregir entradas tras un error. No enumera listas enormes,
ni modifica el banco. Esa operación individual no combina condiciones; se usa
el panel de sistemas separado descrito arriba. Referencia matemática:
[MIT18.781, lección5](https://ocw.mit.edu/courses/18-781-theory-of-numbers-spring-2012/7b36e2ada32c5ed0638783d4e66af60c_MIT18_781S12_lec5.pdf).

**MCD, MCM y Bézout** calcula dos enteros decimales con signo y muestra sus
divisiones de Euclides sobre valores absolutos. Devuelve MCD/MCM no negativos,
coeficientes enteros `x`/`y` y comprueba `a*x+b*y=MCD`; los coeficientes no son
únicos. API `POST /api/math/integer-pair` y MCP `math_integer_pair` usan la misma
función; el catálogo combinado tiene69 herramientas. Entradas y resultados
enteros son cadenas y conservan cifras mayores que la precisión de JavaScript;
se mantienen los límites de conversión del runtime. Si algún entero es cero,
MCM es cero; para `(0,0)` se usan MCD/MCM y coeficientes cero por convención.
El panel conserva errores para corregirlos, copia resultado y divisiones y
comparte ambos textos de entrada con Faustus. No factoriza primos ni cambia el
banco. Contrato matemático: [xgcd de SageMath](https://doc.sagemath.org/html/en/reference/rings_standard/sage/arith/misc.html#sage.arith.misc.xgcd),
sin dependencia o código de SageMath.

En el inicio, **Calculadora exacta** abre una herramienta de cuentas, ecuaciones polinómicas, derivadas, integrales y límites. Carga ejemplos editables y muestra el resultado exacto, su fórmula y la aproximación cuando procede. Funciona localmente sin modelo ni GPU y no lee ni modifica el banco de estudio.

También ofrece **Desarrollar un polinomio** (`operation: "expand"`) y
**Factorizar un polinomio** (`operation: "factor"`), con coeficientes racionales
exactos en `x`, `y` o `t`, incluidos decimales y fracciones. Por ejemplo,
`(x+2)*(x-3)` da `x**2-x-6` y `x**3-x**2+x-1` da `(x-1)*(x**2+1)`.
La factorización es sobre los racionales: `x**2-2` permanece igual. Los
denominadores son constantes y las potencias de la variable, enteras no negativas.
Los denominadores y las funciones que dependen de la variable, y sus potencias
negativas, se rechazan antes de cancelarlos y obtener un aparente polinomio.
El resultado conserva expresión y variable y permite copiarlas junto
al resultado; editar el formulario limpia el resultado anterior. Usa las
[transformaciones polinómicas de SymPy](https://docs.sympy.org/latest/tutorials/intro-tutorial/simplification.html#polynomial-rational-function-simplification)
ya integrado, con el mismo motor API/MCP, sin modelo, dependencias nuevas ni
escrituras en el banco. Son transformaciones algebraicas, sin demostración paso
a paso ni búsqueda de soluciones de una ecuación.

La misma capacidad está en `math_compute` por MCP y en `POST /api/math/compute`. Para `operation: "integrate"`, omite ambos extremos para una primitiva con constante arbitraria C, o envía `lower` y `upper` como cadenas. Admite fracciones, constantes reales, `pi`, `E`, `oo` y `-oo`. Por ejemplo, `exp(-x)` entre `0` y `oo` devuelve exactamente `1`. Para `operation: "limit"`, envía `point`; `side` es `both`, `left` o `right`. Por defecto compara los dos laterales: `1/x` al llegar a `0` indica que el límite no existe y conserva ambos resultados.

Las respuestas distinguen resultados calculados, infinitos, integrales divergentes, límites inexistentes y expresiones sin resolver. Una oscilación no se presenta como número, ni se confunde una integral divergente con su valor principal de Cauchy. El cálculo simbólico se detiene tras 15 segundos si no termina, para que puedas simplificar la expresión y seguir usando la app. No es una demostración paso a paso ni un sistema algebraico completo. Usa el SymPy 1.14 ya incluido, siguiendo su [documentación de cálculo](https://docs.sympy.org/1.14.0/tutorials/intro-tutorial/calculus.html), sin dependencias nuevas de producto.

Hypatia's Hoard es la segunda versión de [Exam Coach](https://github.com/Mlgpigeon/ExamCoach), pensada para correr en tu PC y para que la maneje un asistente. Exam Coach se queda como estaba: una PWA pública que usaron alumnos. Hypatia lo incluye entero y añade:

- **Un servidor local** (Python, `hypatia/`) que sirve la app en `http://127.0.0.1:5187`, guarda tus datos de estudio en SQLite y los sincroniza con el IndexedDB de la app.
- **Control por asistente**: 57 herramientas MCP para que Faustus (o cualquier cliente MCP) te examine con repaso espaciado, monte simulacros sobre tus temas flojos, corrija respuestas abiertas, haga cálculos exactos, añada o proponga preguntas a partir de tu propio material y lleve el rol de profesor.
- **Rol Profesor**: clases, exámenes generados desde tu banco y tu propio material con citas, versiones A/B, rúbricas, corrección en lote con propuestas del modelo que tú confirmas, notas y análisis de la clase. Los datos de alumnos se quedan en tu PC.
- **Un cuaderno sobre tus fuentes**: respuestas con citas de tus PDFs, guía de estudio, resumen ejecutivo, FAQ, glosario, cronología, mapa mental, resumen en audio a dos voces y tutor socrático.
- **Solo modelos locales**, a través de Hoard Link (copiado en `hypatia/hoard_link/`), el mismo backend compartido que usa el resto de la familia Hoard. El podcast habla con la voz de Prospero's Hoard, los embeddings del cuaderno vienen de Borges's Hoard y los PDFs escaneados los lee Kafka's Hoard, todo a través del hub de la familia (ver *En la familia*). Sin ningún modelo en marcha, cada función de IA devuelve igualmente el material para que el asistente haga el trabajo, y la app desactiva los botones que necesitan un modelo.

En este repositorio no hay contenido de ninguna asignatura. Las asignaturas llegan como **paquetes con contraseña** (`.examcoach.enc`) desde el marketplace o desde un fichero; sus preguntas, sus PDFs y tu progreso se quedan en `data/` y `resources/` en tu PC, ambas ignoradas por git.

## Todo lo que hacía Exam Coach

Asignaturas, temas y cuatro tipos de pregunta (test, desarrollo, completar, práctico) con Markdown y LaTeX; sesiones de práctica (aleatoria, falladas, por tema, inteligente SM-2, examen cronometrado); repaso espaciado con SM-2 o FSRS-5 (Ajustes → Repaso espaciado, con una retención deseada del 70 al 97 %; las preguntas conservan su historial SM-2 y el asistente califica con el mismo planificador); flashcards; tarjetas de página (una lección HTML, limpiada, que entra en el mismo calendario SM-2/FSRS y se repasa entera; se crean pegando HTML, importando un .html, desde una guía del cuaderno o con el asistente); modo lectura; modo escucha (PDF a voz con Piper en el navegador); visor y herramientas PDF; conceptos clave; exámenes a medida; extracción de preguntas con IA; evaluación continua y entregables; marketplace de asignaturas con paquetes cifrados; packs de contribución; sincronización por Gist; importar/exportar Anki; estadísticas. El mapa completo está en [FEATURES.md](FEATURES.md).

Lo que cambia: la app la sirve el servidor local (base `/`), la extracción con IA puede usar tu modelo local (proveedor «Hypatia») y aparece una página **Cuaderno** en cada asignatura.

## Arrancar (Windows)

```bat
python -m venv venv
venv\Scripts\pip install -r requirements.txt
npm install
npm run build
venv\Scripts\python -m hypatia
```

Abre http://127.0.0.1:5187. Hace falta Python 3.11+ con FTS5 en SQLite (las versiones oficiales lo traen) y Node 22 solo para compilar la app. El servidor solo escucha en 127.0.0.1 y rechaza hosts ajenos y peticiones de otros sitios (con la guarda compartida, para HTTP y websockets). Arrancarlo una segunda vez avisa de que ya está en marcha y no toca la primera instancia.

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

En la app local, **Actividades y entregas → Llevar fechas al calendario** permite
elegir periodo, asignatura actual o todas e incluir hechos/entregados. **Mostrar
calendario** usa la sincronización local existente antes de mostrar el banco del
servidor y declara cualquier error de sincronización. La descarga `.ics` contiene
exactamente la vista previa: sólo entregas y exámenes propios guardados. Sin hora
son días completos; con hora se conserva la hora local, sin inventar una zona ni
duración. Los registros sin fecha u hora válida aparecen con su motivo. No exporta
calificaciones, datos del profesor, fechas de examen heredadas de la asignatura ni
recordatorios; importar el archivo no crea una sincronización automática.

La herramienta MCP `study_calendar_export` y `POST /api/study/calendar/export`
comparten el cálculo de solo lectura. Reciben `date_from`/`date_to` obligatorios,
`subject` opcional (id/nombre) e `include_completed` (false por defecto). Devuelven
eventos, exclusiones, recuentos, fecha de la instantánea, nombre y texto ICS. Los
UID se conservan por registro. Se usa el constructor vendorizado según
[RFC5545](https://datatracker.ietf.org/doc/html/rfc5545), sin nuevos servicios ni modelos.

`faustus-plugin.json` es el manifiesto (`id: hypatia`, `HYPATIA_DIR` = esta carpeta). El puente MCP (`python mcp_server.py`) nunca abre la base de datos: reenvía cada llamada a `POST /api/agent/call` con el token de `data/mcp-token` y arranca el servidor si no responde nadie.

Herramientas de estudio: `subjects_list`, `topics_list`, `questions_search`, `question_get`, `questions_add`, `question_update`, `question_delete`, `cards_due`, `card_review`, `answer_grade`, `weak_topics`, `exam_mock`, `study_stats`, `key_concepts`, `key_concept_add`, `questions_suggest`, `questions_suggest_accept`, `deliverables_upcoming`, `page_card_add`, `pages_list`, `lesson_from_document`, `lesson_get`, `concept_mastery`, `lesson_delete`. Las tarjetas de página (una lección HTML, limpiada) salen en `cards_due` con `kind: "page"` y `pageHtml`, y se califican con `card_review` como cualquier tarjeta. Lecciones desde un documento: `lesson_from_document` divide un texto pegado o un fichero (PDF, DOCX, EPUB...) en secciones, extrae los conceptos clave de cada una con el modelo local (con reglas deterministas si ninguno responde) y guarda una pregunta por concepto en el banco; `lesson_get` da el recorrido (leer una sección y luego sus preguntas) y `concept_mastery` el dominio por concepto, calculado con el historial de repasos (REST: `/api/study/lessons*`). En la aplicación: Cuaderno → Lecciones, o el botón *Enséñame un documento* de la asignatura (build del Hoard).
Matemáticas exactas: `math_compute` evalúa operaciones, resuelve ecuaciones polinómicas de grado hasta 4 y deriva fórmulas localmente. Las potencias se escriben con `**`. Devuelve resultado exacto, aproximado (si es numérico) y LaTeX sin leer ni cambiar datos de estudio.

**Tabla de valores**, en el inicio junto a Calculadora exacta, evalúa una expresión en varios puntos de `x`, `y` o `t`. Conserva orden y repetidos, muestra el valor exacto y su aproximación y permite copiar la consulta completa con sus estados. Los ejemplos son editables. API `POST /api/math/values` y MCP `math_values` comparten `{expression, variable, points: ["-1", "0", "1/3", "pi"]}`; el catálogo pasa a 59 herramientas. Cada fila distingue real, complejo, indefinido, punto inválido o sin resolver. Los puntos son constantes reales finitas: se rechazan variables incluso si se cancelan (`x/x`, `x-x`). Se evalúa el árbol aritmético original antes de simplificar: `x/x` y `0*(1/x)` en cero son indefinidos, no límites. Los complejos usan las ramas principales del motor local; `I` es la unidad imaginaria. No deduce el dominio completo ni lee o cambia el banco. Los errores conservan el borrador, editar retira resultados incompatibles y respuestas tardías, y el panel abierto proporciona el borrador y resultado actuales al copilot. Reutiliza parser y SymPy existentes, sin motor, modelo o servicio nuevo.

`math_linear_system` resuelve `A*x=b` con hasta 12 ecuaciones y 8 variables nombradas, incluidos sistemas rectangulares. Envía coeficientes y constantes como textos (`"1/3"`, `"0.1"`), con las variables en el orden de las columnas. Devuelve `unique`, `infinite` o `inconsistent`, soluciones exactas, nombres originales de las variables libres, rangos de las matrices, matriz ampliada reducida y residuos de sustitución. Por ejemplo, `{"coefficients":[["1/3","1/2"],["1","-1"]],"constants":["1","0"],"variables":["x","y"]}` da `x=y=6/5` y dos residuos cero. No accede al banco. Admite textos numéricos finitos de hasta 100 caracteres y exponentes decimales entre -100 y 100. Los nombres etiquetan incógnitas, no constantes.

En el Dashboard local, **Sistemas lineales exactos** permite editar `[A | b]`,
elegir ecuaciones/incógnitas y renombrarlas. Conserva las entradas al reducir y
ampliar dimensiones o plegar el editor. Tres ejemplos editables cubren solución
única, infinitas soluciones e incompatibilidad; **Resolver sistema** muestra la
clasificación, soluciones exactas y aproximaciones separadas, variables libres,
rangos, verificación por sustitución y RREF desplegable. El resultado se puede
copiar y se borra al cambiar un dato. Las matrices anchas se desplazan dentro del
editor. `POST /api/math/linear-system` usa `MathLinearSystemArgs` y el mismo motor
que MCP `math_linear_system`, sin un nuevo cálculo ni guardar datos de estudio.

Los decimales de `math_compute` conservan los dígitos escritos, incluida la notación científica con exponentes de -100 a 100. El resultado exacto usa fracciones; la aproximación se redondea por separado. El solucionador sigue las [operaciones exactas de matrices documentadas por SymPy](https://docs.sympy.org/latest/modules/matrices/matrices.html), usando la dependencia existente sin añadir modelos ni servicios.
Profesor: ver [Rol Profesor](#rol-profesor).
Cuaderno: `notebook_sources`, `source_add`, `notebook_search`, `notebook_ask`, `studio_generate`, `studio_get`, `studio_to_questions`, `studio_list`, `tutor_turn`. `studio_to_questions` pasa una FAQ terminada al banco de práctica y omite duplicados si se repite.
Alias heredados de Hypatia 1 (tarjetas): `cards_add`, `decks_list`. `cards_add` recibe `{deck, cards: [{front, back, tags, source, source_ref}]}`; `source_ref` (por ejemplo `hoard://links/highlight/<id>`, que envía Links Hoard por un subrayado) se guarda con la tarjeta como `sourceRef`, no forma parte del hash de contenido (la misma tarjeta de otro sitio sigue siendo la misma; un duplicado que no tenía referencia la toma), viaja por la sincronización y se ve como una etiqueta *Origen* en el editor de preguntas.

### En la familia

- **Agenda.** `GET /api/family/agenda` (con el token de esta aplicación; `?from=&to=&sphere=`) responde al contrato de la agenda de la familia: la fecha de examen de cada asignatura (`exam`, prioridad alta en la última semana), la fecha de la cabecera de un examen de profesor cuando es una fecha de verdad (`exam`), las entregas pendientes con su día y hora (`deadline`, o `exam` si son pruebas) y, para hoy, un elemento `cards` de todo el día «N tarjetas para repasar hoy» cuando hay tarjetas que tocan. Solo salen nombres de asignaturas, títulos de examen y recuentos, nunca el nombre ni las respuestas de un alumno. El manifiesto dice `"x-family": {"agenda": true}`.
- **Servicios compartidos, a través del hub.** Las voces del podcast salen de Prospero's Hoard (`voice_tts`, sin URL que configurar); los embeddings del cuaderno, de Borges's Hoard (`embed_texts`; el modelo y su tamaño se guardan con cada vector y un cambio de modelo re-embebe las fuentes en el siguiente rescaneo), con el backend de embeddings propio de Hoard Link de Hypatia como respaldo solo cuando Borges no está; un PDF escaneado (la mitad o más de sus páginas sin capa de texto) lo lee el OCR de Kafka (`doc_extract`). La búsqueda vectorial puntúa todos los vectores guardados (sin tope). Sin esas apps, el cuaderno sigue indexando PDFs con texto y respondiendo por palabras clave.
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
| `HYPATIA_ALLOWED_HOSTS` | | Hosts extra (un túnel al móvil); `nombre:puerto` solo acepta ese puerto |
| `HYPATIA_LLM_TIMEOUT_S` | `900` | Lo máximo que puede tardar una llamada al modelo |
| `HYPATIA_LLM_THINKING` | `0` | `1` deja pensar a `high` cada llamada que no pida su propio nivel (más lento) |
| `HYPATIA_LLM_EFFORT` | sin fijar | `off`/`low`/`medium`/`high`/`max` impone un nivel de razonamiento a todas las llamadas. Sin fijar, cada tarea elige el suyo: corregir y responder en el cuaderno `medium`, redactar preguntas `high`, guías de estudio y briefings `max`, tomar notas en bloque `off` |
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

Ningún test sale a la red ni toca otra app de la familia (`tests/notebook/test_nb_family.py` cubre los embeddings de Borges, el OCR de Kafka y la versión del índice con un hub falso; `tests/test_family.py` cubre `source_ref`, los eventos de trabajo y la agenda). Algunos ejecutan el TypeScript con node (necesitan `npm install`): paridad de hashes y del núcleo de profesor, la migración Dexie 8→9 y el filtro de exportaciones (con `fake-indexeddb`).

## Licencia

MIT, Luis María Salete Cuartero.

## Edicion nativa de registros

MCP `record_get` y GET `/api/bank/records/{kind}/{id}` leen el objeto completo. `record_patch` y PATCH en esa ruta aplican solo los campos cambiados en una transaccion: los omitidos conservan su valor actual, incluidos los cambios concurrentes. Null borra campos opcionales; hash, busqueda y revision de sincronizacion cambian juntos. Los ids inexistentes o borrados no crean registros. Contrato completo en [API de registros](docs/API.md).

## Copilot de Faustus

El Hoard local muestra el panel común de Faustus en todas las vistas principales. Faustus guarda las conversaciones activas, borradores y turnos y utiliza su modelo global. Hypatia aporta la vista, los ids reales de los objetos de estudio o profesor, la selección y los campos visibles sin guardar; las altas `new` y los ids inexistentes no inventan objetos. El panel sigue el idioma y el tema de la app.

El servidor monta `/api/copilot/info`, `/api/copilot/panel.js` y `/api/copilot/proxy` con el transporte canónico de HoardLink. `copilot-space-id` identifica de forma duradera la carpeta de datos; las credenciales permanecen en el servidor. Los cambios de las herramientas refrescan las listas sin remontar formularios abiertos. Al guardar se envían sólo los campos cambiados a la API atómica de registros; los arrays y objetos anidados siguen siendo sustituciones de su campo completo.

Las consultas con fuentes y el Tutor del cuaderno conservan sus flujos pedagógicos con citas. Continuar en Faustus abre el asistente común. Las conversaciones antiguas permanecen legibles con sus citas; al continuarlas se importan por la API común idempotente, conservando ids de mensajes, fechas y metadatos de citas. Las conversaciones generales se ejecutan en Faustus, con sesiones y borradores independientes por asignatura. El Chat de fuentes y el Tutor conservan sus turnos nativos, citas, pasajes y dificultades. Se conservan las herramientas nativas de fuentes/tutor, el estado pedagógico y los datos originales. Requiere el servicio Faustus configurado y recompilar la PWA local con `npm run build`. La PWA pública sin conexión conserva su funcionamiento.

## Fracciones continuas finitas

La calculadora exacta descompone racionales y muestra todos sus convergentes.
`math_continued_fraction` y `POST /api/math/continued-fraction` comparten cálculo:
355/113 da [3; 7, 16] y los convergentes 3, 22/7 y 355/113. Entradas y resultados
son strings exactos, también negativos y enteros grandes. El último convergente
reconstruye el racional normalizado; no se modifica el banco de estudio. El panel
inline incluye ejemplo, tabla de términos/convergentes y copia de texto. Sólo
enteros, decimales finitos y fracciones de enteros del parser existente; no
periodicidad irracional ni prueba de optimalidad. Catálogo69=51Study+18Teacher.

## División de polinomios

La calculadora divide dos polinomios racionales en x, y o t y muestra cociente,
resto, identidad A=B×Q+R y residuo de comprobación exactos. Incluye ejemplo y
copia, conserva entradas ante error y retira resultados incompatibles al editar
o cerrar. El resto es cero o tiene grado menor que el divisor; cero no tiene
grado definido. UI, `math_polynomial_division` y
`POST /api/math/polynomial-division` comparten parser y SymPy locales existentes.
Sin división multivariable, funciones racionales ni pasos de división larga; no
modifica el banco ni añade dependencias. Catálogo69=51Study+18Teacher.


**MCD y Bézout polinómicos:** Inicio → MCD y Bézout de polinomios, `math_polynomial_gcd` y `POST /api/math/polynomial-gcd` reciben strings `a`, `b` racionales con variable x/y/t. Devuelven MCD/MCM no nulos mónicos, U/V e identidad A*U+B*V=MCD verificada exactamente. Las constantes no nulas son unidades sobre QQ; U/V no son únicos. Si una entrada es cero, el MCM es cero; para dos ceros MCD/MCM/U/V son cero por convenio. El cero no tiene grado. No multivariables, funciones racionales, pasos de Euclides, cambios del banco, modelos ni dependencias nuevas. Catálogo69=51Study+18Teacher. Editar o cerrar retira el resultado y descarta respuestas anteriores.
