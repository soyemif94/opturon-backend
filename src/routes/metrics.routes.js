const express = require('express');
const { handleMetrics } = require('../controllers/metrics.controller');

const router = express.Router();

router.get('/', handleMetrics);

module.exports = router;
