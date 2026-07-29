# INVENTORY.LOTS.EXPIRATIONS.LOCATIONS.REVIEW.1C

Estado objetivo alcanzado localmente: `CORREGIDO - LISTO PARA PREDEPLOY`

No se aplicaron migraciones.
No se hizo deploy.
No se ejecutaron backfills con escrituras.
No se ejecutaron scripts contra producción.
No se modificaron datos productivos.

## 1. Estado Git inicial confirmado

Backend base:
- rama: `main`
- `HEAD`: `baa46c4e2fc39319bdbb4bd9c156d1da52272268`
- `origin/main`: `baa46c4e2fc39319bdbb4bd9c156d1da52272268`

Frontend base:
- rama: `tenant-operating-profile-controls`
- `HEAD`: `133595c80743cc1c909ecb4aaec113c813e0b9c8`
- `origin/main`: `133595c80743cc1c909ecb4aaec113c813e0b9c8`

## 2. Identidad física del lote

Identidad funcional vigente:
- tenant
- product
- normalizedLotNumber
- locationId
- expirationDate

Resolución aplicada:
- `findPhysicalInventoryLot(...)` usa `locationId IS NOT DISTINCT FROM $3::uuid` y `expiresAt IS NOT DISTINCT FROM $5::date`.
- `findConflictingInventoryLot(...)` usa la misma comparación nula-segura para `locationId`.
- la búsqueda siempre normaliza `lotNumber` con `normalizeLotNumber(...)`.

Consecuencia:
- exact match: mismo tenant/product/lote normalizado/location/expiration, incluso `NULL` vs `NULL`, reutiliza el lote físico;
- physical conflict: mismo tenant/product/lote normalizado/location pero expiration distinta, incluso `NULL` vs fecha y fecha vs `NULL`, devuelve `inventory_lot_conflict_requires_new_physical_lot`.

Diseño recomendado para unique futuro:
- PostgreSQL 15+: `UNIQUE NULLS NOT DISTINCT ("tenantId","productId","normalizedLotNumber","locationId","expiresAt")`.

No implementado todavía en 067 por pedido.

## 3. Fórmulas exactas de stock

Por lote:
- `physicalQuantity = 0` si display status es `written_off` o `cancelled`; en cualquier otro caso `physicalQuantity = availableQuantity`.
- `committedQuantity = SUM(inventory_lot_allocations.quantity WHERE status='allocated')`.
- `availableCommercialQuantity = max(0, availableQuantity - committedQuantity)` sólo si el lote está comercialmente disponible.

Un lote es comercialmente disponible sólo si:
- display status = `active`;
- no está vencido;
- `availableQuantity > 0`.

Entonces `availableCommercialQuantity` excluye:
- `blocked`
- `written_off`
- `cancelled`
- `expired`
- y resta `committedQuantity` una sola vez

Semántica de `products.stock`:
- sigue representando stock comercial agregado del producto en modo `lot_based`;
- se sincroniza sumando sólo lotes no cancelados, con `operationalStatus = active`, stock positivo y no vencidos;
- se persiste con `Math.floor(...)`, igual que antes.

## 4. Writeoff con stock comprometido

Política cerrada:
- no se permite writeoff que invada stock comprometido;
- máximo writeoff permitido = `availableQuantity - committedQuantity`;
- si el lote tiene compromisos, writeoff total queda bloqueado;
- error estable: `inventory_lot_writeoff_conflicts_with_committed_stock`.

No se liberan allocations automáticamente.
No se cancelan pedidos.
No se mutan compromisos en silencio.

## 5. Cancelación y reintegro

Política cerrada:
- lote `active` vigente: reintegra y vuelve comercialmente disponible;
- lote `blocked`: reintegra físicamente y conserva `blocked`;
- lote `expired`: reintegra físicamente y sigue sin disponibilidad comercial por vencimiento;
- lote `written_off`: rechaza con `inventory_lot_restore_requires_manual_review`;
- lote `cancelled`: rechaza con `inventory_lot_restore_requires_manual_review`.

La restauración preserva el estado histórico cuando corresponde:
- `quarantined` sigue `quarantined`;
- `expired` legacy sigue `expired`;
- `depleted` vuelve a `active` si recupera cantidad.

La transición sigue siendo atómica:
- si una allocation del pedido exige revisión manual, la transacción completa hace rollback;
- no queda el pedido cancelado con stock parcialmente restaurado.

## 6. Idempotencia concurrente real

Resolución aplicada:
- `inventory_lot_operations` usa `INSERT ... ON CONFLICT ("tenantId","operationType","idempotencyKey") DO NOTHING RETURNING *`;
- si pierde la carrera, relee la operación existente con `FOR UPDATE`;
- la segunda request reutiliza el resultado persistido y no vuelve a mutar.

Cobertura agregada:
- receipt por misma key;
- writeoff comprometido;
- `block` concurrente con mismo idempotency key;
- misma operación reutilizada devuelve `idempotent: true`;
- una sola mutación y una sola auditoría.

## 7. Permisos

Backend:
- receipt de lote: `owner|manager|seller`;
- acciones sensibles: `owner|manager`;
- `opturon_admin` no opera por accidente como tenant cliente;
- el middleware no confía en `x-portal-actor-role` enviado por navegador;
- resuelve actor real con `x-portal-actor-id` + lookup backend + chequeo de tenant.

Frontend / Next API:
- permiso `manage_inventory_receipts` separado de `manage_inventory_sensitive`;
- seller puede ver y ejecutar ingreso de lotes;
- seller no ve `block`, `unblock`, `writeoff`, `editar vencimiento`, `locations`, `settings`;
- owner/manager mantienen acciones sensibles;
- backend sigue siendo la autoridad final.

## 8. Política de estados

Precedencia de display consolidada:
1. `cancelled`
2. `written_off`
3. `blocked`
4. `depleted`
5. `active`

Vencimiento separado en:
- `expired`
- `today`
- `critical`
- `urgent`
- `warning`
- `upcoming`
- `normal`
- `no_expiration`

Guards añadidos:
- `written_off` con cantidad positiva;
- metadata de bloqueo sin estado `blocked`;
- metadata de writeoff con estado `active`;
- `blocked` con cantidad cero;
- `quarantined` legacy sin mapping a `blocked`.

## 9. Auditoría migración 067

La migración:
- agrega `locationId UUID NULL`;
- agrega `normalizedLotNumber TEXT NULL`;
- mantiene ambas columnas nullable;
- agrega FK compuesta `("locationId","tenantId") -> inventory_locations(id,"tenantId")`;
- agrega índices no únicos de tenant/location y de búsqueda por lote;
- no agrega unique definitivo;
- no hace backfill;
- no asigna `Principal`;
- no elimina texto histórico.

Compatibilidad:
- segura para datos existentes porque columnas nuevas son nullable;
- tenant consistency queda protegida por FK compuesta;
- `inventory_locations(id,"tenantId")` ya tiene índice único desde 065.

## 10. Auditoría migración 068

La migración:
- agrega `operationalStatus TEXT NULL`;
- agrega columnas de bloqueo y writeoff nullable;
- agrega `CHECK` sobre `active|blocked|written_off`;
- no hace `UPDATE` masivo;
- no fuerza `DEFAULT 'active'` a filas históricas.

Compatibilidad:
- estados legacy `cancelled` y `quarantined` siguen interpretándose por lógica de aplicación;
- no reescribe filas viejas.

## 11. Auditoría migración 069

La migración:
- crea `inventory_lot_operations`;
- `id` UUID PK;
- FK a `clinics`;
- FK compuesta a `products`;
- FK compuesta a `inventory_lots`;
- `idempotencyKey TEXT NOT NULL`;
- `status` con check `pending|processing|completed|partially_completed|failed`;
- check de `operationType` no vacío;
- check de `idempotencyKey` no vacío;
- `requestMetadata JSONB`;
- `result JSONB`;
- `createdBy`, `createdAt`, `completedAt`, `failureCode`;
- unique `("tenantId","operationType","idempotencyKey")`.

Persistencia:
- `requestMetadata` y `result` quedan sanitizados por whitelists de servicio;
- no se persisten cookies, tokens ni headers del request.

## 12. Consistency report y backfill dry-run

`scripts/report-inventory-lot-consistency.js`:
- corre dentro de transacción `READ ONLY`;
- siempre hace `ROLLBACK`;
- no contiene `INSERT`, `UPDATE`, `DELETE` ni DDL;
- reporta:
  - `missingLocationId`
  - `locationTenantMismatch`
  - `missingNormalizedLotNumber`
  - `negativeAvailable`
  - `committedNegative`
  - `committedGtAvailable`
  - `productStockDivergent`
  - `lotBasedWithBaseBalance`
  - `legacyWithLots`
  - `duplicatePhysicalIdentity`
  - `conflictingPhysicalIdentity`
  - `writtenOffWithQuantity`
  - `blockMetadataWithoutBlockedStatus`
  - `activeWithWriteoffMetadata`
  - `blockedWithoutQuantity`
  - `cancelledFefoEligible`
  - `expiredUsedRecently`
  - `invalidAllocations`
  - `tombstoneProductWithActiveLot`
  - `movementTenantMismatch`
  - `allocationTenantMismatch`
  - `legacyQuarantinedRows`

`scripts/backfill-inventory-lot-locations.js`:
- sin `--apply` corre en `READ ONLY` y hace `ROLLBACK`;
- con `--apply` hace `COMMIT`;
- el modo dry-run no escribe;
- clasifica:
  - `already_assigned`
  - `exact_match`
  - `ambiguous_match`
  - `no_match`
  - `tenant_mismatch`
  - `inactive_location`
- `--apply` sólo actualiza `exact_match`.

## 13. Historial

`listInventoryLotHistory(...)`:
- pagina por `LIMIT/OFFSET`;
- ordena estable por `createdAt DESC, id DESC`;
- deja `movement` para eventos con movimiento real;
- deja `operation` sólo para `block`, `unblock`, `change_expiration` y fallos;
- evita duplicar receipt/writeoff ya representados por `inventory_movements`.

## 14. Tests agregados

Backend:
- `scripts/tests/inventory-lot-review-identity-formulas.test.js`
- `scripts/tests/inventory-lot-review-service-policies.test.js`
- `scripts/tests/inventory-lot-review-permissions-migrations.test.js`
- `scripts/tests/inventory-lot-predeploy-routes-history.test.js`
- `scripts/tests/inventory-lot-predeploy-scripts.test.js`

Frontend:
- `opturon-web-publish/scripts/tests/inventory-lots-ui.test.ts`
- `opturon-web-publish/scripts/tests/inventory-expiration-ui.test.ts`
- `opturon-web-publish/scripts/tests/inventory-permissions-ui.test.ts`
- regresión FEFO UI ya existente

Cubren:
- identidad física con `NULL` segura;
- fórmulas de stock;
- writeoff con comprometido;
- reintegro a lotes `blocked` y rechazo a `written_off`;
- idempotencia concurrente de `block`;
- wiring de permisos por rol;
- auditoría estática de migraciones y scripts;
- frontend por permiso de receipt vs permiso sensible;
- historial sin duplicación semántica de receipt/writeoff.
