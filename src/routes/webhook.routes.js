const express = require('express');
const { verifyWebhook, handleWebhook } = require('../controllers/webhook.controller');
const { verifyMetaSignature, parseMetaWebhookJson } = require('../middlewares/verify-meta-signature.middleware');

const router = express.Router();

router.get('/', verifyWebhook);
router.post(
  '/',
  express.raw({ type: '*/*', limit: '2mb' }),
  (req, res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    next();
  },
  verifyMetaSignature,
  parseMetaWebhookJson,
  handleWebhook
);

module.exports = router;

