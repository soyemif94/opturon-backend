const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function testFinancialCalculationUsesCentsAndBigInt() {
  const service = read('src/services/partner-client-requests.service.js');
  assert.match(service, /function parseMoneyToCents/);
  assert.match(service, /BigInt/);
  assert.match(service, /calculateCommissionAmountCents/);
  assert.match(service, /60800|confirmedAmount/);
}

function testOwnSignupOnly() {
  const service = read('src/services/partner-client-requests.service.js');
  assert.match(service, /CLIENT_REQUEST_SIGNUP_EVENT = 'subscription_signup_accredited'/);
  assert.match(service, /payoutKind: 'own_signup'/);
  assert.doesNotMatch(service, /line_recurring_rebate/);
  assert.doesNotMatch(service, /own_recurring/);
}

function testLedgerSnapshotAndIdempotency() {
  const service = read('src/services/partner-client-requests.service.js');
  const migration = read('db/migrations/055_partner_client_request_activation.sql');
  assert.match(service, /basisAmount: confirmedAmount/);
  assert.match(service, /commissionRate: rule\.rate/);
  assert.match(service, /commissionAmount/);
  assert.match(service, /commissionRuleCode/);
  assert.match(service, /findCommissionEntriesBySource/);
  assert.match(migration, /partner_commission_entries_client_request_signup_unique_idx/);
  assert.match(migration, /"sourceType", "sourceRef", "eventType", "payoutKind", "partnerId"/);
}

testFinancialCalculationUsesCentsAndBigInt();
testOwnSignupOnly();
testLedgerSnapshotAndIdempotency();
console.log('partner-commission-generation.test.js: ok');
