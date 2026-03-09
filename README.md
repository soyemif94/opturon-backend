# Sistema base de automatizacion - Clinica odontologica

Backend en Node.js + Express para recibir webhooks (WhatsApp/formulario), analizar mensajes con OpenAI, asignar turnos urgentes, guardar datos y devolver una respuesta lista para enviar por WhatsApp.

## Estructura de carpetas

```txt
.
|-- data/
|   |-- patients.json
|   |-- users.json
|   `-- schedule.json
|-- src/
|   |-- config/
|   |   `-- env.js
|   |-- controllers/
|   |   |-- auth.controller.js
|   |   |-- debug.controller.js
|   |   |-- metrics.controller.js
|   |   `-- webhook.controller.js
|   |-- middlewares/
|   |   `-- verify-meta-signature.middleware.js
|   |-- routes/
|   |   |-- auth.routes.js
|   |   |-- debug.routes.js
|   |   |-- metrics.routes.js
|   |   `-- webhook.routes.js
|   |-- services/
|   |   |-- ai.service.js
|   |   |-- appointment.service.js
|   |   |-- response.service.js
|   |   |-- user.service.js
|   |   `-- whatsapp.service.js
|   |-- services/storage/
|   |       |-- storage.service.js
|   |       |-- json-storage.service.js
|   |       `-- google-sheets-storage.service.js
|   |-- utils/
|   |   |-- logger.js
|   |   `-- validators.js
|   |-- app.js
|   `-- server.js
|-- .env.example
|-- .gitignore
|-- package.json
`-- README.md
```

## Requisitos

- Node.js 18+
- npm 9+

## Instalacion y ejecucion local

1. Instalar dependencias:

```bash
npm install
```

2. Crear archivo de entorno:

```powershell
Copy-Item .env.example .env
```

3. Configurar variables en `.env` (minimo):

- `PORT=3001`
- `ALLOW_DEBUG=false`
- `META_VERIFY_TOKEN=change_me_verify_token`
- `WHATSAPP_ACCESS_TOKEN=change_me_meta_access_token`
- `WHATSAPP_PHONE_NUMBER_ID=...`
- `WHATSAPP_WABA_ID=...`
- `WHATSAPP_API_VERSION=v25.0`
- `WHATSAPP_GRAPH_VERSION=v25.0`
- `WHATSAPP_DEBUG=false`
- `WHATSAPP_DEBUG_KEY=...` (obligatoria si `WHATSAPP_DEBUG=true`)
- `WHATSAPP_SANDBOX_AR_NORMALIZE=false`
- `META_APP_SECRET=...` (requerido si `VERIFY_SIGNATURE=true`)
- `VERIFY_SIGNATURE=false` (en dev)
- `STORAGE_MODE=json`
- `JSON_DB_PATH=./data/patients.json`
- `USERS_DB_PATH=./data/users.json`
- `SCHEDULE_DB_PATH=./data/schedule.json`

4. Levantar servidor:

```bash
npm run dev
```

## Endpoints

### `GET /webhook` (verificacion Meta)

Verifica el endpoint para WhatsApp Business Cloud API.

Regla:
- Si `hub.mode=subscribe` y `hub.verify_token` coincide con `META_VERIFY_TOKEN`, responde `200` con `hub.challenge` en texto plano.
- Si no coincide, responde `401`.

Prueba en Postman o navegador:

```txt
GET /webhook?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=123
```

### `POST /alta` (o `POST /signup`)

Da de alta un usuario para pruebas del bot y devuelve un payload listo para usar en `POST /webhook`.

Request ejemplo:

```json
{
  "name": "Ana",
  "phone": "+5491123456789"
}
```

Respuesta ejemplo:

```json
{
  "success": true,
  "data": {
    "created": true,
    "user": {
      "id": "uuid",
      "name": "Ana",
      "phone": "+5491123456789",
      "createdAt": "2026-02-21T00:00:00.000Z"
    },
    "testPayload": {
      "source": "whatsapp",
      "channel": "whatsapp",
      "from": "+5491123456789",
      "name": "Ana",
      "patientId": "uuid",
      "message": "Hola, tengo dolor fuerte en una muela y necesito cita urgente"
    }
  }
}
```

### `POST /webhook`

Soporta 2 formatos sin romper el flujo actual:
- Formato legacy (actual del proyecto).
- Formato oficial de WhatsApp Cloud (`entry[].changes[].value.messages[]`).

Para mensajes entrantes tipo `text`, ejecuta el pipeline existente:
`análisis IA -> asignación turno -> storage -> métricas`
y luego envía respuesta saliente por Graph API.

Request ejemplo (legacy):

```json
{
  "source": "whatsapp",
  "channel": "whatsapp",
  "from": "+5215512345678",
  "name": "Ana",
  "patientId": "",
  "message": "Hola, tengo dolor fuerte en una muela y necesito cita urgente"
}
```

Request ejemplo (WhatsApp Cloud):

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_ID",
      "changes": [
        {
          "field": "messages",
          "value": {
            "messaging_product": "whatsapp",
            "contacts": [
              {
                "profile": { "name": "Ana" },
                "wa_id": "5491123456789"
              }
            ],
            "messages": [
              {
                "from": "5491123456789",
                "id": "wamid.HBgL...",
                "timestamp": "1700000000",
                "type": "text",
                "text": { "body": "Hola, tengo dolor fuerte en una muela" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

Respuesta ejemplo (legacy):

```json
{
  "success": true,
  "data": {
    "recordId": "uuid",
    "storedIn": "json",
    "analysis": {
      "patientStatus": "new",
      "treatmentType": "dolor_molar",
      "urgencyLevel": "critical",
      "summary": "...",
      "confidence": 0.82
    },
    "appointment": {
      "slotId": "slot-001",
      "startAt": "2026-02-23T15:00:00.000Z",
      "endAt": "2026-02-23T15:30:00.000Z"
    },
    "reply": {
      "to": "+5215512345678",
      "channel": "whatsapp",
      "text": "Hola Ana, ... Te confirmamos un turno prioritario para 2026-02-23T15:00:00.000Z ..."
    }
  }
}
```

Respuesta ejemplo (WhatsApp Cloud):

```json
{
  "success": true,
  "data": {
    "received": 1,
    "processed": 1,
    "failed": 0,
    "results": [
      {
        "messageId": "wamid.HBgL...",
        "from": "5491123456789",
        "recordId": "uuid",
        "delivery": {
          "sent": true,
          "status": 200
        }
      }
    ],
    "errors": []
  }
}
```

Observabilidad de entrega:
- Al inicio de cada `POST /webhook` se registra `webhook_post_received` con `requestId`, headers resumidos, claves del body, `object`, cantidad de `entry` y el primer `field` detectado.
- Tambien se guarda un ring buffer en memoria con los ultimos 50 POST para inspeccion rapida.

### `GET /debug/webhook/recent` (protegido)

Devuelve los ultimos POST recibidos en `/webhook` desde memoria:
- `timestamp`
- `requestId`
- `object`
- `field`
- `from`
- `messageId`
- `textPreview`
- `rawBody` truncado

Para disparar una prueba desde Meta:
1. En Meta for Developers abre tu app.
2. Ve a `WhatsApp > Configuration` o `Webhooks`.
3. En la suscripcion del campo `messages`, usa el boton `Test`.
4. Luego inspecciona `GET /debug/webhook/recent` con el header `x-debug-key`.

Ejemplo:

```powershell
$k="123"; irm "http://localhost:3001/debug/webhook/recent?limit=10" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

### `GET /debug/whatsapp/config` (protegido)

Devuelve configuracion sanitizada:
- `tokenLen`
- `apiVersion`
- `phoneNumberId`
- `debugEnabled`

### `GET /debug/whatsapp/assets` (protegido)

Descubre assets accesibles por token:
- businesses
- wabas
- phone numbers

### `GET /debug/whatsapp/waba` (protegido)

Valida el `WHATSAPP_PHONE_NUMBER_ID`, usa `WHATSAPP_WABA_ID` para listar apps suscriptas y suscribe la app actual si hace falta.

Importante:
- `WHATSAPP_WABA_ID` es obligatorio para este diagnostico.
- El objeto phone number no expone `whatsapp_business_account` en esta llamada Graph, por eso no se intenta inferir el WABA desde `/{PHONE_NUMBER_ID}`.

Respuesta:

```json
{
  "phoneNumberId": "1234567890",
  "wabaId": "9876543210",
  "subscribedApps": {
    "data": []
  },
  "subscribedNow": true
}
```

### `POST /debug/whatsapp/send-test` (protegido)

Endpoint de prueba manual para enviar mensajes salientes por WhatsApp Cloud API.

Proteccion:
- Requiere `WHATSAPP_DEBUG=true`.
- Requiere header `x-debug-key` igual a `WHATSAPP_DEBUG_KEY`.
- Si no coincide, devuelve `404`.

Request ejemplo:

```json
{
  "to": "549XXXXXXXXXX",
  "text": "mensaje"
}
```

### Panel humano de turnos (debug protegido)

Con `WHATSAPP_DEBUG=true` y header `x-debug-key`:
Antes de usar agenda persistente, correr `npm run db:migrate` para aplicar `006_appointments.sql`.

- `GET /debug/appointments/requests?limit=20&offset=0`
- `GET /debug/inbox/appointments?status=requested,reschedule_proposed&limit=25&q=juan&sort=requestedAt&order=desc`
- `GET /debug/appointments/:conversationId`
- `POST /debug/appointments/:conversationId/confirm`
- `POST /debug/appointments/:conversationId/reject`
- `POST /debug/appointments/:conversationId/reschedule`
- `GET /debug/appointments/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&clinicId=<id>`

`POST /debug/appointments/:conversationId/confirm` ahora puede devolver:
- `appointmentCreated=false`
- `warning="Appointment conflict: already booked"`
- `suggestions: [{ startAt, endAt, displayText }]` con proximos slots sugeridos.
- Si no hay hora exacta pero hay `timeWindow` (`morning|afternoon|evening`) + fecha resolvible, tambien devuelve `suggestions` dentro de esa franja para reprogramar en 1 click.

One-liner PowerShell (tomar el primer requested y confirmarlo):

```powershell
$k="123"; $r=irm "http://localhost:3001/debug/appointments/requests?limit=1" -Headers @{ "x-debug-key"=$k }; $id=$r.items[0].conversationId; irm -Method Post "http://localhost:3001/debug/appointments/$id/confirm" -Headers @{ "x-debug-key"=$k; "x-action-id"="oneclick-$(Get-Date -Format s)" } -ContentType "application/json" -Body '{"confirmedText":"lunes 10:30"}'
```

Agenda (calendar) por rango:

```powershell
$k="123"; irm "http://localhost:3001/debug/appointments/calendar?from=2026-03-01&to=2026-03-15&clinicId=<clinicId>" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Consulta de bandeja operativa (listo para UI):

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?status=requested,reschedule_proposed&limit=25&q=juan&sort=requestedAt" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Sin total (más liviano):

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?includeTotal=false&limit=25" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Filtrado por clínica/canal:

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?clinicId=<clinicId>&channelId=<channelId>&limit=25" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

`q` mínimo:

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?q=a&limit=25" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Si `q` tiene menos de 2 caracteres, se ignora para evitar búsquedas caras.

Prioridad (high primero, `order` se ignora cuando `sort=priority`):

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?sort=priority&includeTotal=false" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Solo pendientes de acción:

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?needsHumanAction=true" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Sin hora exacta:

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?hasTime=false" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Filtrar por franja:

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?timeWindow=afternoon" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Definiciones:
- `needsHumanAction`: `status` en `requested` o `reschedule_proposed`.
- `priority`:
  - `high`: requiere coordinación (sin hora exacta o con franja).
  - `normal`: pendiente con hora exacta.
  - `low`: confirmado/rechazado o sin acción humana pendiente.
- `priorityRank`:
  - `1` = `high`
  - `2` = `normal`
  - `3` = `low`
- `ageMinutes`: minutos transcurridos desde `requestedAt`.

Solo high priority:

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?priority=high" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Ordenar por prioridad:

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?sort=priority" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

Warning example:

```powershell
$k="123"; irm "http://localhost:3001/debug/inbox/appointments?sort=priority&order=asc" -Headers @{ "x-debug-key"=$k } | ConvertTo-Json -Depth 10
```

UI interna mínima (debug):

```txt
http://localhost:3001/debug/ui/inbox?k=123
```

La UI muestra `ai_meta` del último outbound y permite ver auditoría IA por conversación.

Checklist UI:
- carga lista desde `/debug/inbox/appointments`
- carga detalle desde `/debug/appointments/:conversationId`
- botones confirmar/rechazar/reprogramar envían `x-action-id` único
- muestra `success/skipped/warnings` y refresca lista + detalle

### Debug Inbox (memoria, debug protegido)

Flags requeridos:
- `WHATSAPP_DEBUG=true`
- `DEBUG_API_ENABLED=true`

Variables:
- `DEBUG_INBOX_MAX_ITEMS=200` (ring buffer en memoria)
- `AUTO_REPLY_ENABLED=false` (auto respuesta basica por reglas)

Endpoints:
- `GET /debug/inbox?limit=50`
- `POST /debug/inbox/clear`
- `GET /debug/inbox/health`

Ejemplos:

```powershell
$k="123"
curl.exe -sS -H "x-debug-key: $k" "https://api.opturon.com/debug/inbox?limit=10"
curl.exe -sS -X POST -H "x-debug-key: $k" "https://api.opturon.com/debug/inbox/clear"
curl.exe -sS -H "x-debug-key: $k" "https://api.opturon.com/debug/inbox/health"
```

Auto-reply (opt-in):
- Activar `AUTO_REPLY_ENABLED=true`.
- Reglas texto entrante:
  - contiene `hola|buenas` -> saludo
  - contiene `precio` -> consulta comercial
  - contiene `gracias` -> cierre cordial
  - otro texto -> respuesta default
- No responde a eventos echo/from_me ni a mensajes sin texto.
- En produccion con debug flags en `false`, `/debug/*` sigue bloqueado (404).

Respuesta ejemplo:

```json
{
  "success": true,
  "data": {
    "sent": true,
    "status": 200,
    "data": {
      "messages": [{ "id": "wamid.HBgL..." }]
    }
  }
}
```

### IA opcional (OpenAI) con fallback deterministico

Variables de entorno:

- `AI_ENABLED=false` (default)
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=gpt-4o-mini` (default)
- `OPENAI_TIMEOUT_MS=15000` (default)
- `AI_ALLOWED_STATES=READY,ASKED_NAME` (default)
- `AI_DENIED_STATES=CONFIRM_APPOINTMENT,ASKED_APPOINTMENT_DATETIME,ASKED_APPOINTMENT_TIMEWINDOW` (default, tiene prioridad)
- `AI_ALLOWED_JOB_TYPES=conversation_reply` (default)
- `AI_MAX_CALLS_PER_CONVERSATION_WINDOW=5` (default)
- `AI_WINDOW_MS=3600000` (default, 1h)
- `AI_ENABLED_CLINIC_IDS=` (csv allowlist opcional)
- `AI_DISABLED_CLINIC_IDS=` (csv denylist opcional)
- `AI_ENABLED_CHANNEL_IDS=` (csv allowlist opcional)
- `AI_DISABLED_CHANNEL_IDS=` (csv denylist opcional)

Comportamiento:

- Si `AI_ENABLED=false` o falta `OPENAI_API_KEY`, el worker usa solo el engine deterministico actual.
- Si IA esta habilitada, `conversation_reply` intenta IA solo cuando el `state` y `job.type` estan permitidos.
- Si el `state` esta en `AI_DENIED_STATES`, siempre se usa respuesta deterministica.
- Si se supera el presupuesto por conversacion en ventana (`AI_MAX_CALLS_PER_CONVERSATION_WINDOW` + `AI_WINDOW_MS`), se omite IA y se registra `ai_rate_limited`.
- El worker siempre mantiene `state/contextPatch` del engine deterministico.
- Si OpenAI falla o timeout, hace fallback automatico sin fallar el job.
- La salida IA se normaliza y acota a 280 caracteres.

Recomendado en produccion (hardening):

- `WHATSAPP_DEBUG=false`
- `DEBUG_API_ENABLED=false`
- `DEBUG_UI_ENABLED=false`
- `AI_ENABLED=false` (activar gradualmente con allowlists)

Rollout IA por clinica/canal:

- Precedencia: `deny` > `allow`.
- Si una allowlist (`AI_ENABLED_*`) no esta vacia, IA solo corre para IDs incluidos.
- Si las allowlists estan vacias, IA se permite por scope (salvo IDs en denylist).

Ejemplos:

- `AI_ENABLED_CHANNEL_IDS=chanA,chanB`
- `AI_DISABLED_CLINIC_IDS=clinicX`

Debug protegido (no envia WhatsApp ni persiste):

- `POST /debug/ai/reply`
  - Body: `{ "conversationId": "...", "text": "hola" }`
  - `conversationId` es opcional.

### Auditoria IA (raw.ai)

SQL rapido para inspeccionar metadatos IA en outbounds:

A) Ultimos 20 outbounds con ai_meta (global):

```sql
SELECT
  "conversationId",
  text,
  raw->'ai' AS ai_meta,
  "createdAt"
FROM conversation_messages
WHERE direction = 'outbound'
ORDER BY "createdAt" DESC
LIMIT 20;
```

B) Ultimos 20 outbounds por conversacion:

```sql
SELECT
  direction,
  text,
  raw->'ai' AS ai_meta,
  "createdAt"
FROM conversation_messages
WHERE "conversationId" = '<conversationId>'
  AND direction = 'outbound'
ORDER BY "createdAt" DESC
LIMIT 20;
```

C) Contadores rapidos por estado IA (ultimas 24h):

```sql
SELECT
  COALESCE(raw->'ai'->>'used', 'false') AS used,
  COALESCE(raw->'ai'->>'fallbackUsed', 'false') AS fallback_used,
  COALESCE(raw->'ai'->>'skipReason', '') AS skip_reason,
  COUNT(*) AS count
FROM conversation_messages
WHERE direction='outbound'
  AND "createdAt" >= NOW() - INTERVAL '24 hours'
GROUP BY 1,2,3
ORDER BY count DESC;
```

Endpoint debug protegido:

- `GET /debug/ai/audit?limit=20`
- `GET /debug/ai/audit?conversationId=<id>&limit=20`

Script local (sin HTTP):

```bash
npm run dev:test:ai:audit
npm run dev:test:ai:audit -- --conversationId=<id> --limit=20
```

### `GET /metrics`

Devuelve metricas comerciales basicas:

```json
{
  "success": true,
  "data": {
    "totalLeads": 10,
    "totalUrgent": 4,
    "totalCritical": 2,
    "totalAppointmentsAssigned": 3
  }
}
```

### `GET /health`

Health check del servicio.

## Como probar nuevas funciones

### Configuracion en Meta

1. En Meta for Developers abre tu app de WhatsApp.
2. En Webhooks configura:
   - Callback URL: `https://tu-dominio/webhook`
   - Verify token: el mismo valor que `META_VERIFY_TOKEN` en tu `.env`
3. Suscribe el campo `messages`.
4. Usa el token de sistema o permanente como `WHATSAPP_ACCESS_TOKEN`.
5. Configura `WHATSAPP_PHONE_NUMBER_ID` del numero emisor.
6. Para sandbox con numeros AR en allowlist sin `9`:
   - `WHATSAPP_SANDBOX_AR_NORMALIZE=true`
   Para produccion:
   - `WHATSAPP_SANDBOX_AR_NORMALIZE=false` (o omitido)

### Pruebas en Postman

1. Verificacion:
   - `GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=123`
   - Esperado: `200` y body `123`.
2. Mensaje entrante oficial:
   - `POST /webhook` con el JSON de ejemplo de WhatsApp Cloud.
   - Si `VERIFY_SIGNATURE=true`, enviar header `X-Hub-Signature-256` valido y configurar `META_APP_SECRET`.
   - Esperado: procesamiento + envio saliente por Graph API.
3. Envio manual de prueba:
   - `POST /debug/whatsapp/send-test`
   - Header: `x-debug-key: <WHATSAPP_DEBUG_KEY>`
   - Body:
     ```json
     {
       "to": "549XXXXXXXXXX",
       "text": "mensaje"
     }
     ```
   - Esperado: `success=true` y detalle `{ sent, status, data }`.

### Flujo funcional

0. Dar de alta un usuario:
   - `POST /alta` con `name` y `phone`.
   - Copia el `testPayload` de la respuesta.
1. Verifica turnos disponibles en `data/schedule.json`.
2. Envia el `testPayload` (o un lead urgente) a `POST /webhook` y confirma:
   - Se marca un turno como `isAvailable: false` en `data/schedule.json`.
   - Se guarda `assignedAppointment` en `data/patients.json`.
   - La respuesta incluye `appointment` y texto con confirmacion de turno.
3. Ejecuta `GET /metrics` y valida que suban los contadores.
4. Envia un lead no urgente (`low`/`medium`) y valida que no asigne turno.

## Deploy en Render

### Build

- Opcion Docker: usar el `Dockerfile` incluido (multi-stage).
- Opcion Node runtime: `npm install`.

### Start

- Comando: `npm start`

### Healthcheck

- Endpoint: `GET /health`

### Variables de entorno

- `PORT` (Render/Railway la inyectan automaticamente)
- `WHATSAPP_GRAPH_VERSION`
- `WHATSAPP_PHONE_NUMBER_ID`
- `META_VERIFY_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`
- `VERIFY_SIGNATURE`
- `META_APP_SECRET` (obligatoria cuando `VERIFY_SIGNATURE=true`)
- `STORAGE_MODE`
- `WHATSAPP_SANDBOX_AR_NORMALIZE` (solo sandbox; en produccion usar `false`/omitido)
- `WHATSAPP_DEBUG` (poner `true` solo para diagnostico)
- `DEBUG_API_ENABLED` (kill-switch adicional de `/debug/*`, default `false`)
- `DEBUG_UI_ENABLED` (kill-switch adicional de `/debug/ui/inbox`, default `false`)
- `WHATSAPP_DEBUG_KEY` (obligatoria si `WHATSAPP_DEBUG=true`)

### Pasos Render/Railway (URL fija)

1. Crear Web Service apuntando a este repo.
2. Configurar variables de entorno.
3. Start command: `npm start` (si usas Node runtime).
4. Health check path: `/health`.
5. En Meta WhatsApp Webhooks configurar:
   - Callback URL: `https://TU-DOMINIO-FIJO/webhook`
   - Verify Token: mismo valor que `META_VERIFY_TOKEN`
   - Suscribir `messages`.

Quick Tunnel es solo para pruebas y no se usa en produccion.
La compatibilidad con webhook de Meta se mantiene: `GET /webhook` (verificacion) y `POST /webhook` (eventos).

### Cloudflare Tunnel + opturon.com (produccion)

1. Login de Cloudflare:

```powershell
cloudflared tunnel login
```

2. Crear tunnel:

```powershell
cloudflared tunnel create clinicai-api
```

3. Asociar DNS:

```powershell
cloudflared tunnel route dns clinicai-api api.opturon.com
```

4. Configurar `config.yml` (ejemplo):

```yaml
tunnel: <TUNNEL_ID>
credentials-file: C:\Users\<user>\.cloudflared\<TUNNEL_ID>.json

ingress:
  - hostname: api.opturon.com
    service: http://localhost:3001
  - service: http_status:404
```

5. Ejecutar tunnel:

```powershell
cloudflared tunnel run clinicai-api
```

Checklist Meta Webhooks:
- Callback URL: `https://api.opturon.com/webhook`
- Verify token: mismo valor que `META_VERIFY_TOKEN`
- Verificacion challenge:
  - `https://api.opturon.com/webhook?hub.mode=subscribe&hub.verify_token=<TOKEN>&hub.challenge=12345`
  - respuesta esperada: `12345`
- Enviar un webhook real y confirmar `200`.

### Verificacion rapida de webhook

1. Configura `META_VERIFY_TOKEN` con el mismo string de Meta Webhooks (campo "Verify token").
2. Configura `WHATSAPP_ACCESS_TOKEN` con un token permanente de System User (no lo subas a git).
3. Prueba:
   `https://api.opturon.com/webhook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345`
   Esperado: `12345`

### Diagnostico CLI

- Assets visibles por token:
  - `npm run diag:wa:assets`
- Vinculo real entre phone number y WABA accesibles:
  - `npm run diag:wa:asset-link`
- Estado del phone number configurado:
  - `npm run diag:wa:phone`
- Visibilidad y alcance del token actual:
  - `npm run diag:wa:token`
- Suscripcion de app al WABA:
  - `npm run diag:wa:waba`
- Smoke de envio:
  - `npm run diag:wa:smoke -- -To 549XXXXXXXXXX -Text "Ping ClinicAI"`

### Diagnose WhatsApp Phone Asset

Valida desde terminal si el `WHATSAPP_PHONE_NUMBER_ID` configurado:
- existe como asset en Graph
- aparece listado bajo `WHATSAPP_WABA_ID`
- devuelve campos utiles como `display_phone_number`, `verified_name`, y otros campos operativos si Graph los expone

Comando:

```bash
npm run diag:wa:phone
```

Consultas usadas:
- `GET /{WHATSAPP_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name`
- `GET /{WHATSAPP_WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,account_mode,platform_type,status`

La salida muestra:
- configured phone number id
- configured WABA id
- graph asset found / not found
- key fields returned by Graph
- whether the phone number appears under the configured WABA
- likely conclusion

### Diagnose WhatsApp Asset Link

Descubre todos los businesses, WABAs y phone numbers accesibles con el token actual y resalta:
- si el `WHATSAPP_PHONE_NUMBER_ID` configurado aparece bajo algun WABA accesible
- si ese WABA coincide o no con `WHATSAPP_WABA_ID`

Comando:

```bash
npm run diag:wa:asset-link
```

Consultas usadas:
- `GET /{WHATSAPP_PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name`
- `GET /me/businesses?fields=id,name`
- `GET /{BUSINESS_ID}/owned_whatsapp_business_accounts?fields=id,name`
- `GET /{WABA_ID}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,account_mode,platform_type,status`

Este diagnostico sirve para no cambiar `.env` a ciegas:
- si el phone number aparece bajo otro WABA accesible, eso prueba que el `WHATSAPP_WABA_ID` actual es incorrecto
- si el phone number no aparece bajo ningun WABA accesible, eso sugiere que el numero existe pero no esta correctamente attached/registered o el token no ve el WABA correcto

### Diagnose WhatsApp Token Access

Inspecciona la visibilidad del token actual sobre Meta assets.

Comando:

```bash
npm run diag:wa:token
```

Consultas usadas:
- `GET /me?fields=id,name`
- `GET /me/permissions`
- `GET /me/businesses?fields=id,name`
- `GET /{BUSINESS_ID}/owned_whatsapp_business_accounts?fields=id,name`
- `GET /debug_token?input_token=<token>&access_token=<token>` (puede fallar segun el tipo de token/contexto)

Orden recomendado de diagnostico para este caso:
1. `npm run diag:wa:phone`
2. `npm run diag:wa:asset-link`
3. `npm run diag:wa:token`
4. `POST /debug/whatsapp/send-test`
5. `GET /debug/whatsapp/jobs/last?limit=10`

### Diagnose WABA Subscription

Webhook events no llegan si la app no esta suscripta al WhatsApp Business Account (WABA) correcto.

Requiere:
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_WABA_ID`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_API_VERSION` (si falta, el script usa `v22.0`)

Comando:

```bash
npm run diag:wa:waba
```

Salida esperada:
- `Phone Number ID`
- `Display Phone Number`
- `Verified Name`
- `WABA ID`
- `Subscribed Apps`

Si la app no esta suscripta:
- `Subscribing current app to WABA...`
- `Subscription successful`

### Fix DNS 1033/530 (Cloudflare)

Si `https://api.opturon.com/health` devuelve 530/1033 por DNS mal resuelto (por ejemplo `api.opturon.com.com.ar`):

1. Crear/actualizar ruta DNS del tunnel:

```powershell
npm run tunnel:route
```

2. Verificar contra DNS publico de Cloudflare (1.1.1.1):

```powershell
npm run tunnel:verify
```

3. Test final:

```powershell
curl.exe -i https://api.opturon.com/health
```

## Flujo BOT conversacional (auto)

Flujo actual:

1. Inbound de WhatsApp entra por `POST /webhook`.
2. Se persiste completo en `webhook_events`.
3. Se extraen mensajes inbound y se resuelve canal por `phone_number_id`.
4. Se upserta conversación y se inserta inbound en `conversation_messages`.
5. Si el `waMessageId` ya existe (idempotencia), no se encola job ni se responde duplicado.
6. Si es nuevo, se encola job `conversation_reply`.
7. Worker toma el job, decide respuesta con `conversation.engine`, envía WhatsApp y persiste outbound.
8. Se actualiza `state/context` de la conversación.

Turno MVP auto-confirmado:
- Si el paciente elige un horario concreto (o selecciona `1/2/3` desde sugerencias), el worker crea `appointments` con `source='bot'`, marca `appointmentStatus='confirmed'` y confirma por WhatsApp.
- Si hay conflicto de disponibilidad, el worker regenera opciones y vuelve a pedir selección.

## Endpoints debug conversacionales

Con `WHATSAPP_DEBUG=true` y header `x-debug-key`:

- `GET /debug/conversations?limit=50`
- `GET /debug/conversations/:id/messages?limit=100`

## Prueba rápida local del extractor

1. Ajustar en `scripts/dev-test-webhook.json` un `phone_number_id` que exista en `channels.phoneNumberId`.
2. Ejecutar:

```bash
node scripts/dev-test-extract.js
```

Esperado:
- `result.received >= 1`
- `result.enqueued >= 1` en primera ejecución
- `result.duplicates >= 1` si repetís con el mismo `messages[0].id`

## Comandos operativos

```bash
npm run db:migrate
npm run start:prod
npm run worker:prod
npm run prod:up
npm run dev:test:appointments:db
```

Con `WHATSAPP_DEBUG=false`, `DEBUG_API_ENABLED=false` y `DEBUG_UI_ENABLED=false`:
- `/debug/*` queda bloqueado (404).
- `/debug/ui/*` no se sirve.
- `/health` sigue disponible.

## Windows 24/7 (Task Scheduler)

Instalar/actualizar tareas:

```powershell
npm run prod:install-tasks
```

Modo de instalacion:
- PowerShell como Administrador: crea tareas con `RunLevel Highest` y triggers `AtStartup + AtLogOn`.
- PowerShell sin admin: crea tareas por usuario en `OnLogon` (sin `Highest`) como fallback.
- En modo admin, las tareas se registran con `ExecutionTimeLimit = 0` (sin limite) para mantener `cloudflared` corriendo 24/7.

Instala 3 tareas:
- `Odontology API - Server`
- `Odontology API - Worker`
- `Odontology API - Tunnel`

Ejecutar ahora (manual):

```powershell
npm run prod:run-now
```

Verificacion rapida:

```powershell
npm run prod:verify
```

Verificar montaje de debug routes:

```powershell
npm run prod:verify-debug
```

Verificar build/proceso que esta sirviendo trafico:

```powershell
curl.exe -sS https://api.opturon.com/__build
```

Valida:
- health local (`/health`)
- tareas programadas (server + worker)
- logs (`logs/server.log`, `logs/worker.log`)
- DNS publico opcional (`PROD_PUBLIC_HOST`, default `api.opturon.com`)

Exit code:
- `0`: checks criticos OK
- `1`: fallo critico (health down o tareas faltantes/deshabilitadas)

Logs:
- `logs/server.log`
- `logs/worker.log`
- `logs/tunnel.log`
- Rotacion simple incluida: si supera 10MB, se mueve a `*.log.1` al iniciar tarea.

Desinstalar tareas:

```powershell
npm run prod:uninstall-tasks
```

Troubleshooting:
- `npm no encontrado`: usar ruta absoluta de Node/NPM dentro de la tarea (Task Scheduler UI -> Action), por ejemplo `C:\Program Files\nodejs\npm.cmd`.
- `cloudflared no encontrado`: instalar cloudflared o agregarlo al `PATH`.
- Tunnel inestable (`signal terminated`): reinstalar tareas como Administrador para aplicar `ExecutionTimeLimit=0` y restart policy.
- Permisos: si falla el registro/ejecucion, abrir PowerShell como Administrador.
- Verificar estado en Task Scheduler:
  - `Task Scheduler Library` -> `Odontology API - Server`
  - `Task Scheduler Library` -> `Odontology API - Worker`
  - `Task Scheduler Library` -> `Odontology API - Tunnel`
- Para ejecutar sin sesion activa, configurar manualmente en la UI: `Run whether user is logged on or not` y guardar credenciales del usuario de servicio.

### Debug routes en produccion (habilitacion controlada)

```powershell
# 1) Editar .env en la raiz del repo
#    WHATSAPP_DEBUG=true
#    DEBUG_API_ENABLED=true

# 2) Reiniciar tarea del server
schtasks.exe /Run /TN "Odontology API - Server"

# 3) Validar endpoint debug inbox
$k="TU_DEBUG_KEY"
curl.exe -sS -H "x-debug-key: $k" "https://api.opturon.com/debug/inbox/health"
```

Env opcional para tunnel:
- `CLOUDFLARED_TUNNEL_NAME=clinicai-api`

Probar webhook:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3001/webhook" -ContentType "application/json" -InFile "scripts/dev-test-webhook.json"
```

Probar healthcheck:

```powershell
curl.exe -sS http://localhost:3001/health
```

Ver conversaciones:

```powershell
$k="123"
curl.exe -sS -H "x-debug-key: $k" "http://localhost:3001/debug/conversations?limit=20"
```

Ver mensajes de una conversación:

```powershell
$k="123"
curl.exe -sS -H "x-debug-key: $k" "http://localhost:3001/debug/conversations/<conversationId>/messages?limit=100"
```

## Notas de produccion basica

- Incluye `helmet`, `cors`, `morgan` y `express-rate-limit`.
- Firma de Meta opcional via `X-Hub-Signature-256` con `META_APP_SECRET` y `VERIFY_SIGNATURE=true`.
- Rate limit: global laxo + `/webhook` estricto (60 req/min por IP).
- Idempotencia de mensajes entrantes por `messageId` con TTL en memoria de 10 minutos.
- Endpoint debug protegido por `x-debug-key`.
- Si OpenAI falla o no hay API key, usa clasificacion heuristica local.
- Si `STORAGE_MODE=sheets` falla, cae automaticamente a JSON.
- En modo `sheets`, tambien calcula metricas con fallback a JSON si hay error.
