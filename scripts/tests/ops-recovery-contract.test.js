const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const service = readFileSync(join(process.cwd(), 'src/services/portal-inbox.service.js'), 'utf8');
const assignment = service.slice(service.indexOf('async function persistSellerAssignment'), service.indexOf('function mapConversationRow'));
const listing = service.slice(service.indexOf('async function listPortalConversations'), service.indexOf('async function getPortalConversationDetail'));
const details = service.slice(service.indexOf('async function getPortalConversationDetail'));

assert.match(assignment, /startRecovery = false/);
assert.match(assignment, /if \(startRecovery && !supervisorRole\)/, 'only owner/manager actors may start a recovery intervention');
assert.match(assignment, /fromSellerId === seller\.id && startRecovery/);
assert.match(assignment, /type: 'recovery_started'/, 'same-seller reactivation persists a durable event');
assert.match(assignment, /changedBy: actor\.id/);
assert.match(assignment, /source: 'ops'/);
assert.match(assignment, /fromSellerId,\s*fromSellerName/);
assert.match(assignment, /type: reassigned \? 'seller_reassigned' : 'seller_assigned'/);
assert.match(assignment, /events\.push\(await addEvent/);
assert.match(listing, /'seller_assigned', 'seller_reassigned', 'recovery_started'/, 'list view includes recovery in commercial history and activity');
assert.match(service, /recoveryStartedAt: latestRecoveryEvent\?\.createdAt/);
assert.match(details, /'seller_assigned', 'seller_reassigned', 'recovery_started'/, 'conversation detail preserves recovery history');
assert.match(service, /startRecovery: payload && payload\.startRecovery === true/);

console.log('ops-recovery-contract.test.js passed');
