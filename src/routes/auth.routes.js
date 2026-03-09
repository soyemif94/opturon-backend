const express = require('express');
const { register } = require('../controllers/auth.controller');

const router = express.Router();

router.post('/alta', register);
router.post('/signup', register);

module.exports = router;

