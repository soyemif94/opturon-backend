const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function testMigrationShape() {
  const migration = read('db/migrations/054_partner_client_requests_phase1.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS partner_client_requests/);
  assert.match(migration, /"partnerId" UUID NOT NULL REFERENCES partner_accounts/);
  assert.match(migration, /status TEXT NOT NULL DEFAULT 'draft'/);
  assert.match(migration, /CHECK \(status IN \('draft', 'pending_review', 'changes_requested', 'approved', 'rejected', 'cancelled'\)\)/);
  assert.match(migration, /"receiptStorageKey" TEXT NOT NULL/);
  assert.match(migration, /"receiptSha256" TEXT NULL/);
  assert.match(migration, /partner_client_requests_email_idx/);
  assert.match(migration, /partner_client_requests_phone_idx/);
  assert.match(migration, /partner_client_requests_receipt_sha_idx/);
}

function testPartnerSecurityAndRoutes() {
  const routes = read('src/routes/partners.routes.js');
  const controller = read('src/controllers/partners.controller.js');
  const service = read('src/services/partner-client-requests.service.js');
  assert.match(routes, /requirePartnerInternalAuth, handleClientRequestReceiptUpload, postPartnerClientRequest/);
  assert.match(routes, /\/me\/client-requests\/:requestId\/receipt/);
  assert.match(controller, /getPartnerActorId\(req\)/);
  assert.doesNotMatch(service, /payload\.partnerId/);
  assert.match(service, /assertPartnerExists\(partnerId/);
  assert.match(service, /String\(current\.partnerId\) !== String\(partnerId\)/);
}

function testStorageSafety() {
  const storage = read('src/services/partner-client-request-receipts.service.js');
  const partnerController = read('src/controllers/partners.controller.js');
  const adminController = read('src/controllers/admin.controller.js');
  assert.match(storage, /MAX_RECEIPT_BYTES = 10 \* 1024 \* 1024/);
  assert.match(storage, /application\/pdf/);
  assert.match(storage, /image\/jpeg/);
  assert.match(storage, /image\/png/);
  assert.match(storage, /image\/webp/);
  assert.match(storage, /detectMimeFromSignature/);
  assert.match(storage, /client_request_receipt_signature_mismatch/);
  assert.match(storage, /requiresExplicitPersistentStorage/);
  assert.match(partnerController, /Cache-Control', 'private, no-store'/);
  assert.match(adminController, /Cache-Control', 'private, no-store'/);
}

function testTransitionsAndNoSideEffects() {
  const service = read('src/services/partner-client-requests.service.js');
  assert.match(service, /\['draft', new Set\(\['pending_review', 'cancelled'\]\)\]/);
  assert.match(service, /\['pending_review', new Set\(\['approved', 'rejected', 'changes_requested', 'cancelled'\]\)\]/);
  assert.match(service, /\['changes_requested', new Set\(\['pending_review', 'cancelled'\]\)\]/);
  assert.match(service, /admin_notes_required/);
  assert.doesNotMatch(service, /createPartnerAttribution\(/);
  assert.doesNotMatch(service, /simulateCommissionEntries\(/);
  assert.doesNotMatch(service, /evaluatePartnerRank\(/);
  assert.doesNotMatch(service, /createSaasSubscription/);
}

function testAdminRoutesAndAudit() {
  const routes = read('src/routes/admin.routes.js');
  const service = read('src/services/partner-client-requests.service.js');
  assert.match(routes, /\/partners\/client-requests/);
  assert.match(routes, /approve\|reject\|request_changes/);
  assert.match(service, /partner_client_request_created/);
  assert.match(service, /partner_client_request_submitted/);
  assert.match(service, /partner_client_request_resubmitted/);
  assert.match(service, /partner_client_request_approved/);
  assert.match(service, /partner_client_request_rejected/);
  assert.match(service, /partner_client_request_changes_requested/);
  assert.match(service, /partner_client_request_receipt_viewed/);
}

testMigrationShape();
testPartnerSecurityAndRoutes();
testStorageSafety();
testTransitionsAndNoSideEffects();
testAdminRoutesAndAudit();
console.log('partner-client-requests.test.js: ok');
