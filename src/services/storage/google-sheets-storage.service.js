const crypto = require('crypto');
const { google } = require('googleapis');

const env = require('../../config/env');

function createSheetsClient() {
  const auth = new google.auth.JWT({
    email: env.googleServiceAccountEmail,
    key: env.googlePrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return google.sheets({ version: 'v4', auth });
}

async function saveInteraction(payload) {
  const sheets = createSheetsClient();

  const recordId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  const row = [
    recordId,
    createdAt,
    payload.source || 'webhook',
    payload.channel || 'whatsapp',
    payload.from || '',
    payload.name || '',
    payload.patientId || '',
    payload.message || '',
    payload.analysis.patientStatus,
    payload.analysis.treatmentType,
    payload.analysis.urgencyLevel,
    payload.analysis.summary,
    payload.analysis.confidence,
    payload.autoReply,
    payload.assignedAppointment && payload.assignedAppointment.slotId ? payload.assignedAppointment.slotId : '',
    payload.assignedAppointment && payload.assignedAppointment.startAt ? payload.assignedAppointment.startAt : '',
    payload.assignedAppointment && payload.assignedAppointment.endAt ? payload.assignedAppointment.endAt : ''
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.googleSpreadsheetId,
    range: `${env.googleSheetName}!A:Q`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row]
    }
  });

  return {
    recordId,
    storedIn: 'sheets',
    record: {
      id: recordId,
      createdAt
    }
  };
}

async function getMetrics() {
  const sheets = createSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: env.googleSpreadsheetId,
    range: `${env.googleSheetName}!A:Q`
  });

  const rows = Array.isArray(response.data.values) ? response.data.values : [];
  if (rows.length === 0) {
    return {
      totalLeads: 0,
      totalUrgent: 0,
      totalCritical: 0,
      totalAppointmentsAssigned: 0
    };
  }

  const records = rows[0] && rows[0][0] === 'id' ? rows.slice(1) : rows;

  const totalLeads = records.length;
  const totalCritical = records.filter((row) => (row[10] || '').toLowerCase() === 'critical').length;
  const totalUrgent = records.filter((row) => {
    const level = (row[10] || '').toLowerCase();
    return level === 'high' || level === 'critical';
  }).length;
  const totalAppointmentsAssigned = records.filter((row) => !!(row[15] || '')).length;

  return {
    totalLeads,
    totalUrgent,
    totalCritical,
    totalAppointmentsAssigned
  };
}

module.exports = { saveInteraction, getMetrics };

