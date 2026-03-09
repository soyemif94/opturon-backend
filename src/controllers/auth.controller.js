const { isNonEmptyString, sanitizeString } = require('../utils/validators');
const { registerUser, normalizePhone } = require('../services/user.service');

async function register(req, res) {
  try {
    const payload = req.body || {};
    const name = sanitizeString(payload.name);
    const phone = normalizePhone(payload.phone);

    if (!isNonEmptyString(name)) {
      return res.status(400).json({
        success: false,
        error: 'El campo "name" es obligatorio.'
      });
    }

    if (!isNonEmptyString(phone)) {
      return res.status(400).json({
        success: false,
        error: 'El campo "phone" es obligatorio.'
      });
    }

    const result = await registerUser({ name, phone });

    return res.status(result.created ? 201 : 200).json({
      success: true,
      data: {
        created: result.created,
        user: {
          id: result.user.id,
          name: result.user.name,
          phone: result.user.phone,
          createdAt: result.user.createdAt
        },
        testPayload: {
          source: 'whatsapp',
          channel: 'whatsapp',
          from: result.user.phone,
          name: result.user.name,
          patientId: result.user.id,
          message: 'Hola, tengo dolor fuerte en una muela y necesito cita urgente'
        }
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudo registrar el usuario.',
      details: error.message
    });
  }
}

module.exports = { register };

