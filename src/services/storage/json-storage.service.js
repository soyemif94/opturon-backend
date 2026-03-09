const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const env = require('../../config/env');

async function ensureDbFile() {
  const fullPath = path.resolve(env.jsonDbPath);
  const dir = path.dirname(fullPath);

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.access(fullPath);
  } catch (error) {
    await fs.writeFile(fullPath, '[]', 'utf-8');
  }

  return fullPath;
}

async function readAll() {
  const fullPath = await ensureDbFile();
  const raw = await fs.readFile(fullPath, 'utf-8');

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

async function writeAll(data) {
  const fullPath = await ensureDbFile();
  await fs.writeFile(fullPath, JSON.stringify(data, null, 2), 'utf-8');
}

async function saveInteraction(payload) {
  const data = await readAll();

  const record = {
    id: crypto.randomUUID(),
    source: payload.source || 'webhook',
    channel: payload.channel || 'whatsapp',
    from: payload.from || '',
    name: payload.name || '',
    patientId: payload.patientId || '',
    message: payload.message || '',
    analysis: payload.analysis,
    assignedAppointment: payload.assignedAppointment || null,
    autoReply: payload.autoReply,
    createdAt: new Date().toISOString()
  };

  data.push(record);
  await writeAll(data);

  return {
    recordId: record.id,
    storedIn: 'json',
    record
  };
}

async function getMetrics() {
  const data = await readAll();

  const totalLeads = data.length;
  const totalCritical = data.filter(
    (record) => record && record.analysis && record.analysis.urgencyLevel === 'critical'
  ).length;
  const totalUrgent = data.filter((record) => {
    const level = record && record.analysis ? record.analysis.urgencyLevel : '';
    return level === 'high' || level === 'critical';
  }).length;
  const totalAppointmentsAssigned = data.filter(
    (record) => !!(record && record.assignedAppointment && record.assignedAppointment.startAt)
  ).length;

  return {
    totalLeads,
    totalUrgent,
    totalCritical,
    totalAppointmentsAssigned
  };
}

module.exports = { saveInteraction, getMetrics };

