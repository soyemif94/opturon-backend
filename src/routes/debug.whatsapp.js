const crypto = require('crypto');
const express = require('express');
const { query } = require('../db/client');

const { logInfo, logWarn, logError } = require('../utils/logger');
const { getConfiguredChannelStatus } = require('../services/channel-resolution.service');
const { normalizeDigits, normalizeWhatsAppTo } = require('../whatsapp/normalize-phone');

const router = express.Router();

function timingSafeEqualText(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  return aBuf.length > 0 && aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function normalizeTo(value) {
  return normalizeWhatsAppTo(normalizeDigits(value));
}

function isValidTo(value) {
  return /^\d{8,15}$/.test(String(value || ''));
}

/**
 * Example:
 * curl -X POST http://localhost:3001/debug/whatsapp/send-test \
 * -H "x-debug-key: 123" \
 * -H "Content-Type: application/json" \
 * -d '{"to":"549XXXXXXXXX"}'
 */
router.post('/whatsapp/send-test', async (req, res) => {
  const requestId = req.requestId || null;
  const providedKey = String(req.get('x-debug-key') || '').trim();
  const expectedKey = String(process.env.WHATSAPP_DEBUG_KEY || '').trim();

  if (!timingSafeEqualText(providedKey, expectedKey)) {
    logWarn('debug_send_test_forbidden', { requestId });
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }

  const body = req.body || {};
  const originalTo = String(body.to || '').trim();
  const to = normalizeTo(originalTo);
  const requestedType = String(body.type || '').trim().toLowerCase();
  const isTemplateType = requestedType === 'template';
  const text = String(body.text || 'ClinicAI test message').trim() || 'ClinicAI test message';
  const templateName = String(body.templateName || (body.template && body.template.name) || '').trim();
  const languageCode = String(body.languageCode || (body.template && body.template.languageCode) || 'es').trim() || 'es';
  const components = Array.isArray(body.components)
    ? body.components
    : (body.template && Array.isArray(body.template.components) ? body.template.components : []);
  const toLast4 = to ? to.slice(-4) : null;
  const toLen = to ? to.length : 0;

  logInfo('debug_send_test_requested', {
    requestId,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    toLast4,
    toLen
  });

  if (!to) {
    return res.status(400).json({ success: false, error: 'Field "to" is required' });
  }
  if (!isValidTo(to)) {
    return res.status(400).json({ success: false, error: 'Field "to" must be 8..15 digits (E.164 without +)' });
  }
  if (isTemplateType && !templateName) {
    return res.status(400).json({ success: false, error: 'Field "templateName" is required when type=template' });
  }

  try {
    const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
    if (!phoneNumberId) {
      return res.status(500).json({ success: false, error: 'WHATSAPP_PHONE_NUMBER_ID is not configured' });
    }

    const channelStatus = await getConfiguredChannelStatus({
      requestId,
      autoCreate: true
    });

    if (!channelStatus.ok || !channelStatus.channel) {
      return res.status(500).json({
        success: false,
        error: 'No active channel found for configured WHATSAPP_PHONE_NUMBER_ID',
        configuredPhoneNumberId: phoneNumberId,
        reason: channelStatus.reason || 'unknown',
        channel: channelStatus.channel || null,
        existingChannels: channelStatus.existingChannels || []
      });
    }

    const channel = channelStatus.channel;
    const payload = isTemplateType
      ? {
          type: 'template',
          phoneNumberId,
          to,
          templateName,
          languageCode,
          components
        }
      : {
          phoneNumberId,
          to,
          text
        };
    const jobType = isTemplateType ? 'whatsapp_template_send' : 'whatsapp_send';

    const jobResult = await query(
      `INSERT INTO jobs (
        "clinicId", "channelId", type, payload, status, attempts, "maxAttempts", "runAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4::jsonb, $5, 0, 10, NOW(), NOW())
      RETURNING id, status, "runAt"`,
      [channel.clinicId, channel.id, jobType, JSON.stringify(payload), 'queued']
    );

    const createdJob = jobResult.rows[0] || null;
    const jobId = createdJob ? createdJob.id : null;
    const jobStatus = createdJob ? createdJob.status : null;
    const runAt = createdJob ? createdJob.runAt : null;

    logInfo('job_created', {
      requestId,
      jobId,
      status: jobStatus,
      runAt,
      clinicId: channel.clinicId,
      channelId: channel.id,
      type: jobType,
      queuedStatus: 'queued'
    });

    return res.status(200).json({
      success: true,
      jobId,
      type: jobType,
      status: jobStatus,
      runAt,
      originalTo,
      normalizedTo: to,
      phoneNumberId,
      channel,
      autofixedChannel: channelStatus.autofixed === true
    });
  } catch (error) {
    logError('debug_send_test_failed', {
      requestId,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to create whatsapp_send job'
    });
  }
});

module.exports = router;
