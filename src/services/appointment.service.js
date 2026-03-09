const fs = require('fs/promises');
const path = require('path');

const env = require('../config/env');

function isUrgent(urgencyLevel) {
  return urgencyLevel === 'high' || urgencyLevel === 'critical';
}

async function ensureScheduleFile() {
  const fullPath = path.resolve(env.scheduleDbPath);
  const dir = path.dirname(fullPath);

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.access(fullPath);
  } catch (error) {
    await fs.writeFile(fullPath, '[]', 'utf-8');
  }

  return fullPath;
}

async function readSchedule() {
  const fullPath = await ensureScheduleFile();
  const raw = await fs.readFile(fullPath, 'utf-8');

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

async function writeSchedule(data) {
  const fullPath = await ensureScheduleFile();
  await fs.writeFile(fullPath, JSON.stringify(data, null, 2), 'utf-8');
}

function findNextAvailableIndex(slots) {
  const now = Date.now();

  let bestIndex = -1;
  let bestTs = Number.POSITIVE_INFINITY;

  slots.forEach((slot, index) => {
    if (!slot || slot.isAvailable !== true || !slot.startAt) {
      return;
    }

    const ts = new Date(slot.startAt).getTime();
    if (!Number.isFinite(ts) || ts < now) {
      return;
    }

    if (ts < bestTs) {
      bestTs = ts;
      bestIndex = index;
    }
  });

  if (bestIndex !== -1) {
    return bestIndex;
  }

  // fallback: first available even if date is in the past
  return slots.findIndex((slot) => slot && slot.isAvailable === true);
}

async function assignAppointmentIfUrgent({ analysis, patient }) {
  if (!analysis || !isUrgent(analysis.urgencyLevel)) {
    return null;
  }

  const slots = await readSchedule();
  const nextIndex = findNextAvailableIndex(slots);

  if (nextIndex === -1) {
    return null;
  }

  const slot = slots[nextIndex];
  slot.isAvailable = false;
  slot.assignedAt = new Date().toISOString();
  slot.assignedTo = {
    from: patient && patient.from ? patient.from : '',
    name: patient && patient.name ? patient.name : ''
  };

  await writeSchedule(slots);

  return {
    slotId: slot.id || null,
    startAt: slot.startAt || null,
    endAt: slot.endAt || null
  };
}

module.exports = { assignAppointmentIfUrgent };
