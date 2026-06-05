const env = require('../config/env');

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  const email = normalizeString(value).toLowerCase();
  return email && email.includes('@') ? email : null;
}

function resolveEmailFrom() {
  return (
    normalizeString(env.billingEmailFrom) ||
    normalizeString(env.portalInvitationEmailFrom) ||
    normalizeString(env.resetEmailFrom) ||
    ''
  );
}

function formatMoney(amount, currency) {
  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount)) return `${amount} ${currency || 'ARS'}`.trim();
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency || 'ARS',
      maximumFractionDigits: 2
    }).format(safeAmount);
  } catch {
    return `${safeAmount} ${currency || 'ARS'}`.trim();
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildBillingSubscriptionEmailHtml(input) {
  const greeting = input.clientName ? `Hola ${escapeHtml(input.clientName)},` : 'Hola,';
  const planLabel = escapeHtml(input.planLabel);
  const amountLabel = escapeHtml(formatMoney(input.amount, input.currency));
  const authorizationUrl = escapeHtml(input.authorizationUrl);

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;background:#f6f3ee;padding:24px;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:20px;padding:32px;border:1px solid #eadfd2;">
        <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#a16207;font-weight:700;">Opturon</div>
        <h1 style="margin:12px 0 8px;font-size:28px;line-height:1.2;color:#111827;">Autoriza tu suscripcion</h1>
        <p style="margin:0 0 16px;color:#4b5563;">${greeting}</p>
        <p style="margin:0 0 16px;color:#4b5563;">
          Ya esta listo el link para autorizar tu suscripcion mensual a Opturon.
        </p>
        <div style="margin:0 0 20px;padding:16px;border-radius:14px;background:#f9f6f1;border:1px solid #eadfd2;">
          <p style="margin:0 0 8px;color:#111827;"><strong>Plan:</strong> ${planLabel}</p>
          <p style="margin:0;color:#111827;"><strong>Importe mensual:</strong> ${amountLabel}</p>
        </div>
        <p style="margin:0 0 20px;color:#4b5563;">
          Para activar el debito mensual seguro desde Mercado Pago, ingresa desde el siguiente enlace:
        </p>
        <p style="margin:0 0 24px;">
          <a href="${authorizationUrl}" style="display:inline-block;padding:12px 18px;background:#c05000;color:#fff;text-decoration:none;border-radius:12px;font-weight:700;">
            Autorizar suscripcion
          </a>
        </p>
        <p style="margin:0 0 12px;color:#4b5563;font-size:14px;">
          Si prefieres copiar el link manualmente:
        </p>
        <p style="margin:0 0 24px;color:#6b7280;font-size:13px;word-break:break-all;">
          ${authorizationUrl}
        </p>
        <p style="margin:0;color:#6b7280;font-size:14px;">
          Si ya completaste este paso, puedes ignorar este mensaje.
        </p>
        <p style="margin:20px 0 0;color:#111827;font-size:14px;font-weight:600;">Equipo Opturon</p>
      </div>
    </div>
  `;
}

async function sendBillingSubscriptionAuthorizationEmail(input) {
  const apiKey = normalizeString(env.resendApiKey);
  const from = resolveEmailFrom();
  const to = normalizeEmail(input.email);

  if (!apiKey || !from) {
    const error = new Error('billing_link_email_not_configured');
    error.code = 'billing_link_email_not_configured';
    throw error;
  }

  if (!to) {
    const error = new Error('billing_link_email_missing_recipient');
    error.code = 'billing_link_email_missing_recipient';
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
      subject: 'Autoriza tu suscripcion a Opturon',
      html: buildBillingSubscriptionEmailHtml(input)
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
    const error = new Error(`billing_link_email_send_failed_${response.status}`);
    error.code = 'billing_link_email_send_failed';
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
  sendBillingSubscriptionAuthorizationEmail
};
