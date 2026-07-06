const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function testMigrationAddsProcessingFields() {
  const migration = read('db/migrations/055_partner_client_request_activation.sql');
  assert.match(migration, /"processingStatus" TEXT NOT NULL DEFAULT 'not_processed'/);
  assert.match(migration, /"paymentConfirmedAt" TIMESTAMPTZ NULL/);
  assert.match(migration, /"linkedExternalTenantId" TEXT NULL/);
  assert.match(migration, /"commissionEntryId" UUID NULL REFERENCES partner_commission_entries/);
  assert.match(migration, /partner_commission_entries_client_request_signup_unique_idx/);
  assert.match(migration, /Rollback:/);
}

function testActivationIsSeparateFromApproval() {
  const service = read('src/services/partner-client-requests.service.js');
  const controller = read('src/controllers/admin.controller.js');
  const routes = read('src/routes/admin.routes.js');
  assert.match(service, /async function processApprovedRequestAsAdmin/);
  assert.match(service, /request\.status !== 'approved'/);
  assert.match(service, /payment_confirmation_required/);
  assert.match(controller, /postAdminPartnerClientRequestProcess/);
  assert.match(routes, /\/partners\/client-requests\/:requestId\/process/);
}

function testTenantAttributionAndIdempotency() {
  const service = read('src/services/partner-client-requests.service.js');
  const repository = read('src/repositories/partner-client-requests.repository.js');
  assert.match(service, /provisionCleanClinicForExternalTenant/);
  assert.match(service, /findActiveAttributionByTenantId/);
  assert.match(service, /tenant_already_attributed/);
  assert.match(service, /createPartnerAttribution/);
  assert.match(repository, /findPartnerClientRequestByIdForUpdate/);
  assert.match(service, /request\.processingStatus === 'processed'/);
  assert.match(service, /alreadyProcessed: true/);
}

function testProcessedRequestsRepairMissingCommission() {
  const service = read('src/services/partner-client-requests.service.js');
  const processedBranchStart = service.indexOf("if (request.processingStatus === 'processed')");
  const approvalGuardStart = service.indexOf("if (request.status !== 'approved')");
  const processedBranch = service.slice(processedBranchStart, approvalGuardStart);
  assert.match(service, /async function ensureOwnSignupCommissionForClientRequest/);
  assert.match(processedBranch, /findCommissionEntriesBySource\(CLIENT_REQUEST_ACTIVATION_SOURCE, request\.id, request\.id, client\)/);
  assert.match(processedBranch, /ensureOwnSignupCommissionForClientRequest/);
  assert.match(processedBranch, /commissionRepaired/);
  assert.match(processedBranch, /markPartnerClientRequestProcessed/);
  assert.match(processedBranch, /commissionEntryId: commissionResult\.commissionEntry\.id/);
}

function testNoCommissionOnApproval() {
  const service = read('src/services/partner-client-requests.service.js');
  const reviewStart = service.indexOf('async function reviewRequestAsAdmin');
  const activationStart = service.indexOf('async function resolveActivationTenant');
  const reviewFlow = service.slice(reviewStart, activationStart);
  assert.doesNotMatch(reviewFlow, /createCommissionEntry/);
  assert.doesNotMatch(reviewFlow, /commissionAmount/);
}

testMigrationAddsProcessingFields();
testActivationIsSeparateFromApproval();
testTenantAttributionAndIdempotency();
testProcessedRequestsRepairMissingCommission();
testNoCommissionOnApproval();
console.log('partner-client-activation.test.js: ok');
