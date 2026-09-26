const express = require('express');
const { runMercadoPagoAuthDiagnostics } = require('../services/mercado-pago.service');

const router = express.Router();

const MUTATING_DIAGNOSTIC_QUERY_PARAMS = new Set([
  'preapproval',
  'payeremail',
  'tenantid',
  'plancode',
  'currency',
  'amount'
]);

function containsLegacyMutatingQuery(req) {
  return Object.keys(req.query || {}).some((key) => MUTATING_DIAGNOSTIC_QUERY_PARAMS.has(String(key).trim().toLowerCase()));
}

router.get('/__mercadopago/diagnostics', async (req, res) => {
  if (containsLegacyMutatingQuery(req)) {
    return res.status(400).json({
      ok: false,
      error: 'mutating_diagnostics_disabled',
      message: 'Mutating diagnostics are disabled.'
    });
  }

  try {
    const diagnostics = await runMercadoPagoAuthDiagnostics();
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
