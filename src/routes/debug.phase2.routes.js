const express = require('express');
const router = express.Router();

const {
  getLeads,
  getAppointments
} = require('../controllers/debug.phase2.controller');

const {
  requireDebugAccess
} = require('../middlewares/debug-auth.middleware');

router.use(requireDebugAccess);

router.get('/phase2/leads', getLeads);
router.get('/phase2/appointments', getAppointments);

module.exports = router;
