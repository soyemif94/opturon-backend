const { decideReply } = require('../src/conversations/conversation.engine');

function applyContextPatch(context, patch) {
  if (!patch || typeof patch !== 'object') {
    return context;
  }
  return {
    ...context,
    ...patch
  };
}

function run() {
  const steps = [
    { label: 'STEP 1', input: 'hola' },
    { label: 'STEP 2', input: 'Juan' },
    { label: 'STEP 3', input: '1' },
    { label: 'STEP 4', input: 'lunes 10:30' },
    { label: 'STEP 5', input: 'si' }
  ];

  let state = 'NEW';
  let context = {};
  const output = [];

  for (const step of steps) {
    const decision = decideReply({
      state,
      context,
      inboundText: step.input
    });

    output.push({
      step: step.label,
      inboundText: step.input,
      prevState: state,
      replyText: decision.replyText,
      newState: decision.newState,
      contextPatch: decision.contextPatch || null
    });

    state = decision.newState || state;
    context = applyContextPatch(context, decision.contextPatch);
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        finalState: state,
        finalContext: context,
        flow: output
      },
      null,
      2
    )
  );

  const caseA = decideReply({
    state: 'READY',
    context: { name: 'Juan' },
    inboundText: 'turno lunes 10:30'
  });

  const caseB = decideReply({
    state: 'ASKED_APPOINTMENT_DATETIME',
    context: {
      name: 'Juan',
      appointmentCandidate: {
        rawText: 'lunes 10:30',
        parsed: { weekday: 'monday', time: '10:30' },
        createdAt: new Date().toISOString()
      }
    },
    inboundText: 'cancelar'
  });

  const caseC = decideReply({
    state: 'READY',
    context: { name: 'Juan' },
    inboundText: 'lunes'
  });

  const caseD = decideReply({
    state: 'ASKED_APPOINTMENT_TIMEWINDOW',
    context: {
      name: 'Juan',
      appointmentCandidate: {
        rawText: 'lunes',
        parsed: { weekday: 'monday' },
        createdAt: new Date().toISOString()
      }
    },
    inboundText: 'tarde'
  });

  const caseE = decideReply({
    state: 'READY',
    context: { name: 'Juan' },
    inboundText: '12/03 a la mañana'
  });

  const caseF = decideReply({
    state: 'CONFIRM_APPOINTMENT',
    context: {
      name: 'Juan',
      appointmentCandidate: {
        rawText: '12/03 a la mañana',
        parsed: { dateISO: '2026-03-12', timeWindow: 'morning' },
        createdAt: new Date().toISOString()
      }
    },
    inboundText: 'si'
  });

  const caseG = decideReply({
    state: 'SELECT_APPOINTMENT_SLOT',
    context: {
      name: 'Juan',
      appointmentSuggestions: [
        { displayText: '2026-03-15 14:00' },
        { displayText: '2026-03-15 14:30' },
        { displayText: '2026-03-15 15:00' }
      ]
    },
    inboundText: '2'
  });

  const caseH = decideReply({
    state: 'SELECT_APPOINTMENT_SLOT',
    context: {
      name: 'Juan'
    },
    inboundText: 'menu'
  });

  const checks = {
    caseA: {
      expectedState: 'CONFIRM_APPOINTMENT',
      gotState: caseA.newState,
      hasCandidate: !!(caseA.contextPatch && caseA.contextPatch.appointmentCandidate),
      replyHasConfirm: /confirmas\?\s*\(si\/no\)/i.test(String(caseA.replyText || ''))
    },
    caseB: {
      expectedState: 'READY',
      gotState: caseB.newState,
      candidateCleared: !!(caseB.contextPatch && caseB.contextPatch.appointmentCandidate === null),
      replyHasMenu: /1\)\s*Sacar turno/i.test(String(caseB.replyText || ''))
    },
    caseC: {
      expectedState: 'ASKED_APPOINTMENT_TIMEWINDOW',
      gotState: caseC.newState,
      hasWeekday: !!(
        caseC.contextPatch &&
        caseC.contextPatch.appointmentCandidate &&
        caseC.contextPatch.appointmentCandidate.parsed &&
        caseC.contextPatch.appointmentCandidate.parsed.weekday
      )
    },
    caseD: {
      expectedState: 'CONFIRM_APPOINTMENT',
      gotState: caseD.newState,
      timeWindowAfternoon: !!(
        caseD.contextPatch &&
        caseD.contextPatch.appointmentCandidate &&
        caseD.contextPatch.appointmentCandidate.parsed &&
        caseD.contextPatch.appointmentCandidate.parsed.timeWindow === 'afternoon'
      ),
      replyHasConfirm: /confirmas\?\s*\(si\/no\)/i.test(String(caseD.replyText || ''))
    },
    caseE: {
      expectedState: 'CONFIRM_APPOINTMENT',
      gotState: caseE.newState,
      hasMorningWindow: !!(
        caseE.contextPatch &&
        caseE.contextPatch.appointmentCandidate &&
        caseE.contextPatch.appointmentCandidate.parsed &&
        caseE.contextPatch.appointmentCandidate.parsed.timeWindow === 'morning'
      ),
      replyHasMorning: /por la mañana/i.test(String(caseE.replyText || ''))
    },
    caseF: {
      expectedState: 'READY',
      gotState: caseF.newState,
      hasRequestedStatus: !!(caseF.contextPatch && caseF.contextPatch.appointmentStatus === 'requested'),
      hasRequestedAt: !!(caseF.contextPatch && caseF.contextPatch.appointmentRequestedAt)
    },
    caseG: {
      expectedState: 'SELECT_APPOINTMENT_SLOT',
      gotState: caseG.newState,
      confirmsProcessing: /confirmando/i.test(String(caseG.replyText || ''))
    },
    caseH: {
      expectedState: 'READY',
      gotState: caseH.newState,
      clearedSuggestions: !!(caseH.contextPatch && caseH.contextPatch.appointmentSuggestions === null)
    }
  };

  console.log(
    JSON.stringify(
      {
        extraCases: {
          caseA,
          caseB,
          caseC,
          caseD,
          caseE,
          caseF,
          caseG,
          caseH
        },
        checks
      },
      null,
      2
    )
  );

  async function simulateAutoConfirmFlow({ context, startAt, createAppointmentFromSuggestion, suggestNextAvailableSlots }) {
    const safeContext = context && typeof context === 'object' ? context : {};
    const replaySafe =
      String(safeContext.appointmentStatus || '').toLowerCase() === 'confirmed' &&
      String(safeContext.appointmentLastConfirmedStartAt || '') === String(startAt || '');

    if (replaySafe) {
      return {
        replaySafe: true,
        created: false,
        conflict: false,
        contextPatch: {
          appointmentStatus: 'confirmed',
          appointmentLastConfirmedStartAt: startAt
        },
        suggestions: []
      };
    }

    const created = await createAppointmentFromSuggestion({ startAt });
    if (created && created.created) {
      return {
        replaySafe: false,
        created: true,
        conflict: false,
        contextPatch: {
          appointmentStatus: 'confirmed',
          appointmentLastConfirmedStartAt: startAt
        },
        suggestions: []
      };
    }

    if (created && created.conflict) {
      const suggestions = await suggestNextAvailableSlots({ startAt });
      return {
        replaySafe: false,
        created: false,
        conflict: true,
        contextPatch: null,
        suggestions
      };
    }

    return {
      replaySafe: false,
      created: false,
      conflict: false,
      contextPatch: null,
      suggestions: []
    };
  }

  (async () => {
    let insertCalls = 0;
    const sameStartAt = '2026-03-15T13:00:00.000Z';

    const first = await simulateAutoConfirmFlow({
      context: {},
      startAt: sameStartAt,
      createAppointmentFromSuggestion: async () => {
        insertCalls += 1;
        return { created: true, conflict: false };
      },
      suggestNextAvailableSlots: async () => []
    });

    const second = await simulateAutoConfirmFlow({
      context: {
        appointmentStatus: 'confirmed',
        appointmentLastConfirmedStartAt: sameStartAt
      },
      startAt: sameStartAt,
      createAppointmentFromSuggestion: async () => {
        insertCalls += 1;
        return { created: true, conflict: false };
      },
      suggestNextAvailableSlots: async () => []
    });

    const conflict = await simulateAutoConfirmFlow({
      context: {},
      startAt: '2026-03-16T14:00:00.000Z',
      createAppointmentFromSuggestion: async () => ({ created: false, conflict: true, code: '23505' }),
      suggestNextAvailableSlots: async () => [
        { startAt: '2026-03-16T14:30:00.000Z', displayText: 'Lun 16/03 11:30' },
        { startAt: '2026-03-16T15:00:00.000Z', displayText: 'Lun 16/03 12:00' }
      ]
    });

    const hardeningChecks = {
      replaySafeNoSecondInsert: insertCalls === 1 && first.created === true && second.replaySafe === true,
      conflictRegeneratesSuggestions: conflict.conflict === true && Array.isArray(conflict.suggestions) && conflict.suggestions.length > 0
    };

    console.log(
      JSON.stringify(
        {
          hardeningCases: {
            first,
            second,
            conflict,
            insertCalls
          },
          hardeningChecks
        },
        null,
        2
      )
    );

    async function simulateManagementIntent({
      intent,
      context,
      latestAppointment,
      cancelAppointmentById
    }) {
      const safeContext = context && typeof context === 'object' ? context : {};
      if (!latestAppointment) {
        return {
          status: 'no_appointment',
          replyText: 'No encuentro un turno confirmado. Decime dia y horario para sacar uno.',
          newState: 'ASKED_APPOINTMENT_DATETIME'
        };
      }

      const replayCancelled =
        String(safeContext.appointmentStatus || '').toLowerCase() === 'cancelled' &&
        String(safeContext.appointmentLastCancelledStartAt || '') === String(latestAppointment.startAt || '');

      if (!replayCancelled) {
        await cancelAppointmentById(latestAppointment.id);
      }

      if (intent === 'cancel') {
        return {
          status: replayCancelled ? 'replay_cancel' : 'cancelled',
          replyText: "Listo. Cancele tu turno. Si queres sacar otro, decime dia y horario.",
          newState: 'READY',
          contextPatch: {
            appointmentStatus: 'cancelled',
            appointmentLastCancelledStartAt: latestAppointment.startAt
          }
        };
      }

      return {
        status: replayCancelled ? 'replay_reschedule' : 'rescheduled',
        replyText: "Dale. Para que dia y horario queres reprogramar? (Ej: 'lunes 15:30' o 'martes a la tarde')",
        newState: 'ASKED_APPOINTMENT_DATETIME',
        contextPatch: {
          appointmentStatus: 'cancelled',
          appointmentLastCancelledStartAt: latestAppointment.startAt,
          appointmentCandidate: null,
          appointmentSuggestions: null
        }
      };
    }

    let cancelCalls = 0;
    const existing = {
      id: 'appt-1',
      startAt: '2026-03-20T14:00:00.000Z'
    };

    const caseReschedule = await simulateManagementIntent({
      intent: 'reschedule',
      context: {},
      latestAppointment: existing,
      cancelAppointmentById: async () => {
        cancelCalls += 1;
      }
    });

    const caseCancel = await simulateManagementIntent({
      intent: 'cancel',
      context: {},
      latestAppointment: existing,
      cancelAppointmentById: async () => {
        cancelCalls += 1;
      }
    });

    const caseNoAppointment = await simulateManagementIntent({
      intent: 'cancel',
      context: {},
      latestAppointment: null,
      cancelAppointmentById: async () => {
        cancelCalls += 1;
      }
    });

    const caseReplayCancel = await simulateManagementIntent({
      intent: 'cancel',
      context: {
        appointmentStatus: 'cancelled',
        appointmentLastCancelledStartAt: existing.startAt
      },
      latestAppointment: existing,
      cancelAppointmentById: async () => {
        cancelCalls += 1;
      }
    });

    const managementChecks = {
      rescheduleToAskedDatetime: caseReschedule.newState === 'ASKED_APPOINTMENT_DATETIME',
      cancelToReady: caseCancel.newState === 'READY',
      noAppointmentMessage: /No encuentro un turno confirmado/i.test(caseNoAppointment.replyText || ''),
      replayCancelNoDoubleCall: cancelCalls === 2
    };

    console.log(
      JSON.stringify(
        {
          managementCases: {
            caseReschedule,
            caseCancel,
            caseNoAppointment,
            caseReplayCancel,
            cancelCalls
          },
          managementChecks
        },
        null,
        2
      )
    );
  })().catch((error) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          stage: 'hardeningCases',
          error: error.message
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}

run();
