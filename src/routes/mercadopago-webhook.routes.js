const express = require('express');
const { postMercadoPagoWebhook } = require('../controllers/mercadopago.controller');

const router = express.Router();

router.post(
  '/',
  express.raw({ type: '*/*', limit: '2mb' }),
  (req, res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    next();
  },
  postMercadoPagoWebhook
);

module.exports = router;
