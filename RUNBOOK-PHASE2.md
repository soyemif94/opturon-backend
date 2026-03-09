# RUNBOOK-PHASE2 - Leads + Calendar + Handoff (Multi-tenant)

## 1) Objetivo

Phase 2 agrega producto SaaS sin UI:
- pipeline de leads por clinica
- slots/calendario por clinica
- booking/cancelacion de turnos
- handoff humano con pausa de bot
- operacion por endpoints debug protegidos

Todo sigue multi-tenant por `clinicId` y por ruteo de `channels.phoneNumberId`.

## 2) Prerrequisitos

- Node.js LTS
- PostgreSQL 14+
- `.env` con:
  - `DATABASE_URL`
  - `WHATSAPP_ACCESS_TOKEN`
  - `WHATSAPP_PHONE_NUMBER_ID`
  - `META_VERIFY_TOKEN`
  - `WHATSAPP_DEBUG=true`
  - `WHATSAPP_DEBUG_KEY=TU_KEY`

Opcionales nuevos:
- `DEFAULT_APPOINTMENT_DAYS_AHEAD=7`
- `DEFAULT_HOLD_MINUTES=10`

## 3) Instalacion + Migraciones

```powershell
npm install
npm run db:migrate
```

Migraciones clave:
- `001_phase1_multitenant.sql`
- `002_phase1_1_hardening.sql`
- `003_phase2_leads_calendar_handoff.sql`

## 4) Seed (clinic + channel + calendar_rules + staff)

```powershell
$Env:SEED_CLINIC_NAME="Clinica Demo"
$Env:SEED_PHONE_NUMBER_ID="TU_PHONE_NUMBER_ID_REAL"
$Env:SEED_WABA_ID=""            # opcional
$Env:SEED_ACCESS_TOKEN=""       # opcional
$Env:SEED_STAFF_NAME="Recepcion"
npm run db:seed
```

## 5) Levantar API + worker

Terminal 1:
```powershell
npm run start:prod
```

Terminal 2:
```powershell
npm run worker
```

Escalar workers:
```powershell
$Env:WORKER_ID="worker-2"; npm run worker
$Env:WORKER_ID="worker-3"; npm run worker
```

## 6) Obtener clinicId para pruebas

```sql
SELECT id, name FROM clinics ORDER BY "createdAt" DESC LIMIT 5;
```

## 7) Endpoints debug operativos

Todas las llamadas requieren:
```powershell
$k="TU_DEBUG_KEY"
```

### 7.1 Generar slots proximos 7 dias

```powershell
curl.exe -sS -X POST `
  -H "Content-Type: application/json" `
  -H "x-debug-key: $k" `
  -d "{\"from\":\"2026-03-01T00:00:00Z\",\"to\":\"2026-03-08T00:00:00Z\"}" `
  http://localhost:3001/debug/clinics/CLINIC_ID/calendar/generate
```

### 7.2 Ver slots disponibles

```powershell
curl.exe -sS -H "x-debug-key: $k" "http://localhost:3001/debug/clinics/CLINIC_ID/calendar/available?limit=5"
```

### 7.3 Ver leads

```powershell
curl.exe -sS -H "x-debug-key: $k" "http://localhost:3001/debug/clinics/CLINIC_ID/leads?limit=50"
```

### 7.4 Ver appointments

```powershell
curl.exe -sS -H "x-debug-key: $k" "http://localhost:3001/debug/clinics/CLINIC_ID/appointments?from=2026-03-01T00:00:00Z&to=2026-03-10T00:00:00Z"
```

### 7.5 Snapshot de conversacion

```powershell
curl.exe -sS -H "x-debug-key: $k" "http://localhost:3001/debug/clinics/CLINIC_ID/conversations/CONVERSATION_ID"
```

### 7.6 Asignar handoff

```powershell
curl.exe -sS -X POST `
  -H "Content-Type: application/json" `
  -H "x-debug-key: $k" `
  -d "{\"staffUserId\":\"STAFF_USER_ID\"}" `
  http://localhost:3001/debug/clinics/CLINIC_ID/handoff/CONVERSATION_ID/assign
```

## 8) Flujo appointment (validacion obligatoria)

### Caso A: "Necesito un turno"

Esperado:
- lead creado/actualizado
- `lead.status` -> `offering`
- evento `SLOT_OFFERED`
- respuesta outbound con 3-5 opciones

### Caso B: "1"

Esperado:
- toma `SLOT_OFFERED` reciente
- `calendar_slots.status` -> `booked`
- `appointments` creado
- `leads.status` -> `confirmed`
- eventos: `SLOT_HELD`, `APPOINTMENT_BOOKED`

## 9) Flujo urgencia / handoff (validacion obligatoria)

Mensaje: "tengo dolor urgente"

Esperado:
- handoff abierto (`handoff_requests.status=open|assigned`)
- `conversations.status=needs_human`
- `leads.status=handoff`
- evento `HANDOFF_OPENED`
- respuesta de derivacion

## 10) SQL de verificacion

```sql
-- Leads por clinica
SELECT id, "conversationId", status, "primaryIntent", "assignedTo", "updatedAt"
FROM leads
WHERE "clinicId" = 'CLINIC_ID'
ORDER BY "updatedAt" DESC;

-- Eventos de conversacion
SELECT type, data, "createdAt"
FROM conversation_events
WHERE "clinicId" = 'CLINIC_ID' AND "conversationId" = 'CONVERSATION_ID'
ORDER BY "createdAt" DESC;

-- Slots
SELECT id, status, "startsAt", "endsAt", "heldUntil", "heldByConversationId", "bookedByLeadId"
FROM calendar_slots
WHERE "clinicId" = 'CLINIC_ID'
ORDER BY "startsAt" ASC
LIMIT 100;

-- Appointments
SELECT id, status, "leadId", "conversationId", "contactId", "slotId", "updatedAt"
FROM appointments
WHERE "clinicId" = 'CLINIC_ID'
ORDER BY "createdAt" DESC;

-- Handoffs
SELECT id, status, reason, "assignedTo", "conversationId", "updatedAt"
FROM handoff_requests
WHERE "clinicId" = 'CLINIC_ID'
ORDER BY "createdAt" DESC;
```

## 11) Notas de operacion

- Webhook siempre responde `200` (Meta), incluso con fallas internas.
- Si firma es invalida, se corta con `200` y queda registro en `inbound_failures`.
- Si `contact.optedOut=true`, el worker no responde ni agenda.
- Si hay handoff abierto para la conversacion, el bot se pausa.
