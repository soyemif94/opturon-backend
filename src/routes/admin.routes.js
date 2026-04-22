const express = require('express');
const { postSetActiveTenant } = require('../controllers/admin.controller');

const router = express.Router();

router.post('/set-active-tenant', postSetActiveTenant);

module.exports = router;
