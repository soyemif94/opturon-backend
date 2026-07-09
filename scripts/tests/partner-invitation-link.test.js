const assert = require('assert');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');

function modulePath(relativePath) {
  return path.join(rootDir, relativePath);
}

function clearModules() {
  delete require.cache[modulePath('src/config/env.js')];
  delete require.cache[modulePath('src/services/partner-invitations-email.service.js')];
}

function resetUrlEnv() {
  delete process.env.PARTNER_PORTAL_INVITATION_BASE_URL;
  delete process.env.PARTNER_PORTAL_BASE_URL;
  delete process.env.APP_PUBLIC_URL;
  delete process.env.FRONTEND_PUBLIC_URL;
  delete process.env.WEB_PUBLIC_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.OPTURON_PUBLIC_APP_URL;
}

function loadService() {
  clearModules();
  return require(modulePath('src/services/partner-invitations-email.service.js'));
}

function testDefaultInvitationLinkUsesPublicPartnersPath() {
  resetUrlEnv();
  const service = loadService();
  assert.strictEqual(
    service.buildPartnerInvitationAcceptLink('abc 123'),
    'https://www.opturon.com/partners/invite?token=abc%20123'
  );
}

function testPublicOriginInvitationLinkUsesPartnersPath() {
  resetUrlEnv();
  process.env.OPTURON_PUBLIC_APP_URL = 'https://www.opturon.com/';
  const service = loadService();
  assert.strictEqual(
    service.buildPartnerInvitationAcceptLink('abc123'),
    'https://www.opturon.com/partners/invite?token=abc123'
  );
}

function testExplicitInvitationUrlIsPreserved() {
  resetUrlEnv();
  process.env.PARTNER_PORTAL_INVITATION_BASE_URL = 'https://asesores.opturon.com/invite';
  const service = loadService();
  assert.strictEqual(
    service.buildPartnerInvitationAcceptLink('abc123'),
    'https://asesores.opturon.com/invite?token=abc123'
  );
}

function run() {
  testDefaultInvitationLinkUsesPublicPartnersPath();
  testPublicOriginInvitationLinkUsesPartnersPath();
  testExplicitInvitationUrlIsPreserved();
  resetUrlEnv();
  clearModules();
  console.log('partner-invitation-link.test.js: ok');
}

run();
