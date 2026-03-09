# RUNBOOK-PHASE1.1 - Hardening Multi-tenant + DB Queue

## 1) Prerrequisitos

- Node.js LTS
- PostgreSQL 14+
- Variables en `.env`:
  - `DATABASE_URL`
  - `META_VERIFY_TOKEN`
  - `WHATSAPP_ACCESS_TOKEN` (fallback si `channels.accessToken` es null)
  - `WHATSAPP_PHONE_NUMBER_ID` (fallback para envíos salientes)
  - `WORKER_ID` (ej: `worker-1`)
  - `WORKER_POLL_MS` (default `1000`)
  - `WORKER_BATCH_SIZE` (default `10`)
  - `WHATSAPP_DEBUG=true` + `WHATSAPP_DEBUG_KEY` para usar endpoints `/debug/*`

## 2) Instalación

```powershell
npm install
npm run db:init
npm run db:migrate
npm run db:seed
```

## 3) Inicializar DB + Migraciones

```powershell
npm run db:init
npm run db:migrate
```

Incluye:
- `001_phase1_multitenant.sql`
- `002_phase1_1_hardening.sql` (`inbound_failures`, índices, constraints)

## 4) Seed / Onboarding rápido

Configurar variables seed (PowerShell):

```powershell
$Env:SEED_CLINIC_NAME="Clinica Demo"
$Env:SEED_PHONE_NUMBER_ID="TU_PHONE_NUMBER_ID"
$Env:SEED_WABA_ID="TU_WABA_ID"   # opcional
$Env:SEED_ACCESS_TOKEN=""         # opcional
npm run db:seed
```

Verificar en DB:

```sql
SELECT id, name, "createdAt" FROM clinics ORDER BY "createdAt" DESC LIMIT 5;
SELECT id, "clinicId", "phoneNumberId", status FROM channels ORDER BY "createdAt" DESC LIMIT 5;
```

## 5) Levantar API y Worker

Terminal 1:
```powershell
npm run start:prod
```

Terminal 2:
```powershell
npm run worker
```

Para escalar workers (múltiples procesos):

```powershell
$Env:WORKER_ID="worker-2"; npm run worker
$Env:WORKER_ID="worker-3"; npm run worker
```

`SKIP LOCKED` evita que dos workers tomen el mismo job.

## 6) Validaciones obligatorias

### 6.1 Health

```powershell
curl.exe -sS http://localhost:3001/health
```

Esperado: `200` con `{ "ok": true, ... }`.

### 6.2 Webhook verify (Meta challenge)

```powershell
curl.exe -sS "http://localhost:3001/webhook?hub.mode=subscribe&hub.verify_token=TU_META_VERIFY_TOKEN&hub.challenge=12345"
```

Esperado: `12345`.

### 6.3 Webhook unrouted (phone_number_id no existente)

Guardar `sample-unrouted.json`:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_DEMO",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": {
              "phone_number_id": "PHONE_NUMBER_ID_NO_EXISTE"
            },
            "contacts": [
              {
                "wa_id": "5491122233344",
                "profile": { "name": "Paciente Unrouted" }
              }
            ],
            "messages": [
              {
                "from": "5491122233344",
                "id": "wamid.UNROUTED.001",
                "type": "text",
                "text": { "body": "hola" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

Enviar:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/webhook' -ContentType 'application/json' -InFile .\sample-unrouted.json
```

Esperado:
- HTTP `200`
- `unrouted` incrementa
- fila en `inbound_failures` con `reason='UNROUTED_CHANNEL'`

Verificar:

```sql
SELECT reason, "phoneNumberId", "providerMessageId", "requestId", "receivedAt"
FROM inbound_failures
ORDER BY "receivedAt" DESC
LIMIT 20;
```

### 6.4 Firma inválida (sin procesar payload)

Requiere `.env`: `VERIFY_SIGNATURE=true` y `META_APP_SECRET` válido.

Enviar firma inválida:

```powershell
curl.exe -i -X POST "http://localhost:3001/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=deadbeef" -d "{\"entry\":[] }"
```

Esperado:
- HTTP `200`
- request se corta en middleware (no llega al handler)
- NO inserta `messages` ni `jobs`
- inserta `inbound_failures` con `reason='INVALID_SIGNATURE'`

### 6.5 Happy path

Guardar `sample-happy.json` con `phone_number_id` existente en `channels`:

```json
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "WABA_DEMO",
      "changes": [
        {
          "field": "messages",
          "value": {
            "metadata": {
              "phone_number_id": "TU_PHONE_NUMBER_ID"
            },
            "contacts": [
              {
                "wa_id": "5491122233344",
                "profile": { "name": "Paciente Demo" }
              }
            ],
            "messages": [
              {
                "from": "5491122233344",
                "id": "wamid.HAPPY.001",
                "type": "text",
                "text": { "body": "Necesito un turno" }
              }
            ]
          }
        }
      ]
    }
  ]
}
```

Enviar:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/webhook' -ContentType 'application/json' -InFile .\sample-happy.json
```

Esperado:
- HTTP `200`
- `messages` inbound insertado (o dedupe si repite `providerMessageId`)
- `jobs` encolado
- worker procesa y pasa a `done`

Verificar:

```sql
SELECT direction, "providerMessageId", "clinicId", "channelId", body, "receivedAt"
FROM messages
ORDER BY "receivedAt" DESC
LIMIT 20;

SELECT id, type, status, attempts, "runAt", "lockedBy", "lastError", "createdAt"
FROM jobs
ORDER BY "createdAt" DESC
LIMIT 20;
```

## 7) Endpoint debug para failures (protegido)

Solo si `WHATSAPP_DEBUG=true` y `x-debug-key` correcto:

```powershell
$k="TU_DEBUG_KEY"
curl.exe -sS -H "x-debug-key: $k" "http://localhost:3001/debug/whatsapp/failures?limit=50"
```

## 8) Garantías de esta fase

- Webhook responde `200` siempre, incluso con errores internos.
- Persistencia + encolado en transacción atómica.
- Idempotencia DB por `messages(clinicId, providerMessageId)`.
- Multi-tenant por `channels.phoneNumberId`.
- Registro explícito de fallas inbound en `inbound_failures`.
- Worker escalable con `SKIP LOCKED`, `WORKER_BATCH_SIZE`, `WORKER_POLL_MS` y shutdown graceful.

