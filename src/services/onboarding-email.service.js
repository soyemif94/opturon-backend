const fs = require('fs/promises');
const path = require('path');
const env = require('../config/env');
const { query } = require('../db/client');

const CLIENT_DECK = path.join(__dirname, '../../assets/onboarding/Opturon_Primeros_Pasos_Cliente.pptx');
const ADVISOR_DECK = path.join(__dirname, '../../assets/onboarding/Opturon_Guia_Asesor_Comercial.pptx');

function text(value) { return String(value || '').trim(); }
function escapeHtml(value) { return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function publicUrl(pathname) { return `${text(process.env.FRONTEND_PUBLIC_URL || process.env.APP_PUBLIC_URL || env.opturonPublicAppUrl || 'https://www.opturon.com').replace(/\/$/, '')}${pathname}`; }
function fromAddress() { return text(env.billingEmailFrom || env.portalInvitationEmailFrom || env.resetEmailFrom); }

async function sendOnboardingEmail({ to, subject, title, body, deckPath, deckName, linkPath, idempotencyKey }) {
  const apiKey = text(env.resendApiKey);
  const from = fromAddress();
  if (!apiKey || !from || !to) return { ok: false, skipped: true, reason: 'onboarding_email_not_configured' };
  const claim = await query(`INSERT INTO onboarding_email_deliveries ("eventKey", status) VALUES ($1, 'pending') ON CONFLICT ("eventKey") DO NOTHING RETURNING id`, [idempotencyKey]);
  if (claim.rowCount === 0) return { ok: true, duplicate: true, reason: 'onboarding_email_already_claimed' };
  const content = await fs.readFile(deckPath);
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [text(to).toLowerCase()],
      subject,
      headers: { 'X-Opturon-Event-Key': text(idempotencyKey) },
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#102033"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(publicUrl(linkPath))}">Descargar material</a></p><p>Equipo Opturon</p></div>`,
      attachments: [{ filename: deckName, content: content.toString('base64') }]
    })
    });
  } catch (error) {
    await query(`UPDATE onboarding_email_deliveries SET status = 'failed', "updatedAt" = NOW() WHERE "eventKey" = $1`, [idempotencyKey]);
    throw error;
  }
  if (!response.ok) {
    await query(`UPDATE onboarding_email_deliveries SET status = 'failed', "updatedAt" = NOW() WHERE "eventKey" = $1`, [idempotencyKey]);
    return { ok: false, reason: `resend_http_${response.status}` };
  }
  const payload = await response.json().catch(() => ({}));
  await query(`UPDATE onboarding_email_deliveries SET status = 'sent', provider = 'resend', "providerMessageId" = $2, "sentAt" = NOW(), "updatedAt" = NOW() WHERE "eventKey" = $1`, [idempotencyKey, payload.id || null]);
  return { ok: true, provider: 'resend', id: payload.id || null };
}

function sendClientWelcomeEmail(input) {
  return sendOnboardingEmail({
    to: input.email,
    subject: 'Bienvenido/a a Opturon — primeros pasos',
    title: 'Bienvenido/a a Opturon',
    body: 'Tu cuenta fue creada. Si todavía no completaste un pago aprobado, Opturon permanece restringido hasta activar tu plan.',
    deckPath: CLIENT_DECK,
    deckName: 'Opturon_Primeros_Pasos_Cliente.pptx',
    linkPath: '/onboarding/Opturon_Primeros_Pasos_Cliente.pptx',
    idempotencyKey: input.idempotencyKey
  });
}

function sendAdvisorApplicationReceivedEmail(input) {
  return sendOnboardingEmail({
    to: input.email,
    subject: 'Recibimos tu solicitud para ser Asesor/a Opturon',
    title: 'Solicitud recibida',
    body: 'Recibimos tu solicitud. La revisión está pendiente y el Portal del Asesor comercial se habilita únicamente después de la aprobación.',
    deckPath: ADVISOR_DECK,
    deckName: 'Opturon_Guia_Asesor_Comercial.pptx',
    linkPath: '/onboarding/Opturon_Guia_Asesor_Comercial.pptx',
    idempotencyKey: input.idempotencyKey
  });
}

function sendAdvisorApprovalEmail(input) {
  return sendOnboardingEmail({
    to: input.email,
    subject: 'Tu alta como Asesor/a Opturon fue aprobada',
    title: 'Tu alta fue aprobada',
    body: 'Tu acceso al Portal del Asesor ya está listo. Ingresá con el enlace seguro de activación que recibís en este mensaje.',
    deckPath: ADVISOR_DECK,
    deckName: 'Opturon_Guia_Asesor_Comercial.pptx',
    linkPath: '/onboarding/Opturon_Guia_Asesor_Comercial.pptx',
    idempotencyKey: input.idempotencyKey
  });
}

function sendClientActivationEmail(input) {
  const plan = text(input.planName || input.planKey) || 'tu plan';
  const advanced = input.aiProvisioningRequired !== false;
  return sendOnboardingEmail({
    to: input.email,
    subject: 'Tu plan de Opturon ya está activo',
    title: 'Tu plan de Opturon ya está activo',
    body: `Tu plan ${plan} fue activado después de un pago aprobado. Ya podés ingresar a Opturon y preparar tu negocio, catálogo y canales.${advanced ? ' La configuración inicial de automatizaciones y funciones inteligentes puede demorar entre 24 y 48 horas.' : ''}`,
    deckPath: CLIENT_DECK,
    deckName: 'Opturon_Primeros_Pasos_Cliente.pptx',
    linkPath: '/app',
    idempotencyKey: input.idempotencyKey
  });
}

function sendAiReadyEmail(input) {
  return sendOnboardingEmail({
    to: input.email,
    subject: 'Tu configuración de Opturon está completa',
    title: 'Tu configuración de Opturon está completa',
    body: 'Las funciones inteligentes correspondientes a tu plan ya están disponibles. Revisá tus canales y configuración antes de activar la atención automática; podés encenderla o apagarla desde Opturon.',
    deckPath: CLIENT_DECK,
    deckName: 'Opturon_Primeros_Pasos_Cliente.pptx',
    linkPath: '/app',
    idempotencyKey: input.idempotencyKey
  });
}

module.exports = { sendClientWelcomeEmail, sendAdvisorApplicationReceivedEmail, sendAdvisorApprovalEmail, sendClientActivationEmail, sendAiReadyEmail };
