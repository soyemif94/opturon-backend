function buildAiMessages({ conversation, historyMessages, inboundText }) {
  const systemPrompt =
    'Sos el asistente virtual de una clinica odontologica. ' +
    'Objetivo: ayudar a sacar turnos, informar precios y direccion. ' +
    'Responde en espanol rioplatense, tono amable y corto (1-3 lineas). ' +
    'No inventes precios ni datos que no esten en el contexto. ' +
    'No cambies el flujo ni pidas pasos fuera del flujo actual. ' +
    'Si el usuario pide turno, guia para capturar dia y horario/franja y confirmar. ' +
    'IMPORTANTE: no decidis estados conversacionales, solo mejoras el texto de salida. ' +
    'Responde SOLO con JSON valido y nada mas. ' +
    'Formato exacto: {"replyText":"..."} ' +
    'Reglas: replyText maximo 280 caracteres, sin markdown, sin triple backticks, sin saltos de linea dobles.';

  const items = Array.isArray(historyMessages) ? historyMessages.slice(-10) : [];
  const messages = items
    .map((item) => {
      const direction = String(item.direction || '').toLowerCase();
      if (direction !== 'inbound' && direction !== 'outbound') {
        return null;
      }

      const role = direction === 'inbound' ? 'user' : 'assistant';
      const content =
        String(item.type || '').toLowerCase() === 'text'
          ? String(item.text || '').trim()
          : '[mensaje no-text]';

      if (!content) {
        return null;
      }
      return { role, content };
    })
    .filter(Boolean);

  const inbound = String(inboundText || '').trim();
  if (inbound) {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || last.content !== inbound) {
      messages.push({ role: 'user', content: inbound });
    }
  }

  if (conversation && conversation.context && conversation.context.name) {
    messages.unshift({
      role: 'system',
      content: `Nombre detectado del paciente: ${String(conversation.context.name).trim()}`
    });
  }

  return { systemPrompt, messages };
}

module.exports = {
  buildAiMessages
};
