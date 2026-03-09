const { listLeads } = require('../repositories/lead.repository');

async function getClinicLeads(req, res) {
  const { clinicId } = req.params;
  const status = String(req.query.status || '').trim() || null;
  const limit = Number.parseInt(String(req.query.limit || '50'), 10);

  try {
    const rows = await listLeads({ clinicId, status, limit });
    return res.status(200).json({
      success: true,
      data: rows,
      count: rows.length
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron obtener leads.',
      details: error.message
    });
  }
}

module.exports = {
  getClinicLeads
};

