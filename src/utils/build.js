const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../../.env');

const buildInfo = {
  buildId: new Date().toISOString(),
  file: path.resolve(__dirname, '../server.js'),
  argv: Array.isArray(process.argv) ? process.argv.slice() : [],
  cwd: process.cwd(),
  envPath,
  envExists: fs.existsSync(envPath)
};

module.exports = buildInfo;

