# Hypatia's Hoard

Tus propias tarjetas de repaso, programadas en tu ordenador con el algoritmo clásico de repetición espaciada SM-2. La aplicación es el calendario y la interfaz de repaso; un asistente accede a las mismas tarjetas por MCP, así que puede rellenarlas con lo que acabas de leer o decir, y examinarte en el chat — mostrando solo el frente, esperando tu respuesta real, y calificándola contra el reverso.

Todo se queda en tu máquina: SQLite para tarjetas, mazos y el registro de repasos, sin cuentas y sin red.

## Qué hace

- **Mazos** = grupos con nombre, cada uno con su límite de tarjetas nuevas al día (`new_per_day`). Existe siempre un mazo por defecto «General»; crear un mazo con un nombre ya existente (sin distinguir tildes ni mayúsculas) devuelve el mismo mazo.
- **Tarjetas** = frente (pregunta, markdown) / reverso (respuesta, markdown) / etiquetas / fuente. Añadir una tarjeta cuyo frente ya existe en el mazo (normalizado: minúsculas, sin tildes, espacios colapsados) actualiza su reverso/etiquetas/fuente en vez de duplicarla.
- **Programación**: SM-2 — calificaciones otra vez/difícil/bien/fácil; la facilidad empieza en 2,5 (mínimo 1,3); las tarjetas nuevas pasan por «aprendiendo» (1 día, luego 6 días) hasta «repaso» (intervalo × facilidad); un fallo en repaso pasa la tarjeta a «olvidada» y vuelve a aprenderse desde ahí; cada repaso queda registrado. Los intervalos se limitan a 365 días.
- **Cola de repaso**: primero las olvidadas/aprendiendo, luego las de repaso por fecha, luego las nuevas por orden de creación, limitadas por el `new_per_day` de cada mazo. La interfaz nunca recibe el reverso antes de que lo revelas; la herramienta `cards_due` del asistente sí lo recibe, porque es quien califica tu respuesta hablada.
- **Estadísticas**: por mazo o en total — recuentos por estado, pendientes ahora, repasadas hoy, retención a 30 días, racha de días consecutivos con al menos un repaso, y previsión a 7 días.
- **Búsqueda**: FTS5 sobre frente/reverso/etiquetas/fuente, sin distinguir tildes, con coincidencia de prefijo, filtrable por mazo/etiqueta/estado.
- **Importar/exportar**: un mazo acepta una lista JSON `[{front, back, tags?, source?}]` o CSV (`front,back,tags,source`) y evita duplicados; exportar devuelve las tarjetas del mazo con su programación completa, para llevarlas a otra máquina.
- **Sugerir tarjetas de lo que oíste, no solo de lo que leíste**: un panel «Sugerir/Suggest» (y la herramienta `cards_suggest`) redacta tarjetas con un modelo local a partir de texto pegado o de una sesión/rango de fechas de Scribe's Hoard — un hecho por tarjeta, con `source` rellenado — como propuesta que revisas, editas y marcas antes de guardar nada. Ver [Sugerir tarjetas](#sugerir-tarjetas-desde-texto-o-una-sesión-de-scribes-hoard).

## Requisitos

- Windows 10/11 (también Linux/macOS), Python 3.11 o superior (3.13 va bien), Node 22 solo para construir el cliente.
- El `sqlite3` de Python debe tener FTS5. Si falta, la aplicación avisa al arrancar.

## Instalar y arrancar (Windows)

```bat
git clone <este repositorio> hypatia-hoard
cd hypatia-hoard
python -m venv venv
venv\Scripts\pip install -r requirements.txt
npm install
npm run build
venv\Scripts\python -m hypatia
```

Abre http://127.0.0.1:5187, entra en **Mazos** para crear uno, luego en **Tarjetas** para añadir fichas (o deja que lo haga el asistente), y en **Repasar** para estudiar.

- `python scripts/launch.py` arranca en un puerto libre y abre el navegador.
- `python scripts/dev.py` lanza uvicorn con recarga y el servidor de Vite.

## Configuración (variables de entorno)

| Variable | Por defecto | Significado |
| --- | --- | --- |
| `HYPATIA_PORT` / `PORT` | `5187` | Puerto preferido; `PORT_STRICT=1` lo fija, si no se usa el primero libre. |
| `HYPATIA_DATA_DIR` | `<repo>/data` | Base de datos, `mcp-token`. |
| `HYPATIA_ALLOWED_HOSTS` | | Nombres de host adicionales aceptados detrás de un túnel. |
| `SCRIBE_URL` | (`data/url` del hermano, si no `http://127.0.0.1:5185`) | Dónde está Scribe's Hoard, para la fuente `scribe` de `cards_suggest`. |
| `SCRIBE_TOKEN` | (`data/mcp-token` del hermano) | Token de la API de agente de Scribe's Hoard. |
| `SCRIBE_DIR` / `SCRIBE_DATA_DIR` | (una carpeta hermana llamada «Scribe's Hoard») | Forzar dónde está Scribe's Hoard (o su carpeta `data/`). |

### Acceso desde el móvil (a través de un túnel)

El servidor escucha en 127.0.0.1 y solo responde a peticiones cuyo `Host` sea `localhost`, `127.0.0.1` o `[::1]`. Para entrar desde el móvil, indicad los nombres de host adicionales en `HYPATIA_ALLOWED_HOSTS`, separados por comas, exactos o `*.sufijo`: `HYPATIA_ALLOWED_HOSTS=mi-pc.example,*.ts.net`. Una vez abierta a través del túnel, el navegador ofrece instalarla (PWA).

## Conectar el asistente (MCP)

`mcp_server.py` es un puente stdio: pide la lista de herramientas a la aplicación en marcha y reenvía cada llamada a `POST /api/agent/call` con el token de `data/mcp-token`. Nunca abre la base de datos. Faustus detecta la aplicación por `/api/health` y rellena la conexión con `faustus-plugin.json`.

Herramientas: `decks_list`, `deck_create`, `cards_add`, `cards_due`, `card_review`, `cards_search`, `card_update`, `card_delete`, `cards_stats`, `cards_export`, `cards_suggest` y `cards_suggest_accept`. Las instrucciones obligan al asistente a añadir tarjetas solo desde material real, con una fuente en cada una; cuando el usuario pide tarjetas de lo hablado/de la reunión/de una transcripción, a llamar `cards_suggest`, mostrar las propuestas y guardar solo las que el usuario acepte; al examinar, a mostrar solo el frente, esperar la respuesta real y calificar con `card_review` (con el frente mostrado, que decide la tarjeta aunque el id venga mal; un «no me acuerdo», en blanco o sobre otro tema es «otra vez»); a no revelar nunca el reverso antes de tiempo ni calificar sin una respuesta real del usuario.

## Sugerir tarjetas desde texto o una sesión de Scribe's Hoard

Además de escribir tarjetas a mano de lo que *lees*, el panel **Sugerir/Suggest** en **Tarjetas** (y la herramienta `cards_suggest` del asistente) redacta tarjetas de lo que *oyes*: pega un pasaje, o señala una sesión de Scribe's Hoard (por id, o un rango desde/hasta que abarque varias sesiones). El redactado corre sobre un modelo local a través de [Hoard Link](https://github.com/Luissalet/HoardLink) (empaquetado en `hypatia/hoard_link/`, ver su `VENDORED.txt`) — la misma resolución de servidor compartido que usan los demás complementos de Faustus, así que reutiliza el servidor `llm` que ya esté cargado en vez de cargar una segunda copia de un modelo. No se guarda nada automáticamente: el redactado devuelve `drafts` (frente/reverso/fuente) para que tú (o el asistente) los revises, edites y marques, y solo `cards_suggest_accept` / `POST /api/suggest/accept` (o un `cards_add` normal) las escribe en un mazo.

Si no hay ningún modelo disponible (o responde algo que no es el JSON esperado), `cards_suggest` nunca falla en silencio: devuelve `drafts: []`, el `material` reunido (el texto pegado, o la transcripción) y una `note` explicando por qué, para que el asistente redacte las tarjetas él mismo a partir de `material`.

La fuente `scribe` de `cards_suggest` habla con Scribe's Hoard exactamente como los complementos de Faustus hablan entre sí: `GET /api/agent/tools` / `POST /api/agent/call` en el puerto de Scribe, autenticado con el token *de Scribe* (leído de su `data/mcp-token` hermano, o `SCRIBE_TOKEN`/`SCRIBE_URL` arriba). Hypatia's Hoard nunca abre la base de datos de Scribe ni le escribe nada.

## Pruebas

```bat
venv\Scripts\python -m pytest -q
```

## Límites (v1)

- No hay tarjetas cloze (de huecos), solo frente/reverso.
- La búsqueda es solo por palabras (FTS5); no hay búsqueda semántica.
- No hay sincronización entre dispositivos: los datos viven en el ordenador donde corre la aplicación.

## Licencia

MIT — Luissalet.
