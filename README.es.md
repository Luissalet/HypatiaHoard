# Hypatia's Hoard — Exam Coach 2, con Faustus

[English](README.md)

Hypatia's Hoard es la segunda versión de [Exam Coach](https://github.com/Mlgpigeon/ExamCoach), pensada para correr en tu PC y para que la maneje un asistente. Exam Coach se queda como estaba: una PWA pública que usaron alumnos. Hypatia lo incluye entero y añade:

- **Un servidor local** (Python, `hypatia/`) que sirve la app en `http://127.0.0.1:5187`, guarda tus datos de estudio en SQLite y los sincroniza con el IndexedDB de la app.
- **Control por asistente**: 28 herramientas MCP para que Faustus (o cualquier cliente MCP) te examine con repaso espaciado, monte simulacros sobre tus temas flojos, corrija respuestas abiertas y añada o proponga preguntas a partir de tu propio material.
- **Un cuaderno sobre tus fuentes**: respuestas con citas de tus PDFs, guía de estudio, resumen ejecutivo, FAQ, glosario, cronología, mapa mental, resumen en audio a dos voces y tutor socrático.
- **Solo modelos locales**, a través de Hoard Link (copiado en `hypatia/hoard_link/`), el mismo backend compartido que usa el resto de la familia Hoard. El podcast habla con la voz de Prospero's Hoard. Sin ningún modelo en marcha, cada función de IA devuelve igualmente el material para que el asistente haga el trabajo, y la app desactiva los botones que necesitan un modelo.

En este repositorio no hay contenido de ninguna asignatura. Las asignaturas llegan como **paquetes con contraseña** (`.examcoach.enc`) desde el marketplace o desde un fichero; sus preguntas, sus PDFs y tu progreso se quedan en `data/` y `resources/` en tu PC, ambas ignoradas por git.

## Todo lo que hacía Exam Coach

Asignaturas, temas y cuatro tipos de pregunta (test, desarrollo, completar, práctico) con Markdown y LaTeX; sesiones de práctica (aleatoria, falladas, por tema, inteligente SM-2, examen cronometrado); flashcards; modo lectura; modo escucha (PDF a voz con Piper en el navegador); visor y herramientas PDF; conceptos clave; exámenes a medida; extracción de preguntas con IA; evaluación continua y entregables; marketplace de asignaturas con paquetes cifrados; packs de contribución; sincronización por Gist; importar/exportar Anki; estadísticas. El mapa completo está en [FEATURES.md](FEATURES.md).

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
Cuaderno: `notebook_sources`, `source_add`, `notebook_search`, `notebook_ask`, `studio_generate`, `studio_get`, `studio_list`, `tutor_turn`.
Alias heredados de Hypatia 1 (tarjetas): `cards_add`, `decks_list`.

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
| `HYPATIA_LLM_THINKING` | `0` | `1` deja pensar a los modelos de razonamiento antes de responder (más lento) |
| `HYPATIA_PROSPERO_URL` | `Prospero's Hoard/data/url` hermano, si no `http://127.0.0.1:8815` | Estudio de voz para el podcast |
| `SCRIBE_URL`, `SCRIBE_TOKEN` | Scribe's Hoard hermano | Preguntas a partir de clases grabadas |
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

Ningún test sale a la red ni toca otra app de la familia.

## Licencia

MIT, Luis María Salete Cuartero.
