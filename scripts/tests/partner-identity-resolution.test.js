const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const partnerMeRouteFiles = [
  'opturon-web-publish/app/api/partners/me/route.ts',
  'opturon-web-publish/app/api/partners/me/summary/route.ts',
  'opturon-web-publish/app/api/partners/me/clients/route.ts',
  'opturon-web-publish/app/api/partners/me/rank-progress/route.ts',
  'opturon-web-publish/app/api/partners/me/network/route.ts',
  'opturon-web-publish/app/api/partners/me/commissions/route.ts',
  'opturon-web-publish/app/api/partners/me/client-requests/route.ts',
  'opturon-web-publish/app/api/partners/me/client-requests/[requestId]/route.ts',
  'opturon-web-publish/app/api/partners/me/client-requests/[requestId]/submit/route.ts',
  'opturon-web-publish/app/api/partners/me/client-requests/[requestId]/cancel/route.ts',
  'opturon-web-publish/app/api/partners/me/client-requests/[requestId]/receipt/route.ts'
];

function testCanonicalPartnerResolver() {
  const access = read('opturon-web-publish/lib/saas/access.ts');
  assert.match(access, /export function resolveAuthenticatedPartner/);
  assert.match(access, /accountScope:\s*PARTNER_ROLE/);
  assert.match(access, /isStrictPartnerIdentity\(/);
  assert.match(access, /return \{ ctx, partnerId: partner\.partnerId, partner: partner\.partner \}/);
  assert.match(access, /partnerId:\s*session\?\.user\?\.partnerId/);
}

function testRoutesUseGuardPartnerId() {
  for (const routeFile of partnerMeRouteFiles) {
    const source = read(routeFile);
    assert.match(source, /requirePartnerApi\(\)/, `${routeFile} must use the partner API guard`);
    assert.match(source, /guard\.partnerId/, `${routeFile} must use the canonical guard partnerId`);
    assert.doesNotMatch(source, /session\?\.user\?\.partnerId|session\.user\?\.partnerId|session\.user\.partnerId/, `${routeFile} must not read partnerId directly from session`);
  }
}

function testSessionHydratesCanonicalPartnerId() {
  const auth = read('opturon-web-publish/lib/auth.ts');
  assert.match(auth, /normalizePartnerAuthUser/);
  assert.match(auth, /getPartnerAuthUserByEmail\(String\(token\.email\)\)/);
  assert.match(auth, /token\.partnerId = normalizedPartner\.partnerId/);
  assert.match(auth, /session\.user\.partnerId = token\.partnerId \? String\(token\.partnerId\) : undefined/);
  assert.doesNotMatch(auth, /session\.user\.partnerId = token\.userId/);
}

function testBackendRejectsNonCanonicalOrInactivePartner() {
  const middleware = read('src/middlewares/partner-auth.middleware.js');
  const service = read('src/services/partner-client-requests.service.js');
  const frontendProxy = read('opturon-web-publish/lib/partner-client-requests-api.ts');
  assert.match(middleware, /req\.get\('x-partner-id'\)/);
  assert.match(middleware, /findPartnerById\(partnerId\)/);
  assert.match(middleware, /partner\.status !== 'active'/);
  assert.match(service, /function assertPartnerExists\(partnerId/);
  assert.match(service, /reason: 'partner_inactive'/);
  assert.match(frontendProxy, /headers\.set\("x-partner-id", actor\.partnerId\)/);
  assert.doesNotMatch(frontendProxy, /headers\.set\("x-partner-id", .*body/);
}

function testNoUnsafeDataRepairOrDuplicatePartnerCreation() {
  const service = read('src/services/partner-client-requests.service.js');
  const access = read('opturon-web-publish/lib/saas/access.ts');
  assert.doesNotMatch(service, /createPartner\(/);
  assert.doesNotMatch(service, /createPartnerAccount\(/);
  assert.doesNotMatch(access, /email/i);
}

function testFrontendMapsIdentityErrors() {
  const component = read('opturon-web-publish/components/partners/PartnerPortalWorkspace.tsx');
  const helperStart = component.indexOf('function readPartnerPortalError');
  const helperEnd = component.indexOf('function DrawerField');
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'readPartnerPortalError helper must be present');
  const helper = component.slice(helperStart, helperEnd);
  assert.match(component, /partner_not_found/);
  assert.match(component, /No pudimos identificar tu cuenta de asesor/);
  assert.ok(helper.indexOf('partner_not_found') < helper.indexOf('if (error) return error;'), 'identity errors must be mapped before returning backend error codes');
}

testCanonicalPartnerResolver();
testRoutesUseGuardPartnerId();
testSessionHydratesCanonicalPartnerId();
testBackendRejectsNonCanonicalOrInactivePartner();
testNoUnsafeDataRepairOrDuplicatePartnerCreation();
testFrontendMapsIdentityErrors();

console.log('partner-identity-resolution.test.js: ok');
