const { query } = require('../db/client');

async function getLeads(req, res) {
  const rows = await query(
    `SELECT *
     FROM leads
     ORDER BY "createdAt" DESC
     LIMIT 50`
  );

  res.json({
    success: true,
    count: rows.rows.length,
    data: rows.rows
  });
}

async function getAppointments(req, res) {
  const rows = await query(
    `SELECT *
     FROM appointments
     ORDER BY "createdAt" DESC
     LIMIT 50`
  );

  res.json({
    success: true,
    count: rows.rows.length,
    data: rows.rows
  });
}

module.exports = {
  getLeads,
  getAppointments
};
