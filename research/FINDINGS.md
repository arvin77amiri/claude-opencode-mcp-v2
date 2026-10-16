# Hallazgos: OpenCode v2 (v2.0.22) vs bridge v1

Fecha: 2026-10-16. Servidor: `opencode serve` en 127.0.0.1:4096. Spec: `opencode-v2-openapi.json` (116 rutas).

## Resumen
- La API v2 vive bajo `/api/*`. Las rutas v1 (`/session`, `/global/health`, `/event`, `/path`, `/config/providers`) **ya no existen**:
  devuelven la SPA HTML con **HTTP 200** (no 404). Un cliente v1 fallaría silenciosamente → validar siempre `content-type: application/json`.
- Auth: HTTP Basic `opencode:<password>` (usuario `opencode`). Sin credenciales → 401. El spec no declara `securitySchemes`.
  Existen además `POST /api/pair`, `GET /auth/connect/{code}` y header `x-opencode-ticket` (no explorados).
- El spec se autodefine "Experimental HttpApi surface" v0.0.1; hay muchas rutas `/api/experimental/*`. Puede cambiar entre releases.
- Respuestas JSON van envueltas: `{ "data": ..., "location"?: {...} }`. Listados de mensajes: `{data, cursor}`.
- IDs con prefijo validado por patrón: `ses_`, `msg_`, `per` (permisos), etc.

## Smoke test (research/smoke/smoke-basic.mjs) — OK
Flujo verificado extremo a extremo con el modelo gratuito por defecto (`opencode/ll-alpha-free`, coste 0):
1. `GET /api/event` (SSE) abierto antes de empezar → `200 text/event-stream`, heartbeats `: heartbeat`.
2. `POST /api/session` `{title, location:{directory}, permissions:[{action:"*",resource:"*",effect:"allow"}]}` → `data.id = ses_…`.
   **Un único servidor sirve cualquier directorio** vía `location.directory` (no hace falta un servidor por workspace).
3. `POST /api/session/{id}/prompt` `{text}` → devuelve inmediatamente (asíncrono) el mensaje user con `delivery:"steer"`.
4. Espera: `GET /api/session/active` → `{data:{ses_…:{type:"running"}}}`; desaparece al terminar. (~8 s para la tarea de prueba.)
5. `GET /api/session/{id}/message?limit=20&order=asc` → mensajes `user`, `assistant` (content: reasoning/text/tool…), `system`, y un mensaje final
   `{type:"idle", outcome:"succeeded"}`.
6. `GET /api/session/{id}/diff` → `[{file, patch, additions, deletions, status:"added"}]` (sin necesidad de baseline git propio).
7. `GET /api/session/{id}` → incluye `cost`, `tokens`, `outcome:"succeeded"`, `time.idle`.
El archivo se creó realmente en el workspace.

## Eventos SSE (sample-events.sse)
Formato: líneas `data: {"id","created","type","location?","data":{...},"durable?":{aggregateID,seq,version}}`.
Tipos de sesión observados: `session.created`, `session.inbox.enqueued|delivered`, `session.execution.started|succeeded`,
`session.step.started|streamed|ended` (con `finish`, `cost`, `tokens`), `session.reasoning.started|delta|ended`,
`session.tool.input.started|ended`, `session.tool.called` (input), `session.tool.success` (content), `session.text.started|delta|ended`,
`session.usage.updated`. Globales: `server.connected`, `worktree.resolved`, `project.updated`, `mcp.status.changed`, `provider.updated`, …
Fin de ejecución: `session.execution.succeeded` (falta capturar el nombre exacto del evento de fallo/abort → ver tests de errores).

## Mapeo v1 → v2
| v1 | v2 |
|---|---|
| `/global/health` | `GET /api/info` → `{version,pid,urls,paths}` |
| `path.get` | `GET /api/location` |
| `session.create` | `POST /api/session` (agent, model{id,providerID,variant}, location, permissions, metadata) |
| `session.promptAsync` | `POST /api/session/{id}/prompt` (text, files, agents, skills, delivery steer\|queue) |
| `session.status` polling | `GET /api/session/active` o SSE `session.execution.*` |
| `session.messages` | `GET /api/session/{id}/message` (limit, order, cursor, type) |
| `session.abort` | `POST /api/session/{id}/interrupt` → `{interrupted}` |
| `session.diff` | `GET /api/session/{id}/diff` (from/to/context) |
| `app.agents` | `GET /api/agent` |
| `config.providers` | `GET /api/model`, `/api/model/default`, `/api/provider` |
| permission SSE + reply | `GET /api/permission/request`, SSE, `POST /api/session/{id}/permission/{req}/reply` `{decision:once\|always\|reject, message?}` (204) |

## Modelos / agentes
- `GET /api/model/default` → `{id,modelID,providerID,variants[low..max],cost,limit,...}`. 25 modelos (providers: opencode, nan, litellm).
- Model.Ref para sesión: `{id, providerID, variant?}` (v1 usaba `{providerID, modelID}`).
- Agentes: `build`(primary), `general`(subagent)… con `permissions:[{action,resource,effect}]`; efectos `allow|ask|deny`.

## Smoke tests 2 (research/smoke/smoke-permissions-interrupt-errors.mjs, smoke-bad-model-agent.mjs)

### Permisos (default `ask`)
- Con las reglas por defecto, leer fuera del workspace (`C:\Windows\win.ini`) dispara una petición:
  `GET /api/session/{id}/permission` (también global `GET /api/permission/request`) →
  `{id:"per_…", sessionID, action:"external_directory", resources:["C:/Windows/*"], save:[…], source:{type:"tool",messageID,id}}`.
- SSE: `permission.asked` (mismo payload en `data`) y `permission.replied`. La ejecución queda en pausa hasta responder.
- Respuesta: `POST /api/session/{id}/permission/{per_…}/reply {decision:"once"|"always"|"reject", message?}` → **204**.
  Con `reject` el tool falla (`session.tool.failed`) y el agente continúa; la sesión termina `succeeded`.
- Reglas: lista ordenada `{action,resource,effect: allow|ask|deny}`; las del agente/sesión se **añaden tras** las de por defecto
  (última coincidencia gana, a verificar). `"*"/"*"/allow` en `permissions` de la sesión evita los asks.
- `action` observadas: `external_directory`, `read`, `question`, `browser`, `*`.

### Interrupt / outcomes
- `POST /api/session/{id}/interrupt` → `200 {interrupted:true}`; repetirlo → `{interrupted:false}` (idempotente).
- SSE `session.execution.interrupted`; `GET /api/session/{id}` → `outcome:"interrupted"`.
- Outcomes de sesión vistos: `succeeded`, `interrupted`, `failed`. Eventos terminales: `session.execution.succeeded|interrupted` (+ failed para error).
- Mensaje final de `message` list: `{type:"idle", outcome}`; es la señal más fiable de fin (sin race con `active`).
  Cuidado: al hacer polling de `/api/session/active` justo tras el prompt puede aún no estar "running" → exigir haberlo visto running
  o comprobar el mensaje `idle` posterior al id del mensaje user.

### Errores
- `POST /api/session` **no valida** modelo ni agente: acepta `model:{id:"nope"}` y `agent:"does-not-exist"` (200). El fallo aparece al
  ejecutar: `outcome:"failed"`, mensaje `idle` con `outcome:"failed"` y **sin detalle de error** en la sesión (falta capturar el evento
  `session.execution.failed`/error en SSE). → el bridge debe **validar modelo/agente antes** con `GET /api/model` y `GET /api/agent/{id}`.
- Sesión inexistente → `404 {"_tag":"SessionNotFoundError","sessionID","message"}` (errores tipados con `_tag`).
- Directorio inexistente en `location.directory` → **500 con cuerpo vacío** → validar el workspace en el bridge (ya lo hace `workspace/validator.ts`).
- Sin auth → `401 {"_tag":"UnauthorizedError","message":"Authentication required"}`.

### Agentes personalizados
- `PATCH /api/experimental/config` solo admite `{shell}`: **no se pueden inyectar agentes por API**.
- Descubrimiento por directorio, con `?location[directory]=<ruta>` (deepObject, `-g` en curl):
  - `opencode.json` del proyecto, clave **`agents`** (plural) → `{<id>:{description,mode,system,model,permissions,steps,hidden,color,disabled}}`.
  - `.opencode/agents/<id>.md` con frontmatter (`description`, `mode`) y cuerpo = system prompt. Ambos detectados.
  - Config global `~/.config/opencode/opencode.json` (sus agentes aparecen en todos los workspaces).
- `model` de agente: string `provider/model[#variant]` o `{providerID,model,variant?}`.
- `GET /api/agent` es perezoso/eventualmente consistente: la primera lista tras cambios puede venir incompleta; `GET /api/agent/{id}` resuelve bien.
  `POST /api/location/reload?location[directory]=…` (204) recarga.
- **`OPENCODE_CONFIG_CONTENT` (JSON) sigue funcionando en v2** (verificado: `agents.env-agent` visible en `GET /api/agent/env-agent`) →
  se mantiene la estrategia v1 de lanzar un `opencode serve` propio con config inline sin escribir en el proyecto.
- `OPENCODE_SERVER_PASSWORD` fija la contraseña Basic (user `opencode`) del servidor lanzado; sin credenciales → 401.
- `opencode serve --help`: flags `--hostname --port --cors --service --stdio` (hay modo **stdio**, sin explorar).
  Salida al arrancar: `server listening on http://127.0.0.1:<port>`.

## E2E del bridge v2 contra OpenCode real (research/smoke/e2e-bridge-v2.mjs)
`delegate_task` con `deepseek-researcher` y el modelo gratuito `opencode/ll-alpha-free` termina `completed` y devuelve el contenido correcto.
Bugs encontrados al ejecutarlo (y corregidos en `v2/`):
1. **Servidor lanzado sin contraseña → 401 para todos.** `opencode serve` sin `OPENCODE_SERVER_PASSWORD` genera una contraseña aleatoria
   (la imprime como `server password …`). El bridge debe generar la suya (`randomBytes`) y pasarla por entorno. Fix en `manager.ts`.
2. **Calentamiento de config inline (~1 s).** Justo tras `listening`, `GET /api/agent/{id}` devuelve 404 para agentes definidos en
   `OPENCODE_CONFIG_CONTENT` (los built-in como `build` ya responden antes; research/smoke/cold-start-agent-404.mjs: 404, 404, 200 a 0.7/1.3/1.8 s).
   El bridge lo tomaba por "agente desconocido" y caía al preámbulo (ejecutaba como `build`). Fix: reintentar la búsqueda ≤6 s (`setup.ts`).
   Comprobación: mensajes `agent-switched` + assistant con `agent:"deepseek-researcher"`, sin preámbulo.
3. Un servidor propio **hereda la config global del usuario** (`~/.config/opencode`): sus agentes (`design/*`, `architect`, …), proveedores y
   servidores MCP (playwright, chrome-devtools → catálogo "Code Mode") se cargan también. Ralentiza y ensucia las delegaciones;
   pendiente decidir si aislar (p. ej. `XDG_CONFIG_HOME`/`OPENCODE_CONFIG` propios) o aceptarlo.
4. El modelo gratuito es lento (razonamiento largo; la tarea trivial tardó 30-90 s) → los timeouts por defecto de 180 s son justos con él.
5. `get_diff` sobre una sesión sin cambios devuelve `DIFF_UNAVAILABLE` (comportamiento esperado, no error de OpenCode).
6. Si `bash` está permitido, denegar `edit`/`write` no impide escribir (ver Smoke tests 3); los perfiles read-only del bridge ya deniegan `bash`.

## Pendiente
- `--stdio`, `/api/pair`, `x-opencode-ticket` (sin explorar).
- Aislar la config global del usuario en el servidor lanzado por el bridge (punto 3).
- Adaptar `tests/e2e/*` a v2 (siguen asumiendo proveedor `deepseek`) y añadir test de regresión del 404 de calentamiento y de la contraseña generada.
- Actualizar README y docs/ (aún describen v1: `maxServers`, un servidor por workspace).
- `steer` vs `queue` con un modelo rápido; `fork`, `compact`, `revert`.
- Seguridad: `GET /api/config` devuelve API keys en claro; el bridge nunca debe llamarlo ni loguearlo.

## Calentamiento del catálogo de modelos
Además del 404 de agentes, `GET /api/model` devuelve un catálogo **incompleto** justo tras `listening` (p. ej. 25 modelos pero ninguno del
proveedor `nan`, que aparece ~2 s después). El bridge reintenta (≤6 s) antes de dar un modelo por inexistente.
Ids de `nan` en el servidor de pruebas: deepseek-v4-flash, glm5.3-flash, glm5.3, qwen3.8-flash, qwen3.6, gemma4, mimo-v2.6-flash, qwen-image-2.1.
