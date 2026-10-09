const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');

test('worker gives one inbound message one automatic response authority', () => {
  const worker = fs.readFileSync(require.resolve('../../src/worker.js'), 'utf8');
  assert.match(worker, /if \(!decision && automationRuntime\.replyText\)/);
  assert.match(worker, /autoResponseHandled: true/);
  assert.match(worker, /if \(!decision && !qaAgendaBypassActive/);
});
