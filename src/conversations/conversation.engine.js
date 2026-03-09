const { parseAppointmentText } = require('./appointment.parser');

function looksLikeName(text) {
  const candidate = String(text || '').trim();
  if (candidate.length < 2 || candidate.length > 40) return false;
  if (/\d/.test(candidate)) return false;
  return /^[A-Za-z\u00C0-\u017F'`\-\s]+$/.test(candidate);
}

function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeCommandText(text) {
  return normalizeText(text)
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isAffirmative(text) {
  const value = normalizeText(text);
  return ['si', 's', 'confirmo', 'ok', 'dale'].includes(value);
}

function isNegative(text) {
  const value = normalizeText(text);
  return ['no', 'nop', 'cancelar'].includes(value);
}

function isAppointmentIntent(text) {
  const value = normalizeCommandText(text);
  return value === '1' || /turno|cita/.test(value);
}

function isGlobalCancelMenu(text) {
  const value = normalizeCommandText(text);
  return ['cancelar', 'salir', 'menu', 'volver', 'atras'].includes(value);
}

function parseTimeWindowOnly(text) {
  const value = normalizeCommandText(text);
  if (/(manana|temprano)/.test(value)) return { key: 'morning', label: 'mañana' };
  if (/\btarde\b/.test(value)) return { key: 'afternoon', label: 'tarde' };
  if (/\bnoche\b/.test(value)) return { key: 'evening', label: 'noche' };
  return null;
}

function decideReply({ state, context, inboundText }) {
  const currentState = String(state || 'NEW').toUpperCase();
  const safeContext = context && typeof context === 'object' ? context : {};
  const text = String(inboundText || '').trim();
  const lower = normalizeText(text);

  if (currentState === 'NEW') {
    return {
      replyText: 'Hola. Soy ClinicAI. Para ayudarte, como te llamas?',
      newState: 'ASKED_NAME',
      contextPatch: null
    };
  }

  if (currentState === 'ASKED_NAME') {
    if (looksLikeName(text)) {
      return {
        replyText: `Genial, ${text}. Que necesitas?\n\n1) Sacar turno\n2) Precios\n3) Direccion`,
        newState: 'READY',
        contextPatch: { name: text }
      };
    }

    return {
      replyText: 'Perfecto. Para continuar, decime tu nombre (solo texto).',
      newState: 'ASKED_NAME',
      contextPatch: null
    };
  }

  if (currentState === 'READY') {
    if (safeContext.appointmentStatus === 'reschedule_proposed') {
      if (isAffirmative(text)) {
        return {
          replyText: '✅ Perfecto, confirmado. ¡Gracias!',
          newState: 'READY',
          contextPatch: {
            appointmentStatus: 'confirmed',
            appointmentClinicResponse: {
              type: 'confirmed_from_reschedule',
              confirmedAt: new Date().toISOString()
            }
          }
        };
      }

      if (isNegative(text)) {
        return {
          replyText: 'Perfecto. Decime dia y horario nuevamente (ej: lunes 10:30).',
          newState: 'ASKED_APPOINTMENT_DATETIME',
          contextPatch: {
            appointmentCandidate: null
          }
        };
      }
    }

    const shortcutParsed = parseAppointmentText(text);
    if (shortcutParsed.ok && shortcutParsed.hasDayOrDate) {
      if (!shortcutParsed.hasTime && !shortcutParsed.hasTimeWindow) {
        return {
          replyText: 'Perfecto. Te va mejor a la mañana, tarde o noche?',
          newState: 'ASKED_APPOINTMENT_TIMEWINDOW',
          contextPatch: {
            appointmentCandidate: {
              rawText: text,
              parsed: shortcutParsed.parsed,
              createdAt: new Date().toISOString()
            }
          }
        };
      }

      return {
        replyText: `Genial. Te propongo: ${shortcutParsed.displayText}.\nConfirmas? (si/no)`,
        newState: 'CONFIRM_APPOINTMENT',
        contextPatch: {
          appointmentCandidate: {
            rawText: text,
            parsed: shortcutParsed.parsed,
            createdAt: new Date().toISOString()
          }
        }
      };
    }

    if (isAppointmentIntent(text)) {
      return {
        replyText: 'Perfecto. Para que dia y horario queres el turno? (ej: lunes 10:30)',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: null
      };
    }

    if (lower.includes('precio') || lower.includes('cost') || lower === '2') {
      return {
        replyText: 'Claro. Que tratamiento queres cotizar?',
        newState: 'READY',
        contextPatch: { intent: 'pricing' }
      };
    }

    if (lower.includes('direccion') || lower === '3') {
      return {
        replyText: 'Estamos en Direccion Placeholder 123. Queres que te pasemos ubicacion por WhatsApp?',
        newState: 'READY',
        contextPatch: { intent: 'location' }
      };
    }

    return {
      replyText: 'Te ayudo con:\n1) Sacar turno\n2) Precios\n3) Direccion',
      newState: 'READY',
      contextPatch: null
    };
  }

  if (currentState === 'ASKED_APPOINTMENT_DATETIME') {
    if (isGlobalCancelMenu(text)) {
      return {
        replyText: 'Listo. Volvemos al menu:\n1) Sacar turno\n2) Precios\n3) Direccion',
        newState: 'READY',
        contextPatch: {
          appointmentCandidate: null
        }
      };
    }

    const parsed = parseAppointmentText(text);
    if (!parsed.ok) {
      return {
        replyText: 'Dale. Decime dia y horario (ej: lunes 10:30 o 12/03 10:30).',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: null
      };
    }

    if (!parsed.hasTime && !parsed.hasTimeWindow) {
      return {
        replyText: 'Perfecto. Te va mejor a la mañana, tarde o noche?',
        newState: 'ASKED_APPOINTMENT_TIMEWINDOW',
        contextPatch: {
          appointmentCandidate: {
            rawText: text,
            parsed: parsed.parsed,
            createdAt: new Date().toISOString()
          }
        }
      };
    }

    return {
      replyText: `Genial. Te propongo: ${parsed.displayText}.\nConfirmas? (si/no)`,
      newState: 'CONFIRM_APPOINTMENT',
      contextPatch: {
        appointmentCandidate: {
          rawText: text,
          parsed: parsed.parsed,
          createdAt: new Date().toISOString()
        }
      }
    };
  }

  if (currentState === 'ASKED_APPOINTMENT_TIMEWINDOW') {
    if (isGlobalCancelMenu(text)) {
      return {
        replyText: 'Listo. Volvemos al menu:\n1) Sacar turno\n2) Precios\n3) Direccion',
        newState: 'READY',
        contextPatch: {
          appointmentCandidate: null
        }
      };
    }

    const candidate = safeContext.appointmentCandidate || null;
    if (!candidate || !candidate.parsed || (!candidate.parsed.weekday && !candidate.parsed.dateISO)) {
      return {
        replyText: 'Se me perdio el horario. Decime dia y hora nuevamente (ej: lunes 10:30).',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: null
      };
    }

    const windowParsed = parseTimeWindowOnly(text);
    if (!windowParsed) {
      return {
        replyText: 'Decime: mañana, tarde o noche.',
        newState: 'ASKED_APPOINTMENT_TIMEWINDOW',
        contextPatch: null
      };
    }

    const baseParsed = { ...(candidate.parsed || {}), timeWindow: windowParsed.key };
    const baseText = candidate.parsed.dateISO
      ? `${String(candidate.parsed.dateISO).slice(8, 10)}/${String(candidate.parsed.dateISO).slice(5, 7)}`
      : (candidate.parsed.weekday === 'monday'
          ? 'lunes'
          : candidate.parsed.weekday === 'tuesday'
            ? 'martes'
            : candidate.parsed.weekday === 'wednesday'
              ? 'miercoles'
              : candidate.parsed.weekday === 'thursday'
                ? 'jueves'
                : candidate.parsed.weekday === 'friday'
                  ? 'viernes'
                  : candidate.parsed.weekday === 'saturday'
                    ? 'sabado'
                    : 'domingo');

    return {
      replyText: `Genial. Te propongo: ${baseText} por la ${windowParsed.label}.\nConfirmas? (si/no)`,
      newState: 'CONFIRM_APPOINTMENT',
      contextPatch: {
        appointmentCandidate: {
          rawText: candidate.rawText || text,
          parsed: baseParsed,
          createdAt: candidate.createdAt || new Date().toISOString()
        }
      }
    };
  }

  if (currentState === 'SELECT_APPOINTMENT_SLOT') {
    if (isGlobalCancelMenu(text)) {
      return {
        replyText: 'Listo. Volvemos al menu:\n1) Sacar turno\n2) Precios\n3) Direccion',
        newState: 'READY',
        contextPatch: {
          appointmentSuggestions: null,
          appointmentSuggestionsCreatedAt: null
        }
      };
    }

    if (!/^[123]$/.test(normalizeCommandText(text))) {
      return {
        replyText: 'Responde con 1, 2 o 3 para elegir un horario.',
        newState: 'SELECT_APPOINTMENT_SLOT',
        contextPatch: null
      };
    }

    return {
      replyText: 'Perfecto. Estoy confirmando ese horario...',
      newState: 'SELECT_APPOINTMENT_SLOT',
      contextPatch: null
    };
  }

  if (currentState === 'CONFIRM_APPOINTMENT') {
    if (!safeContext.appointmentCandidate) {
      return {
        replyText: 'Se me perdio el horario. Decime dia y hora nuevamente (ej: lunes 10:30).',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: null
      };
    }

    if (isGlobalCancelMenu(text)) {
      return {
        replyText: 'Listo. Volvemos al menu:\n1) Sacar turno\n2) Precios\n3) Direccion',
        newState: 'READY',
        contextPatch: {
          appointmentCandidate: null
        }
      };
    }

    if (isAffirmative(text)) {
      const candidate = safeContext.appointmentCandidate || null;
      return {
        replyText: 'Listo. Registré tu pedido de turno. En breve te confirmamos disponibilidad.',
        newState: 'READY',
        contextPatch: {
          appointmentConfirmed: {
            rawText: candidate && candidate.rawText ? candidate.rawText : text,
            confirmedAt: new Date().toISOString()
          },
          appointmentStatus: 'requested',
          appointmentRequestedAt: new Date().toISOString()
        }
      };
    }

    if (isNegative(text)) {
      return {
        replyText: 'Perfecto, decime nuevamente dia y horario (ej: lunes 10:30).',
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: {
          appointmentCandidate: null
        }
      };
    }

    return {
      replyText: "Confirmas el turno? Responde 'si' o 'no'.",
      newState: 'CONFIRM_APPOINTMENT',
      contextPatch: null
    };
  }

  return {
    replyText: 'Te ayudo con:\n1) Sacar turno\n2) Precios\n3) Direccion',
    newState: 'READY',
    contextPatch: safeContext
  };
}

module.exports = {
  decideReply
};
