# RUNBOOK - ClinicAI Systems

## Startup

1. Configurar `.env` (required):
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `META_VERIFY_TOKEN`

2. Iniciar:
```powershell
npm install
npm run start:prod
```

3. Validar salud:
```powershell
curl.exe -sS http://localhost:3001/health
```

4. Validar webhook challenge:
```powershell
curl.exe -sS "http://localhost:3001/webhook?hub.mode=subscribe&hub.verify_token=TU_META_VERIFY_TOKEN&hub.challenge=12345"
```

## Debug Endpoints

Requisitos:
- `WHATSAPP_DEBUG=true`
- `WHATSAPP_DEBUG_KEY=<secret>`

Si el header no coincide (`x-debug-key`), la API responde `404`.

```powershell
$k="TU_DEBUG_KEY"
curl.exe -sS -H "x-debug-key: $k" http://localhost:3001/debug/whatsapp/config
curl.exe -sS -H "x-debug-key: $k" http://localhost:3001/debug/whatsapp/assets
curl.exe -sS -H "x-debug-key: $k" http://localhost:3001/debug/whatsapp/autofix
curl.exe -sS -X POST -H "Content-Type: application/json" -H "x-debug-key: $k" -d "{\"to\":\"54911XXXXXXXX\",\"text\":\"Ping debug\"}" http://localhost:3001/debug/whatsapp/send-test
```

## Smoke Tests

Diagnostico de assets:
```powershell
$Env:WHATSAPP_ACCESS_TOKEN="TU_TOKEN"
$Env:WHATSAPP_PHONE_NUMBER_ID="TU_PHONE_NUMBER_ID"
npm run diag:wa:assets
```

Smoke de envio directo:
```powershell
npm run diag:wa:smoke -- -To 54911XXXXXXXX -Text "Ping ClinicAI"
```

## ERROR 100 / 33 RESOLUTION

`Unsupported post request` en WhatsApp Cloud API casi siempre implica ID/token incorrecto.

### Step 1
Ejecutar:
```powershell
npm run diag:wa:assets
```

Si hay `phoneNumbers`:
- usar ese valor en `WHATSAPP_PHONE_NUMBER_ID`
- reiniciar servidor
 - opcional auto-fix:
   ```powershell
   curl.exe -sS -H "x-debug-key: TU_DEBUG_KEY" http://localhost:3001/debug/whatsapp/autofix
   ```
   Si `.env` existe y hay mismatch, se actualiza automaticamente `WHATSAPP_PHONE_NUMBER_ID`.

### Step 2
Ejecutar:
```powershell
npm run diag:wa:smoke -- -To 54911XXXXXXXX -Text "Ping ClinicAI"
```

Si responde 200: fix aplicado.

Si no hay `phoneNumbers`:
- el System User no tiene asset WABA/phone number asignado
- o el token pertenece a otro business/app
- asignar activo correcto en Meta Business Settings y regenerar token

## Produccion Checklist

- Cloudflare Tunnel activo: `api.opturon.com -> localhost:3001`
- `/health` responde 200
- `WHATSAPP_PHONE_NUMBER_ID` confirmado desde assets discovery
- webhook suscrito a `messages`
- logs incluyen `requestId`, `graphPath`, `status`, `durationMs`, `fbtrace_id`
- webhook responde 200 a Meta aunque falle envio (no cae el proceso)
