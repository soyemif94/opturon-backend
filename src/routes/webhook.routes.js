const express = require('express');
const { verifyWebhook, handleWebhook } = require('../controllers/webhook.controller');
const { verifyMetaSignature } = require('../middlewares/verify-meta-signature.middleware');

const router = express.Router();

router.get('/', verifyWebhook);
router.post('/', verifyMetaSignature, handleWebhook);

module.exports = router;

