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
  const result = parse('[10/4/26, 10:01:40 a. m.] Nombre: mensaje');
  assert.equal(result.detectedFormat, 'bracketed');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].participant, 'Nombre');
  assert.equal(result.messages[0].text, 'mensaje');
  assert.equal(result.messages[0].originalTimestamp, '2026-04-10T10:01:40.000Z');
}

{
  const result = parse('[10/4/26, 3:15:00 p. m.] Nombre: tarde');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].originalTimestamp, '2026-04-10T15:15:00.000Z');
}

{
  const midnight = parse('[10/4/26, 12:05:00 a. m.] Nombre: madrugada');
  assert.equal(midnight.messages[0].originalTimestamp, '2026-04-10T00:05:00.000Z');

  const noon = parse('[10/4/26, 12:05:00 p. m.] Nombre: mediodia');
  assert.equal(noon.messages[0].originalTimestamp, '2026-04-10T12:05:00.000Z');
}

{
  const result = parse('[10/4/26, 9:07:00 a.m.] Nombre: compacto\n[10/4/26, 9:08:00 PM] Nombre: mayusculas');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].originalTimestamp, '2026-04-10T09:07:00.000Z');
  assert.equal(result.messages[1].originalTimestamp, '2026-04-10T21:08:00.000Z');
}

{
  const result = parse('\u200e[10/4/26,\u200e 10:01:40 a. m.]\u200e Nombre: mensaje con lrm');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].participant, 'Nombre');
  assert.equal(result.messages[0].text, 'mensaje con lrm');
  assert.equal(result.messages[0].originalTimestamp, '2026-04-10T10:01:40.000Z');
}

{
  const result = parse(`[10/4/26, 10:01:40 a.${String.fromCharCode(160)}m.] Nombre: nbsp`);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].originalTimestamp, '2026-04-10T10:01:40.000Z');
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
  const result = parse('[10/4/26, 10:01:40 a. m.] José Pérez ✨: primer mensaje\nsegunda linea');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].participant, 'José Pérez ✨');
  assert.equal(result.messages[0].text, 'primer mensaje\nsegunda linea');
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
  const mixed = parse(
    [
      '[10/4/26, 10:01:40 a. m.] José Pérez ✨: Hola',
      'continuacion en multilinea',
      '[10/4/26, 12:05:00 p. m.] Sistema raro',
      '10/4/2026, 18:46 - Ana: Formato anterior ok'
    ].join('\n')
  );
  assert.equal(mixed.messages.length, 3);
  assert.equal(mixed.messages[0].participant, 'José Pérez ✨');
  assert.equal(mixed.messages[0].text, 'Hola\ncontinuacion en multilinea');
  assert.equal(mixed.messages[0].originalTimestamp, '2026-04-10T10:01:40.000Z');
  assert.equal(mixed.messages[1].participant, null);
  assert.equal(mixed.messages[1].type, 'system');
  assert.equal(mixed.messages[1].originalTimestamp, '2026-04-10T12:05:00.000Z');
  assert.equal(mixed.messages[2].participant, 'Ana');
  assert.equal(mixed.messages[2].text, 'Formato anterior ok');
  assert.equal(mixed.messages[2].originalTimestamp, '2026-04-10T18:46:00.000Z');
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
