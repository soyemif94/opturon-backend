const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const authUserId = '11111111-1111-4111-8111-111111111111';
const partnerAccountId = '22222222-2222-4222-8222-222222222222';
const partnerProfileRowId = '33333333-3333-4333-8333-333333333333';
const tenantId = '44444444-4444-4444-8444-444444444444';

function testFixtureIdsAreDistinct() {
  assert.notStrictEqual(authUserId, partnerAccountId);
  assert.notStrictEqual(partnerAccountId, partnerProfileRowId);
  assert.notStrictEqual(partnerProfileRowId, tenantId);
}

function testCanonicalPartnerIdIsPartnerAccountId() {
  const migration = read('db/migrations/054_partner_client_requests_phase1.sql');
  const partnerRepository = read('src/repositories/partners.repository.js');
  const clientRequestsRepository = read('src/repositories/partner-client-requests.repository.js');
  assert.match(migration, /"partnerId" UUID NOT NULL REFERENCES partner_accounts\(id\)/);
  assert.match(partnerRepository, /WHERE pa\.id = \$1/);
  assert.match(clientRequestsRepository, /INNER JOIN partner_accounts pa ON pa\.id = pcr\."partnerId"/);
  assert.match(clientRequestsRepository, /INNER JOIN partner_profiles pp ON pp\."partnerId" = pcr\."partnerId"/);
}

function testLoginAndSessionUseCanonicalPartnerAccountId() {
  const backendService = read('src/services/partners.service.js');
  const backendRepository = read('src/repositories/partners.repository.js');
  const frontendAuth = read('opturon-web-publish/lib/auth.ts');
  assert.match(backendRepository, /SELECT pa\.id,[\s\S]*INNER JOIN partner_profiles pp ON pp\."partnerId" = pa\.id/);
  assert.match(backendService, /await touchPartnerLogin\(partner\.id\)/);
  assert.match(backendService, /const hydrated = await findPartnerById\(partner\.id\)/);
  assert.match(frontendAuth, /token\.partnerId = normalizedPartner\.partnerId/);
  assert.match(frontendAuth, /session\.user\.partnerId = token\.partnerId \? String\(token\.partnerId\) : undefined/);
  assert.doesNotMatch(frontendAuth, /session\.user\.partnerId = token\.userId/);
}

function testProxyForwardsOnlyCanonicalServerSidePartnerId() {
  const access = read('opturon-web-publish/lib/saas/access.ts');
  const rootRoute = read('opturon-web-publish/app/api/partners/me/client-requests/route.ts');
  const proxy = read('opturon-web-publish/lib/partner-client-requests-api.ts');
  assert.match(access, /resolveAuthenticatedPartner/);
  assert.match(rootRoute, /const partnerId = guard\.partnerId/);
  assert.match(proxy, /headers\.set\("x-partner-id", actor\.partnerId\)/);
  assert.match(proxy, /headers\.set\("x-partner-identity-trace-id", actor\.traceId\)/);
  assert.doesNotMatch(rootRoute, /request\.headers\.get\(["']x-partner-id["']\)/);
}

function testBackendConsultsCanonicalTableAndUsesCorrectUuidValidation() {
  const middleware = read('src/middlewares/partner-auth.middleware.js');
  const service = read('src/services/partner-client-requests.service.js');
  const uuidPattern = /\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[1-5\]\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}\$/;
  assert.match(middleware, /findPartnerById\(partnerId\)/);
  assert.match(middleware, /partner_identity_invalid/);
  assert.match(service, uuidPattern);
  assert.match(service, /reason: 'partner_identity_invalid'/);
  assert.match(service, /lookupTable: 'partner_accounts'/);
  assert.doesNotMatch(service, /findPartnerByEmail/);
}

function testTraceCoversFrontendBackendAndService() {
  const rootRoute = read('opturon-web-publish/app/api/partners/me/client-requests/route.ts');
  const middleware = read('src/middlewares/partner-auth.middleware.js');
  const service = read('src/services/partner-client-requests.service.js');
  assert.match(rootRoute, /event: "partner_identity_trace"/);
  assert.match(rootRoute, /sessionPartnerId/);
  assert.match(rootRoute, /forwardedPartnerId/);
  assert.match(middleware, /backendActorPartnerId/);
  assert.match(middleware, /repositoryLookupId/);
  assert.match(service, /repositoryLookupId/);
}

function testNoUnsafeFallbackOrSideEffects() {
  const service = read('src/services/partner-client-requests.service.js');
  const repository = read('src/repositories/partner-client-requests.repository.js');
  const createStart = service.indexOf('async function createRequestForPartner');
  const activationStart = service.indexOf('async function resolveActivationTenant');
  const requestCreationFlow = service.slice(createStart, activationStart);
  assert.doesNotMatch(service, /findPartnerByEmail/);
  assert.doesNotMatch(service, /createPartnerAccount|createPartnerProfile|createPartner\(/);
  assert.doesNotMatch(repository, /tenantId.*INSERT INTO partner_client_requests/);
  assert.doesNotMatch(requestCreationFlow, /createCommission|createRankEvaluation|createSaasSubscription/);
}

testFixtureIdsAreDistinct();
testCanonicalPartnerIdIsPartnerAccountId();
testLoginAndSessionUseCanonicalPartnerAccountId();
testProxyForwardsOnlyCanonicalServerSidePartnerId();
testBackendConsultsCanonicalTableAndUsesCorrectUuidValidation();
testTraceCoversFrontendBackendAndService();
testNoUnsafeFallbackOrSideEffects();

console.log('partner-identity-end-to-end.test.js: ok');
