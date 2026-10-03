# BILL-006BC — candidato local completo

Fecha: 2026-10-03. Rama: `fix/billing-provider-contract-v2-final`.
Producción observada por GET `/__build`: `be5b8f8a7d7b147a5f8a9a69659f4007091e1aee`.
No se hicieron push, deploy, migraciones productivas, SQL productivo ni llamadas reales a Mercado Pago.

## Historia y preservación

- WIP original íntegro: stash `f2be38b88fe3014666ad4b1f3a66ccccb101f2c1`.
- Checkpoint adicional de implementación: stash `e69d1f5d6edd83f63c11a930ca8f38e2eac7fef8`.
- M0: `8ed4d96cd21b3a2de5972b5557c1cae691b0afdf` — migración 087 exclusivamente.
- Precursor: `d51bf60658a0e34088256ed9c1029d78e3b884d7`.
- M1: `477d540cc1ed655e225ef60598845953ecdd6914` — migración 088 exclusivamente.
- 6B reconstruido: `27187b160c71875a24be82b90a18389764117add`, fuente `41647d1eee5bd8820ceac04cde086628b833fc18`.
- 6C reconstruido: `e35a1556097b4f1524bd8eaf43c0606b0fe3fa8f`, fuente `13bedaad77dfda0b0287425b148f770e5a788f55`.
- Baseline de tests: `23a0b9eab2fb0f9fd5052ed992115898afdfdef2`, fuente `90add87316c6e43f00080f21f25d18168ed8db77`.
- El commit final es el que introduce este documento; obtener su SHA con `git log -1 --format=%H -- docs/billing-6bc-local-release-candidate.md`.

## Secuencia operativa futura (no ejecutada en producción)

1. Aplicar exclusivamente M0, verificar singleton válido en generación 1.
2. Desplegar el precursor exacto y verificar su SHA antes de activar el cutover.
3. Aplicar exclusivamente M1 y verificar constraints y tablas vacías.
4. Ejecutar dry-run de `scripts/billing/activate-billing-contract-v2-cutover.js`.
5. Con autorización de release, ejecutar `--apply`: la transición a generación 2 es irreversible.
6. Desplegar el candidato final exacto. El runtime final rechaza generación 1.

Después de activar, el único rollback permitido es el precursor
`d51bf60658a0e34088256ed9c1029d78e3b884d7`. Conserva las tablas y la generación 2;
responde 503 antes del INSERT legacy y del proveedor. No ejecutar migration down.
`be5b8f8` y `ffa90f8` quedan prohibidos como rollback posterior al cutover.

## Identidad y autoridad

HMAC valida campos escalares acotados y expone un contexto inmutable registrado en
WeakSet. Su manifiesto normalizado exacto vincula data.id, x-request-id y ts.
`mp:delivery:v1:SHA256(JSON([mercado_pago, delivery:v1, manifiesto]))` usa sólo ese
contexto; el cuerpo no puede fabricarlo. `req.requestId` tampoco sustituye el ID firmado.
payload.id/action/type/topic quedan como metadatos. El helper legacy de dedupe se
mantiene únicamente para fixtures históricos y no se llama desde el ingreso productivo.

El ID firmado se consulta en Payment, invoice, preapproval y plan, en ese orden.
Se prueban todas las clases: ambigüedad produce review; incertidumbre técnica,
retry 503. 404 de una raíz excluye esa clase; 404 de una relación exige retry.
Máximo 7 GETs, sin reintentos ocultos, presupuesto agregado de 15000 ms y AbortController
real. Ninguno de estos GETs ocurre dentro de una transacción DB.

## Efecto y atomicidad

Ledger único por `(provider, effectType, canonicalPaymentId)` y por `effectKey`.
Clave `mp:effect:v1:SHA256(JSON([mercado_pago,billing_payment_applied,Payment.id]))`.
Bindings de suscripción, clínica, tenant, preapproval y collector deben coincidir.
El ledger no contiene payload, payer ni credenciales. Exactly one source: evento o run.

Finalización: CAS UUID del claim → bloqueo compartido del singleton → relectura y
bloqueo de contrato/suscripción/tenant → elegibilidad histórica → INSERT único →
negocio → estado final, dentro de la misma transacción. Un fallo revierte todo.
Un duplicado compatible termina ignored/canonical_effect_already_applied; uno con
binding incompatible termina manual_review/provider_relationship_unproven.

El precursor usa el singleton como barrera de filas: si legacy toma el lock primero,
la activación espera su COMMIT; si gana la activación, legacy no muta. Incluye creación,
recovery, cambios administrativos, refresh y registro del envío del enlace. Sus lecturas
de proveedor en vuelo pueden terminar, pero no habilitan una escritura posterior.

## Historia: decisión de 24 horas

`autoApplyNotBefore=cutoverAt+24h` es una frontera operativa conservadora aceptada,
NO una garantía de reloj documentada por el proveedor. Riesgo residual: se confía en
que Payment.date_created no adelante esa ventana para pagos ya aplicados por legacy.
No se sustituye esa fecha por NOW, date_approved ni date_last_updated.

Se exige ISO con timezone y fecha válida; las comparaciones se hacen en PostgreSQL
sin truncar microsegundos. Una suscripción DB creada después del cutover es elegible
inmediatamente con prueba 6C completa: el precursor no puede crearla después de activar.
Para una suscripción anterior, un Payment antes de la frontera requiere efecto histórico
ya probado o manual_review/legacy_effect_unreconciled. En la frontera o después, puede
aplicarse con prueba completa. Un efecto existente compatible siempre deduplica.

La herramienta `scripts/billing/reconcile-historical-billing-effect.js` usa dry-run por
defecto; `--payment-id`, `--event-id` y `--apply` son explícitos. Sólo GETs al proveedor.
Exige prueba 6C actual y evidencia local histórica correlacionada: evento autenticado
processed previo al cutover, suscripción y tenant con el mismo xmin no congelado y
timestamp SQL exacto, snapshot de pago aprobado/monto/moneda, requestId correlacionado
y snapshot de billing del tenant consistente. Un xmin perdido por mantenimiento o
una fila actualizada después vuelve insuficiente la evidencia. No infiere éxito de raw,
processed o lastPaymentId solos. Inserta un run histórico y el ledger, nunca negocio.

## Reconciliación

Tablas separadas de jobs: reconciliations, reconciliation_runs, effects.
Sólo encola payment_pending, payment_in_process, authorized_invoice_not_found e
invoice_payment_pending, atómicamente con el ACK terminal después de revertir el savepoint.
Rejected/cancelled/review no se reintentan automáticamente.

Primer intento a 5m; backoff x2 (10m tras el primer intento), máximo 6h, 12 intentos y
48h. Claim SKIP LOCKED, lease UUID de 60s, CAS final con lease vigente. Concurrencia
uno por proceso; unicidad/locks protegen también varios procesos. Expiración permite
reclaim y marca el run anterior stale; agotamiento termina manual_review.
El worker usa clasificación, prueba, historia, ledger y ejecutor compartidos con HTTP.
No crea webhooks falsos ni reabre el evento original. Arranque/parada usan el ciclo
existente del worker en un loop independiente, sin bloquear el polling de mensajería.

## Validación y autoauditoría

PostgreSQL 18 aislado, host 127.0.0.1, usuario billing_test, schemas aleatorios por suite.
Proveedor estrictamente simulado; el test de aborto usa sólo HTTP loopback con fetch real.
Se conserva cobertura BILL-001 a BILL-006D y los 56 casos de arquitectura preservada.
Las adaptaciones sólo cambian el contrato de protocolo: fixtures firmadas explícitas,
404 para clases inexistentes y secuencia exacta de probes. Los controles de efectos,
firma, contrato, raw, rollback y razones técnicas permanecen o se refuerzan.

Casos finales adicionales: tamper de id/action/type, tamper antes del cuerpo legítimo,
efecto único cross-topic/delivery/concurrencia, webhook contra worker, rollback sin
ledger fantasma, binding incompatible, frontera histórica, dry-run/backfill probado,
lease/reclaim/CAS/exhaustion, ambigüedad canónica y precursor exacto antes/después del cutover.
La prueba de deadline observa aborto real del body, 0 requests pendientes y 0 escrituras tardías.

Comando completo: `node --test --test-timeout=120000 scripts/tests/saas-billing*.test.js scripts/tests/mercado-pago*.test.js`
(PowerShell expande las rutas mediante Get-ChildItem antes de invocar Node).
Registro local final: `D:/temp/final-6bc-all-tests-final.log`.

Resultado final: **388 PASS / 0 FAIL / 0 SKIP**, en 13 archivos de suite.
Incluye 37 casos de seguridad V2 (38 contando su contenedor) y 5 casos de
cutover (6 contando su contenedor). Reconciliación cubre enqueue, progreso,
carrera webhook/worker, reclaim, CAS vencido, backoff y agotamiento. Los helpers
de retry de arquitectura, routing y contrato exigen la razón técnica exacta,
además del formato válido del marcador y cero mutaciones.

`node --check`: PASS en los 26 archivos JS nuevos/modificados respecto al bridge.
`git diff --check`: PASS para el diff de trabajo y el rango completo del release.
Autoauditoría final completada, sin bloqueantes conocidos; no se debilitaron
assertions de negocio. El resultado es un candidato local: no está publicado
ni desplegado y las migraciones sólo se aplicaron a schemas PostgreSQL locales.
