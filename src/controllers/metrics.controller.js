const { getMetrics } = require('../services/storage/storage.service');

async function handleMetrics(req, res) {
  try {
    const metrics = await getMetrics();

    return res.status(200).json({
      success: true,
      data: metrics
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron calcular metricas.',
      details: error.message
    });
  }
}

module.exports = { handleMetrics };
