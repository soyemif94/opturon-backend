const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { parseWhatsAppChatExport } = require('../../src/imports/whatsapp-chat-export.parser');

const repoRoot = path.resolve(__dirname, '..', '..');

function parse(text) {
  return parseWhatsAppChatExport(text);
}

{
  const result = parse('[12/7/26, 18:45:02] Juan: Hola\n[12/7/26, 18:46:00] Ana: Bien');
  assert.equal(result.detectedFormat, 'bracketed');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.participants, ['Ana', 'Juan']);
  assert.equal(result.ignoredLines, 0);
}

{
  const result = parse('12/7/2026, 18:45 - Juan: Hola\n12/7/2026, 18:46 - Ana: Respuesta');
  assert.equal(result.detectedFormat, 'plain');
  assert.equal(result.messages.length, 2);
}

{
  const result = parse('[12/7/26, 18:45] John: Hello\nthis is multiline\n[12/7/26, 18:46] Mary: <Media omitted>');
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0].text, /this is multiline/);
  assert.equal(result.messages[1].type, 'media_omitted');
}

{
  const result = parse('[12/7/26, 18:45] Los mensajes y las llamadas estan cifrados de extremo a extremo.');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].type, 'system');
  assert.equal(result.messages[0].systemType, 'encryption_notice');
}

{
  const result = parse('linea desconocida inicial\n[12/7/26, 18:45] Juan: Hola');
  assert.equal(result.messages.length, 1);
  assert.equal(result.ignoredLines, 1);
}

{
  const empty = parse('');
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.detectedFormat, 'unknown');
  assert(empty.warnings.some((warning) => warning.code === 'unrecognized_format'));
}

{
  const service = fs.readFileSync(path.join(repoRoot, 'src/services/portal-whatsapp-imports.service.js'), 'utf8');
  assert.doesNotMatch(service, /processInboundMessages/);
  assert.doesNotMatch(service, /sendChannelScopedMessage/);
  assert.doesNotMatch(service, /sendPortalMessage/);
  assert.doesNotMatch(service, /enqueueJob\(/);
  assert.match(service, /ON CONFLICT \("waMessageId"\) DO NOTHING/);
  assert.match(service, /createdAt"[\s\S]*message\.originalTimestamp/);
  assert.match(service, /messages: _discardedMessages/);
  assert.match(service, /summaryWithoutSensitiveMessages/);
  assert.match(service, /invalid_file_type/);
  assert.match(service, /file_too_large/);
}

console.log('whatsapp-chat-import-parser.test.js passed');
