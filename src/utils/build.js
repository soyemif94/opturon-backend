const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../../.env');
const commitSha = String(
  process.env.RENDER_GIT_COMMIT ||
    process.env.GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    ''
).trim() || null;
const branchName = String(
  process.env.RENDER_GIT_BRANCH ||
    process.env.GIT_BRANCH ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    ''
).trim() || null;
const serviceName = String(process.env.RENDER_SERVICE_NAME || process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim() || null;

const buildInfo = {
  buildId: new Date().toISOString(),
  commitSha,
  branchName,
  serviceName,
  file: path.resolve(__dirname, '../server.js'),
  argv: Array.isArray(process.argv) ? process.argv.slice() : [],
  cwd: process.cwd(),
  envPath,
  envExists: fs.existsSync(envPath)
};

module.exports = buildInfo;
