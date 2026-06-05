const express = require('express');
const { runMercadoPagoAuthDiagnostics } = require('../services/mercado-pago.service');

const router = express.Router();

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeAmount(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Number(parsed.toFixed(2));
}

router.get('/__mercadopago/diagnostics', async (req, res) => {
  const runPreapproval = normalizeString(req.query.preapproval) === '1';
  const payerEmail = normalizeString(req.query.payerEmail);
  const tenantId = normalizeString(req.query.tenantId) || 'mp-auth-diag';
  const planCode = normalizeString(req.query.planCode) || 'crecimiento';
  const currency = normalizeString(req.query.currency) || 'ARS';
  const amount = normalizeAmount(req.query.amount, 68600);

  try {
    const diagnostics = await runMercadoPagoAuthDiagnostics({
      tenantId,
      planCode,
      amount,
      currency,
      payerEmail: runPreapproval ? payerEmail : ''
    });
    return res.status(200).json({
      ok: true,
      diagnostics
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: 'mercadopago_diagnostics_failed',
      detail: error instanceof Error ? error.message : 'mercadopago_diagnostics_failed'
    });
  }
});

module.exports = router;
