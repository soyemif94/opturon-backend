const env = require('../config/env');

const INVITATION_TTL_HOURS = 168;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  const email = normalizeString(value).toLowerCase();
  return email && email.includes('@') ? email : null;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveInvitationEmailFrom() {
  return (
    normalizeString(env.portalInvitationEmailFrom)
    || normalizeString(env.resetEmailFrom)
    || normalizeString(env.billingEmailFrom)
    || ''
  );
}

function resolvePartnerPortalBaseUrl() {
  return String(
    process.env.PARTNER_PORTAL_INVITATION_BASE_URL
    || env.partnerPortalInvitationBaseUrl
    || process.env.PARTNER_PORTAL_BASE_URL
    || 'https://partners.opturon.com'
  )
    .trim()
    .replace(/\/$/, '');
}

function buildPartnerInvitationAcceptLink(token) {
  const baseUrl = resolvePartnerPortalBaseUrl();
  if (!baseUrl) {
    const error = new Error('partner_invitation_base_url_not_configured');
    error.code = 'partner_invitation_base_url_not_configured';
    throw error;
  }
  const invitationPath = baseUrl.endsWith('/invite') || baseUrl.endsWith('/partners/invite') ? '' : '/invite';
  return `${baseUrl}${invitationPath}?token=${encodeURIComponent(token)}`;
}

function buildPartnerInvitationEmailHtml(input) {
  const invitedName = escapeHtml(input.displayName || 'asesor');
  const sponsorName = escapeHtml(input.sponsorDisplayName || '');
  const expiresAtText = new Date(input.expiresAt).toLocaleString('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;background:#f6f3ee;padding:24px;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;border:1px solid #eadfd2;">
        <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#a16207;font-weight:700;">Opturon</div>
        <h1 style="margin:12px 0 8px;font-size:28px;line-height:1.2;color:#111827;">Te invitaron al Portal de asesores</h1>
        <p style="margin:0 0 16px;color:#4b5563;">Hola ${invitedName}, ya esta listo tu acceso seguro al portal comercial de Opturon.</p>
        <div style="margin:0 0 20px;padding:16px;border-radius:14px;background:#f9f6f1;border:1px solid #eadfd2;">
          <p style="margin:0 0 8px;color:#111827;"><strong>Email:</strong> ${escapeHtml(input.email)}</p>
          <p style="margin:0 0 8px;color:#111827;"><strong>Codigo:</strong> ${escapeHtml(input.code)}</p>
          ${sponsorName ? `<p style="margin:0;color:#111827;"><strong>Sponsor:</strong> ${sponsorName}</p>` : ''}
        </div>
        <p style="margin:0 0 20px;color:#4b5563;">
          Para activar tu cuenta, define tu contrasena desde el siguiente enlace seguro. Este acceso vence en ${INVITATION_TTL_HOURS} horas.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${escapeHtml(input.acceptLink)}" style="display:inline-block;padding:12px 18px;background:#c05000;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">
            Activar acceso
          </a>
        </p>
        <p style="margin:0 0 12px;color:#4b5563;font-size:14px;">Este enlace vence el ${expiresAtText}.</p>
        <p style="margin:0 0 12px;color:#4b5563;font-size:14px;">Nadie de Opturon te va a pedir esta contrasena por email, chat ni telefono.</p>
        <p style="margin:0;color:#6b7280;font-size:14px;word-break:break-all;">${escapeHtml(input.acceptLink)}</p>
      </div>
    </div>
  `;
}

async function sendPartnerInvitationEmail(input) {
  const apiKey = normalizeString(env.resendApiKey);
  const from = resolveInvitationEmailFrom();
  const to = normalizeEmail(input.email);

  if (!apiKey || !from) {
    const error = new Error('partner_invitation_email_not_configured');
    error.code = 'partner_invitation_email_not_configured';
    throw error;
  }

  if (!to) {
    const error = new Error('partner_invitation_email_missing_recipient');
    error.code = 'partner_invitation_email_missing_recipient';
    throw error;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Te invitaron al Portal de asesores',
      html: buildPartnerInvitationEmailHtml(input)
    })
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const error = new Error(`partner_invitation_email_send_failed_${response.status}`);
    error.code = 'partner_invitation_email_send_failed';
    error.status = response.status;
    error.body = json || text || null;
    throw error;
  }

  return {
    provider: 'resend',
    id: json && json.id ? json.id : null,
    to
  };
}

module.exports = {
  buildPartnerInvitationAcceptLink,
  sendPartnerInvitationEmail
};
