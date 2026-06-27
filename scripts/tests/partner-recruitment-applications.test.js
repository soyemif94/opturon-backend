const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const recruitmentService = require(path.join(rootDir, 'src/services/partner-recruitment-applications.service.js'));
const partnerRoutes = require(path.join(rootDir, 'src/routes/partners.routes.js'));
const adminRoutes = require(path.join(rootDir, 'src/routes/admin.routes.js'));

function listRoutePaths(router) {
  return router.stack
    .filter((layer) => layer && layer.route && layer.route.path)
    .map((layer) => `${Object.keys(layer.route.methods).sort().join(',')}:${layer.route.path}`);
}

function assertRoute(router, needle) {
  const entries = listRoutePaths(router);
  assert.ok(entries.includes(needle), `missing route ${needle}\n${entries.join('\n')}`);
}

function main() {
  const validPayload = recruitmentService.normalizePayload({
    firstName: 'Adriel Sergio',
    lastName: 'Opturon',
    email: 'correo-controlado@example.com',
    phone: '02915275449',
    documentId: '38550389',
    city: 'Bahia Blanca',
    province: 'Buenos Aires',
    country: 'Argentina',
    notes: 'Referencia controlada',
    consentConfirmed: true
  });
  assert.strictEqual(validPayload.ok, true);
  assert.strictEqual(validPayload.data.normalizedEmail, 'correo-controlado@example.com');
  assert.strictEqual(validPayload.data.phone, '02915275449');
  assert.strictEqual(validPayload.data.normalizedPhone, '02915275449');
  assert.strictEqual(validPayload.data.documentId, '38550389');
  assert.strictEqual(validPayload.data.normalizedDocumentId, '38550389');

  const missingConsent = recruitmentService.normalizePayload({
    firstName: 'Ana',
    lastName: 'Lopez',
    email: 'ana@example.com',
    phone: '11111111',
    consentConfirmed: false
  });
  assert.strictEqual(missingConsent.ok, false);
  assert.strictEqual(missingConsent.reason, 'recruitment_consent_required');

  assert.strictEqual(recruitmentService.canTransition('draft', 'pending_review'), true);
  assert.strictEqual(recruitmentService.canTransition('approved', 'invitation_sent'), true);
  assert.strictEqual(recruitmentService.canTransition('approved', 'pending_review'), false);
  assert.strictEqual(recruitmentService.canTransition('invitation_sent', 'invitation_accepted'), true);

  assertRoute(partnerRoutes, 'post:/me/recruitment-applications');
  assertRoute(partnerRoutes, 'get:/me/recruitment-applications');
  assertRoute(partnerRoutes, 'get:/me/recruitment-applications/:applicationId');
  assertRoute(partnerRoutes, 'patch:/me/recruitment-applications/:applicationId');
  assertRoute(partnerRoutes, 'post:/me/recruitment-applications/:applicationId/submit');
  assertRoute(partnerRoutes, 'post:/me/recruitment-applications/:applicationId/cancel');

  assertRoute(adminRoutes, 'get:/partners/recruitment-applications');
  assertRoute(adminRoutes, 'get:/partners/recruitment-applications/:applicationId');
  assertRoute(adminRoutes, 'post:/partners/recruitment-applications/:applicationId/send-invitation');

  const migrationText = fs.readFileSync(
    path.join(rootDir, 'db/migrations/057_partner_recruitment_applications_phase1.sql'),
    'utf8'
  );
  const partnersRepositoryText = fs.readFileSync(
    path.join(rootDir, 'src/repositories/partners.repository.js'),
    'utf8'
  );
  assert.match(migrationText, /CREATE TABLE IF NOT EXISTS partner_recruitment_applications/);
  assert.match(migrationText, /partner_recruitment_applications_active_email_unique_idx/);
  assert.match(migrationText, /ALTER TABLE partner_invitations/);
  assert.match(migrationText, /"sourceType" IN \('partner_invite', 'partner_recruitment_application'\)/);
  assert.match(partnersRepositoryText, /SELECT id, email, role, "accountType", active/);
  assert.doesNotMatch(partnersRepositoryText, /SELECT id, email, role, "accountScope", active/);

  console.log('partner-recruitment-applications.test.js: ok');
}

main();
