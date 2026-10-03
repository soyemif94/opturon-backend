# BILL-006BC: registro histórico de la arquitectura preservada

Este documento registra el WIP del 2 de octubre, anterior al rediseño final.
Sus reglas de identidad y rollback fueron sustituidas por
`billing-6bc-local-release-candidate.md`. En particular, be5b8f8 NO es un destino
admitido después del cutover; corresponde usar el precursor allí identificado.

Fecha: 2026-10-02. Base local: `90add87316c6e43f00080f21f25d18168ed8db77`.
Rama: `fix/billing-provider-contract-v2`.
Producción y único rollback admitido: `be5b8f8a7d7b147a5f8a9a69659f4007091e1aee` (bridge).
No se modifica el parser del bridge, la política de activación, BILL-007/008 ni el esquema.

## Ownership y transacciones

1. **Claim**: BEGIN, `SET LOCAL lock_timeout='1000ms'`,
   `SET LOCAL statement_timeout='2000ms'`, INSERT/ON CONFLICT, SELECT FOR UPDATE,
   terminal/fresh/stale, UPDATE de claim y COMMIT. El timeout incluye la espera del INSERT.
2. **Proveedor**: todas las lecturas HTTP después del COMMIT. Un solo presupuesto de
   15000 ms para toda la secuencia, compartiendo AbortSignal entre Payment, search,
   invoice y preapproval. El signal también cancela la lectura del body de fetch.
   Se realiza validación preliminar con lecturas locales sin transacción ni FOR UPDATE.
3. **Finalización**: transacción corta con los mismos límites SQL; SELECT FOR UPDATE
   restringido por `id AND dedupeKey AND processingStatus='processing' AND processingError=exactClaim`.
   Se vuelven a leer y bloquear subscription/tenant, y se revalida el contrato nativo.
   La actualización de negocio y el resultado del evento se confirman juntos.
   El UPDATE de resultado también compara el claim exacto. Un CAS sin fila no llama al aplicador.

Claim: `billing_contract_v2:claim:<randomUUID-v4-lowercase>:claim_active`.
Stale: 30000 ms, comparados en PostgreSQL contra `updatedAt`; nunca se convierte una fecha JS
en token de ownership. Un timestamp ausente no prueba staleness.
`received` y `failed` pueden reclamar un UUID nuevo; `processing` requiere staleness,
tanto si su marcador es válido como si es histórico/sin marcador.
Un duplicado activo devuelve 503 sin GETs, UPDATE de evento ni mutaciones comerciales.

Cada error técnico después de reclamar conserva el mismo UUID:
timeout → `provider_timeout`; red/lectura incompleta → `provider_network_error`;
5xx → `provider_5xx`; 404 → `provider_not_found`; error de finalización DB → `db_retryable`.
La persistencia del error tiene su propia transacción corta y CAS. Si no puede escribirse,
queda el `claim_active` durable. Un worker obsoleto tampoco puede escribir un fallo encima
del resultado de su reemplazo. No se persisten mensajes crudos de errores externos.

El presupuesto de 15000 ms limita la fase del proveedor, no el HTTP completo incluyendo DB.
Los límites SQL son por statement/espera de lock. El pool conserva su timeout de conexión
preexistente de 10000 ms. Ningún GET usa una conexión DB o un lock de evento mientras espera.

## ACK normales y decisiones de contrato

| Evidencia canónica | Resultado durable | HTTP |
| --- | --- | --- |
| pending | ignored / payment_pending / contractOutcome NULL | 200 |
| in_process | ignored / payment_in_process / NULL | 200 |
| rejected | ignored / payment_rejected / NULL | 200 |
| cancelled, canceled | ignored / payment_cancelled o payment_canceled / NULL | 200 |
| authorized, in_mediation | ignored / payment_authorized o payment_in_mediation / NULL | 200 |
| Invoice sin payment | ignored / invoice_payment_pending / NULL | 200 |
| Search válido sin resultados | ignored / authorized_invoice_not_found / NULL | 200 |
| subscription_preapproval_plan | ignored / preapproval_plan_unsupported / NULL | 200 |
| Falta identidad de notificación | ignored / notification_identity_missing / NULL | 200 |
| Tipo no soportado | ignored / unsupported_event / NULL | 200 |
| refunded, charged_back, estado futuro desconocido | ignored / manual_review / unsupported_charge_type | 200 |
| Contradicción de contrato probada | ignored / contract_rejected en contractOutcome | 200 |
| Evidencia incompleta/ambigua | ignored / manual_review en contractOutcome | 200 |
| Fallo técnico | failed + marcador v2, o claim_active si DB impide escribir el fallo | 503 |

Los resultados normales son terminales para esa notificación. No intentan polling mediante
503. `raw` permanece intacto y `metadata.contract` no se reconstruye ni se sobrescribe.
Un savepoint descarta trabajo especulativo antes de guardar outcomes/no-action;
si falla la finalización, también se revierten los cambios comerciales y de tenant.
El alias `authorized_payment` sigue usando la misma validación completa de invoice.

## Identidad de notificación y límite de confianza

Se verificaron el controller real, el parser y los fixtures HTTP con firma:
`payload.id` es notificationId; `payload.data.id` identifica el recurso.
La deduplicación conserva `topic:action:resourceId:notification:notificationId`.
El parser admite string alfanumérico/guion/underscore de 1–128 caracteres o número entero seguro;
rechaza objetos, arrays, fracciones y valores vacíos, sin coerción de objetos.
El fallback sin notificationId sólo puede guardar no-action, nunca autorizar facturación.
Una futura notificación válida tiene otro dedupeKey y vuelve a pasar el gate 6C.
Las pruebas N1=100 pending / N2=101 approved verifican dos eventos y una aplicación comercial.

La confianza es la del envelope admitido **después de BILL-002**. El manifiesto HMAC existente
cubre el ID de recurso de query, x-request-id y ts; no firma separadamente el `payload.id`.
No se afirma una garantía criptográfica adicional sobre ese campo, ni se utiliza como prueba
financiera. Se mantiene la semántica de notificaciones soportada y el gate canónico completo;
no se agregan fallbacks basados en timestamps, cabeceras arbitrarias o datos del pagador.
No se certificó tráfico real de Mercado Pago en esta tarea: todas las entregas son fixtures locales.

## Search y unicidad

Consulta explícita: `payment_id=<canonicalPaymentId>&offset=0&limit=2`.
La [referencia del endpoint](https://www.mercadopago.com.ar/developers/es/reference/online-payments/subscriptions/authorized-payment-search/get)
documenta el filtro de Payment y paging; el [SDK oficial de Mercado Pago](https://pkg.go.dev/github.com/mercadopago/sdk-go/pkg/invoice#SearchRequest)
expone Offset/Limit y filtros para authorized invoices.

- Se exige results array, total entero no negativo y offset exactamente 0.
- Si limit está presente, debe ser entero positivo y cubrir la cantidad devuelta.
- Sólo una fila y total=1 permiten considerar un candidato.
- Cero filas y total=0 constituyen zero-match; datos débiles que parezcan de Opturon no cambian esta regla.
- Cero filas con total>0, total ausente, offset ausente/no-cero o total>1 producen review.
- El ID Payment del candidato debe coincidir; después se obtiene y valida la invoice canónica.
- Zero-match no prueba ausencia de relación para siempre: una nueva notificación puede procesarse.

## Evidencia local y regresión

PostgreSQL 18 aislado en loopback, rol billing_test, schemas desechables por suite.
No se usaron credenciales productivas. Se interceptó cada acceso al proveedor; las escrituras
MP están prohibidas por los harnesses. La prueba de cancelación utiliza un servidor HTTP local
con el transporte real fetch y la implementación real del servicio MP.

Corrida completa: **344 PASS / 0 FAIL / 0 SKIP**, desde la base de 288.
La suite nueva agrega **55 casos + 1 contenedor** (56 entradas del reporte).

| Casos | Evidencia |
| --- | --- |
| A | Claim visible desde conexión independiente antes de cada GET |
| B | pg_stat_activity sin xact_start activo + FOR UPDATE NOWAIT libre durante el GET |
| C | Duplicado activo 503, cero GET adicionales y cero mutaciones |
| D | UUID-B distinto; CAS UUID-A devuelve cero filas; resultado B intacto |
| E–F | V2 reintenta failed con UUID nuevo; código original del bridge bloquea la misma fila |
| G | INSERT en contención limitado: 1074 ms en corrida final; máximo observado entre corridas 1166 ms |
| H | Tres lecturas secuenciales demoradas: aborto real del body a 15058 ms, 1 cierre, 0 requests pendientes, 0 mutaciones tardías/rechazos no manejados |
| I–L | pending/in_process/rejected/cancelled → ACK durable sin negocio |
| M | N1/N2 del mismo Payment → dos eventos y una aplicación |
| N, U | Cero resultados coherentes → ACK, NULL outcome, redelivery sin refetch |
| O–P | Search timeout/5xx conserva UUID con razón técnica; también red y 404 |
| Q–W | Paginación completa/ambigua/contradictoria y revalidación Payment/invoice |
| X–AC | Cadena válida, amount/currency/cadence, evidencia ausente y tenant contradictorio |
| AD | Refund/chargeback/desconocido sin aplicación de éxito ni reversión BILL-007 |
| AE–AG | Payload no crea marker, marker inválido no omite prueba, firma inválida 401 antes de claim |
| AH–AI | Terminales intactos; failed y processing v2 bloqueados por el bridge original |
| Adicionales | Identidad inválida, historical processing fresh/stale, binding modificado tras lectura preliminar, rollback del ACK, fallo tardío de A y bridge durante un claim real activo |

La simulación de rollback compila en memoria el archivo del bridge en el SHA exacto con
`git show`, sin checkout y sin reemplazar el runtime de la rama. No compara contra ffa90f.

Las suites previas se adaptaron únicamente donde cambió el contrato de procesamiento:
fixtures de search ahora incluyen offset; ACK normales sustituyen 503; concurrencia activa
admite 503; inyecciones COMMIT apuntan a finalización, no a la nueva transacción de claim;
fallo al persistir un error conserva claim_active y requiere stale recovery.
Las aserciones financieras, firma, raw, contrato inmutable y rollback de negocio se conservan.

Comando de regresión (NODE_PATH apunta a las dependencias locales ya instaladas y
BILLING_TEST_DATABASE_URL al cluster aislado):

```text
node --test --test-reporter=tap
  scripts/tests/mercado-pago-diagnostics-readonly.test.js
  scripts/tests/mercado-pago-webhook-signature-enforcement.test.js
  scripts/tests/saas-billing-durable-provisioning.test.js
  scripts/tests/saas-billing-webhook-retry.test.js
  scripts/tests/saas-billing-contract.test.js
  scripts/tests/saas-billing-contract-postgres.test.js
  scripts/tests/saas-billing-contract-outcomes.test.js
  scripts/tests/saas-billing-rollback-bridge.test.js
  scripts/tests/saas-billing-resource-routing.test.js
  scripts/tests/saas-billing-provider-contract.test.js
  scripts/tests/saas-billing-webhook-architecture.test.js
```

TAP local: `D:/temp/billing-architecture-final.tap`.
Sin commit, push, deploy, migraciones productivas, mutaciones DB productivas ni requests MP reales.
