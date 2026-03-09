require('dotenv').config();

const { query, closePool } = require('../src/db/client');
const {
  listAppointmentRequests,
  setAppointmentStatus,
  getConversationById,
  enqueueJob,
  upsertConversation
} = require('../src/conversations/conversation.repo');
const { findContactById } = require('../src/repositories/contact.repository');
const { upsertContact } = require('../src/repositories/contact.repository');
const { buildPanelMessage } = require('../src/controllers/debug.controller');

function candidateDisplay(context = {}) {
  const parsed = (context.appointmentCandidate && context.appointmentCandidate.parsed) || {};
  if (parsed.dateISO && parsed.time) return `${parsed.dateISO} ${parsed.time}`;
  if (parsed.weekday && parsed.time) return `${parsed.weekday} ${parsed.time}`;
  if (parsed.dateISO && parsed.timeWindow) return `${parsed.dateISO} ${parsed.timeWindow}`;
  if (parsed.weekday && parsed.timeWindow) return `${parsed.weekday} ${parsed.timeWindow}`;
  return (context.appointmentCandidate && context.appointmentCandidate.rawText) || 'horario solicitado';
}

async function ensureRequestedConversation() {
  const current = await listAppointmentRequests({ limit: 1, offset: 0 });
  if (current[0]) return current[0];

  const fallback = await query(
    `SELECT id, "clinicId", "channelId", "contactId", state, context, "updatedAt"
     FROM conversations
     ORDER BY "updatedAt" DESC
     LIMIT 1`
  );
  const row = fallback.rows[0];
  if (!row) {
    const channelResult = await query(
      `SELECT id, "clinicId", "phoneNumberId"
       FROM channels
       WHERE status = 'active'
       ORDER BY "createdAt" ASC
       LIMIT 1`
    );
    const channel = channelResult.rows[0];
    if (!channel) {
      throw new Error('No hay conversaciones ni channels activos para testear panel.');
    }

    const waId = `549299${Date.now().toString().slice(-7)}`;
    const contact = await upsertContact({
      clinicId: channel.clinicId,
      waId,
      phone: waId,
      name: 'Panel Test'
    });

    const createdConversation = await upsertConversation({
      waFrom: waId,
      waTo: String(channel.phoneNumberId),
      clinicId: channel.clinicId,
      channelId: channel.id,
      contactId: contact.id
    });

    await setAppointmentStatus({
      conversationId: createdConversation.id,
      status: 'requested',
      patch: {
        appointmentRequestedAt: new Date().toISOString(),
        appointmentCandidate: {
          rawText: 'lunes 10:30',
          parsed: { weekday: 'monday', time: '10:30' },
          createdAt: new Date().toISOString()
        }
      }
    });

    return getConversationById(createdConversation.id);
  }

  await setAppointmentStatus({
    conversationId: row.id,
    status: 'requested',
    patch: {
      appointmentRequestedAt: new Date().toISOString(),
      appointmentCandidate: {
        rawText: 'lunes 10:30',
        parsed: { weekday: 'monday', time: '10:30' },
        createdAt: new Date().toISOString()
      }
    }
  });

  const refreshed = await getConversationById(row.id);
  return refreshed;
}

async function runAction({ conversation, actionType, text }) {
  const contact = await findContactById(conversation.contactId);
  if (!contact || !contact.waId) {
    throw new Error(`No waId para contactId=${conversation.contactId}`);
  }

  const actionId = `dev-panel-${actionType}-${Date.now()}`;
  let status = 'requested';
  let patch = { appointmentLastActionId: actionId };

  if (actionType === 'confirm') {
    status = 'confirmed';
    patch = {
      ...patch,
      appointmentClinicResponse: {
        type: 'confirmed',
        confirmedText: candidateDisplay(conversation.context || {}),
        message: text
      }
    };
  } else if (actionType === 'reject') {
    status = 'rejected';
    patch = {
      ...patch,
      appointmentClinicResponse: {
        type: 'rejected',
        message: text
      }
    };
  } else {
    status = 'reschedule_proposed';
    patch = {
      ...patch,
      appointmentRescheduleProposal: {
        proposed: text,
        createdAt: new Date().toISOString(),
        createdBy: 'human_panel'
      },
      appointmentClinicResponse: {
        type: 'reschedule_proposed',
        message: null
      }
    };
  }

  const updated = await setAppointmentStatus({
    conversationId: conversation.id,
    status,
    patch
  });

  const job = await enqueueJob('whatsapp_send', {
    clinicId: conversation.clinicId,
    channelId: conversation.channelId,
    conversationId: conversation.id,
    contactId: conversation.contactId,
    to: contact.waId,
    text,
    type: 'text'
  });

  return {
    actionType,
    status,
    actionId,
    patchApplied: patch,
    contextAfter: updated ? updated.context : null,
    enqueuedJob: job
  };
}

function runMessageChecks() {
  const suffix = "Si necesitás cambiarlo, respondé 'menu'.";
  const custom = 'Perfecto, te confirmo el turno';
  const withSuffix = buildPanelMessage({
    baseText: custom,
    defaultText: 'default',
    suffix
  });
  const alreadyHasMenu = buildPanelMessage({
    baseText: "Perfecto. Si necesitás cambiarlo, respondé 'menu'.",
    defaultText: 'default',
    suffix
  });

  return {
    customMessageApplied: withSuffix.toLowerCase().includes(custom.toLowerCase()),
    suffixAdded: /menu/i.test(withSuffix),
    duplicatedSuffix: (alreadyHasMenu.match(/menu/gi) || []).length > 1
  };
}

async function main() {
  const baseConversation = await ensureRequestedConversation();
  const conversation = await getConversationById(baseConversation.id);

  const confirm = await runAction({
    conversation,
    actionType: 'confirm',
    text: buildPanelMessage({
      baseText: `✅ Turno confirmado. Te esperamos el ${candidateDisplay(conversation.context || {})}`,
      defaultText: '',
      suffix: "Si necesitás cambiarlo, respondé 'menu'."
    })
  });

  const reject = await runAction({
    conversation,
    actionType: 'reject',
    text: "❌ No tenemos disponibilidad en ese horario. Respondé con otro día/hora o escribí 'menu' para opciones."
  });

  const reschedule = await runAction({
    conversation,
    actionType: 'reschedule',
    text: 'martes 11:00'
  });

  console.log(
    JSON.stringify(
      {
        success: true,
        conversationId: conversation.id,
        messageChecks: runMessageChecks(),
        actions: {
          confirm,
          reject,
          reschedule
        }
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error.message
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
