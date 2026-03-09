const { DateTime } = require('luxon');
const {
  ensureSlotsForDateRange,
  listAvailableSlots,
  listAppointments,
  getClinic
} = require('../repositories/calendar.repository');

function normalizeRange(from, to, timezone) {
  const zone = timezone || 'America/Argentina/Buenos_Aires';
  const fromUtc = from
    ? DateTime.fromISO(String(from), { zone: 'utc' })
    : DateTime.now().setZone(zone).startOf('day').toUTC();
  const toUtc = to
    ? DateTime.fromISO(String(to), { zone: 'utc' })
    : fromUtc.plus({ days: 7 });

  return {
    fromUtc: fromUtc.toISO(),
    toUtc: toUtc.toISO()
  };
}

function formatSlots(slots, timezone) {
  return slots.map((slot) => ({
    ...slot,
    startsAtLocal: DateTime.fromISO(String(slot.startsAt), { zone: 'utc' }).setZone(timezone).toFormat('ccc dd/LL HH:mm'),
    endsAtLocal: DateTime.fromISO(String(slot.endsAt), { zone: 'utc' }).setZone(timezone).toFormat('ccc dd/LL HH:mm')
  }));
}

async function generateClinicSlots(req, res) {
  const { clinicId } = req.params;
  const body = req.body || {};

  try {
    const clinic = await getClinic(clinicId);
    if (!clinic) {
      return res.status(404).json({ success: false, error: 'Clinic no encontrada.' });
    }

    const range = normalizeRange(body.from, body.to, clinic.timezone);
    const result = await ensureSlotsForDateRange(clinicId, range.fromUtc, range.toUtc);

    return res.status(200).json({
      success: true,
      data: {
        generated: result.generated,
        fromUtc: range.fromUtc,
        toUtc: range.toUtc,
        timezone: result.rules.timezone,
        rules: result.rules
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron generar slots.',
      details: error.message
    });
  }
}

async function getClinicAvailableSlots(req, res) {
  const { clinicId } = req.params;
  const limit = Number.parseInt(String(req.query.limit || '5'), 10);

  try {
    const clinic = await getClinic(clinicId);
    if (!clinic) {
      return res.status(404).json({ success: false, error: 'Clinic no encontrada.' });
    }

    const range = normalizeRange(req.query.from, req.query.to, clinic.timezone);
    const slots = await listAvailableSlots(clinicId, range.fromUtc, range.toUtc, limit);

    return res.status(200).json({
      success: true,
      data: formatSlots(slots, clinic.timezone),
      count: slots.length,
      timezone: clinic.timezone
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron listar slots disponibles.',
      details: error.message
    });
  }
}

async function getClinicAppointments(req, res) {
  const { clinicId } = req.params;

  try {
    const clinic = await getClinic(clinicId);
    if (!clinic) {
      return res.status(404).json({ success: false, error: 'Clinic no encontrada.' });
    }

    const range = normalizeRange(req.query.from, req.query.to, clinic.timezone);
    const appointments = await listAppointments(clinicId, range.fromUtc, range.toUtc);
    const formatted = appointments.map((item) => ({
      ...item,
      startsAtLocal: DateTime.fromISO(String(item.startsAt), { zone: 'utc' }).setZone(clinic.timezone).toFormat('ccc dd/LL HH:mm'),
      endsAtLocal: DateTime.fromISO(String(item.endsAt), { zone: 'utc' }).setZone(clinic.timezone).toFormat('ccc dd/LL HH:mm')
    }));

    return res.status(200).json({
      success: true,
      data: formatted,
      count: formatted.length,
      timezone: clinic.timezone
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'No se pudieron obtener appointments.',
      details: error.message
    });
  }
}

module.exports = {
  generateClinicSlots,
  getClinicAvailableSlots,
  getClinicAppointments
};

