const { resolvePortalTenantContext } = require('./portal-context.service');
const { findChannelByIdAndClinicId } = require('../repositories/tenant.repository');
const { listWhatsAppTemplatesByClinicId, findWhatsAppTemplateByIdAndScope } = require('../repositories/whatsapp-templates.repository');
const { listOperationalAlertRecipients, findOperationalAlertRecipientById } = require('../repositories/operational-alert-recipients.repository');
const canaryRepo = require('../repositories/whatsapp-template-canary.repository');
const { upsertContact } = require('../repositories/contact.repository');
const conversationRepo = require('../conversations/conversation.repo');
const { sendChannelScopedMessage } = require('../whatsapp/whatsapp.service');
const { normalizeWhatsAppTo } = require('../whatsapp/normalize-phone');
const { variableDescriptors, validateVariables, buildTemplatePayload, unsupportedTemplateReason } = require('../whatsapp/whatsapp-template-canary-domain');
const { logInfo, logWarn } = require('../utils/logger');
const { syncPortalWhatsAppTemplates } = require('./portal-whatsapp-templates.service');

function normalize(value) { return String(value || '').trim(); }
function maskPhone(value) {
  const digits = normalizeWhatsAppTo(value);
  return digits.length > 4 ? `+${'*'.repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}` : '••••';
}
function safeError(error) {
  return {
    graphStatus: Number.isFinite(Number(error && error.graphStatus)) ? Number(error.graphStatus) : null,
    graphErrorCode: Number.isFinite(Number(error && error.graphErrorCode)) ? Number(error.graphErrorCode) : null,
    graphErrorSubcode: Number.isFinite(Number(error && error.graphErrorSubcode)) ? Number(error.graphErrorSubcode) : null,
    message: normalize(error && (error.graphErrorMessage || error.message)).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500) || null,
    fbtraceId: normalize(error && error.fbtrace_id).slice(0, 200) || null
  };
}
function summarizeAttempt(row) {
  if (!row) return null;
  return {
    id: row.id, templateId: row.templateId, templateName: row.templateName, language: row.language,
    recipientId: row.recipientId, recipientName: row.recipientName || null,
    recipientMasked: row.recipientMasked || null, actorId: row.actorId, status: row.status,
    providerMessageId: row.providerMessageId || null, conversationId: row.conversationId || null,
    errorCode: row.errorCode || null, errorDetail: row.errorDetail || null, errorMetadata: row.errorMetadata || null,
    sentAt: row.sentAt || null, deliveredAt: row.deliveredAt || null, readAt: row.readAt || null,
    failedAt: row.failedAt || null, createdAt: row.createdAt, updatedAt: row.updatedAt
  };
}
async function resolveContext(tenantId) {
  const context = await resolvePortalTenantContext(tenantId);
  if (!context.ok || !context.clinic || !context.clinic.id) return context;
  if (!context.channel || !context.channel.id) return { ok: false, reason: 'whatsapp_channel_not_found', tenantId };
  const channel = await findChannelByIdAndClinicId(context.channel.id, context.clinic.id);
  if (!channel || normalize(channel.provider).toLowerCase() !== 'whatsapp_cloud' || normalize(channel.status).toLowerCase() !== 'active') {
    return { ok: false, reason: 'whatsapp_channel_not_connected', tenantId };
  }
  if (!channel.accessToken || !channel.phoneNumberId || !channel.wabaId) return { ok: false, reason: 'whatsapp_channel_not_ready', tenantId };
  return { ok: true, tenantId: context.tenantId, clinic: context.clinic, channel };
}
async function getCanaryWorkspace(tenantId) {
  const context = await resolveContext(tenantId);
  if (!context.ok) return context;
  const [templates, recipients, attempts] = await Promise.all([
    listWhatsAppTemplatesByClinicId(context.clinic.id),
    listOperationalAlertRecipients(context.clinic.id, { active: true, limit: 100 }),
    canaryRepo.listRecent(context.clinic.id, 10)
  ]);
  const allowedRecipients = recipients.filter((item) => item.active && item.consentStatus === 'granted' && /^\+[1-9][0-9]{7,14}$/.test(item.phoneE164));
  return {
    ok: true, tenantId: context.tenantId,
    channel: { id: context.channel.id, wabaId: context.channel.wabaId, phoneNumberId: context.channel.phoneNumberId,
      displayPhoneNumber: context.channel.displayPhoneNumber || null, verifiedName: context.channel.verifiedName || null, status: context.channel.status },
    templates: templates.filter((item) => String(item.channelId) === String(context.channel.id) && String(item.wabaId) === String(context.channel.wabaId))
      .map((item) => { const unsupportedReason = unsupportedTemplateReason(item); return { ...item, variables: variableDescriptors(item), unsupportedReason,
        canSend: normalize(item.status).toLowerCase() === 'approved' && !unsupportedReason }; }),
    recipients: allowedRecipients.map((item) => ({ id: item.id, name: item.name, phoneMasked: maskPhone(item.phoneE164), consentStatus: item.consentStatus })),
    attempts: attempts.map((item) => summarizeAttempt({ ...item, recipientMasked: maskPhone(recipients.find((recipient) => recipient.id === item.recipientId)?.phoneE164) }))
  };
}

async function refreshCanaryWorkspace(tenantId) {
  const synced = await syncPortalWhatsAppTemplates(tenantId);
  if (!synced.ok) return synced;
  const workspace = await getCanaryWorkspace(tenantId);
  if (!workspace.ok) return workspace;
  return {
    ...workspace,
    sync: {
      syncedCount: synced.syncedCount,
      summary: synced.summary || null
    }
  };
}
async function sendCanary(tenantId, payload, actor) {
  const context = await resolveContext(tenantId);
  if (!context.ok) return context;
  const idempotencyKey = normalize(payload && payload.idempotencyKey);
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(idempotencyKey)) return { ok: false, reason: 'invalid_idempotency_key', status: 400 };
  const existing = await canaryRepo.findByIdempotencyKey(context.clinic.id, idempotencyKey);
  if (existing) return { ok: true, replayed: true, attempt: summarizeAttempt(existing) };
  const [template, recipient] = await Promise.all([
    findWhatsAppTemplateByIdAndScope({ id: normalize(payload.templateId), clinicId: context.clinic.id, channelId: context.channel.id, wabaId: context.channel.wabaId }),
    findOperationalAlertRecipientById(normalize(payload.recipientId), context.clinic.id)
  ]);
  if (!template) return { ok: false, reason: 'whatsapp_template_not_found', status: 404 };
  if (normalize(template.status).toLowerCase() !== 'approved') return { ok: false, reason: 'whatsapp_template_not_sendable', status: 409 };
  if (unsupportedTemplateReason(template)) return { ok: false, reason: 'whatsapp_template_component_unsupported', status: 409 };
  if (!recipient || !recipient.active || recipient.consentStatus !== 'granted') return { ok: false, reason: 'whatsapp_canary_recipient_not_authorized', status: 400 };
  const validation = validateVariables(template, payload.variables);
  if (!validation.ok) return { ok: false, reason: 'whatsapp_template_variables_missing', status: 400, details: { missing: validation.missing } };
  const built = buildTemplatePayload(template, validation.variables);
  const claimed = await canaryRepo.createAttempt({ clinicId: context.clinic.id, channelId: context.channel.id, templateId: template.id,
    recipientId: recipient.id, actorId: actor.id, idempotencyKey, templateName: template.metaTemplateName, language: template.language,
    variables: validation.variables, preview: { components: built.preview, recipientMasked: maskPhone(recipient.phoneE164), sender: context.channel.displayPhoneNumber || context.channel.phoneNumberId } });
  let attempt = claimed.row;
  if (!claimed.created) return { ok: true, replayed: true, attempt: summarizeAttempt(attempt) };
  let providerMessageId = null;
  try {
    const sent = await sendChannelScopedMessage({ to: normalizeWhatsAppTo(recipient.phoneE164), templateName: template.metaTemplateName,
      languageCode: template.language, components: built.components }, { requestId: `wa_canary_${attempt.id}`, credentials: {
        accessToken: context.channel.accessToken, phoneNumberId: context.channel.phoneNumberId, channelId: context.channel.id,
        clinicId: context.clinic.id, tenantId: context.tenantId, wabaId: context.channel.wabaId,
        provider: context.channel.provider, status: context.channel.status
      }, suppressRoutingDiagnostics: true });
    providerMessageId = normalize(sent && sent.messageId);
    if (!providerMessageId) throw new Error('graph_success_without_provider_message_id');
    attempt = await canaryRepo.withTransaction(async (client) => {
      const digits = normalizeWhatsAppTo(recipient.phoneE164);
      const contact = await upsertContact({ clinicId: context.clinic.id, waId: digits, phone: recipient.phoneE164, name: recipient.name }, client);
      const conversation = await conversationRepo.upsertOutboundConversation({ waFrom: digits, waTo: normalizeWhatsAppTo(context.channel.displayPhoneNumber || context.channel.phoneNumberId),
        clinicId: context.clinic.id, channelId: context.channel.id, contactId: contact.id }, client);
      const inbox = await conversationRepo.insertOutboundMessage({ clinicId: context.clinic.id, channelId: context.channel.id, conversationId: conversation.id,
        waMessageId: providerMessageId, from: context.channel.phoneNumberId, to: digits, type: 'template',
        text: built.preview.map((part) => part.text).filter(Boolean).join('\n'), raw: { whatsappTemplateCanary: { attemptId: attempt.id,
          templateId: template.id, templateName: template.metaTemplateName, language: template.language } } }, client);
      return canaryRepo.updateAttempt(attempt.id, context.clinic.id, { status: 'sent', providerMessageId, conversationId: conversation.id,
        inboxMessageId: inbox.row.id, sentAt: new Date().toISOString() }, client);
    });
    logInfo('whatsapp_template_canary_sent', { tenantId: context.tenantId, clinicId: context.clinic.id, attemptId: attempt.id,
      actorId: actor.id, templateName: template.metaTemplateName, recipientMasked: maskPhone(recipient.phoneE164), providerMessageId });
    return { ok: true, replayed: false, attempt: summarizeAttempt({ ...attempt, recipientMasked: maskPhone(recipient.phoneE164) }) };
  } catch (error) {
    const diagnostic = safeError(error);
    const status = providerMessageId ? 'unknown_delivery' : 'failed';
    attempt = await canaryRepo.updateAttempt(attempt.id, context.clinic.id, { status, providerMessageId, errorCode: providerMessageId ? 'inbox_persistence_failed' : 'whatsapp_graph_send_failed',
      errorDetail: diagnostic.message, errorMetadata: diagnostic, failedAt: status === 'failed' ? new Date().toISOString() : null });
    logWarn('whatsapp_template_canary_failed', { tenantId: context.tenantId, attemptId: attempt.id, status, graphStatus: diagnostic.graphStatus });
    return { ok: false, reason: status === 'unknown_delivery' ? 'whatsapp_canary_delivery_unknown' : 'whatsapp_canary_send_failed', status: status === 'unknown_delivery' ? 409 : 502,
      attempt: summarizeAttempt({ ...attempt, recipientMasked: maskPhone(recipient.phoneE164) }) };
  }
}

module.exports = { getCanaryWorkspace, refreshCanaryWorkspace, sendCanary, maskPhone, summarizeAttempt };
