const env = require('../../config/env');
const { logWarn } = require('../../utils/logger');

const jsonStorage = require('./json-storage.service');
const sheetsStorage = require('./google-sheets-storage.service');

function canUseSheets() {
  return (
    !!env.googleSpreadsheetId &&
    !!env.googleServiceAccountEmail &&
    !!env.googlePrivateKey &&
    !!env.googleSheetName
  );
}

async function saveInteraction(payload) {
  if (env.storageMode === 'sheets' && canUseSheets()) {
    try {
      return await sheetsStorage.saveInteraction(payload);
    } catch (error) {
      logWarn('Google Sheets failed, falling back to JSON', { error: error.message });
      return jsonStorage.saveInteraction(payload);
    }
  }

  if (env.storageMode === 'sheets' && !canUseSheets()) {
    logWarn('STORAGE_MODE=sheets but credentials are incomplete, falling back to JSON');
  }

  return jsonStorage.saveInteraction(payload);
}

async function getMetrics() {
  if (env.storageMode === 'sheets' && canUseSheets()) {
    try {
      return await sheetsStorage.getMetrics();
    } catch (error) {
      logWarn('Google Sheets metrics failed, falling back to JSON', { error: error.message });
      return jsonStorage.getMetrics();
    }
  }

  if (env.storageMode === 'sheets' && !canUseSheets()) {
    logWarn('STORAGE_MODE=sheets but credentials are incomplete, using JSON for metrics');
  }

  return jsonStorage.getMetrics();
}

module.exports = { saveInteraction, getMetrics };

