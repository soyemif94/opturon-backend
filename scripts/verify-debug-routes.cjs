const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const env = require('../src/config/env');

console.log('[VERIFY_DEBUG]', {
  cwd: process.cwd(),
  envPath,
  envExists: fs.existsSync(envPath),
  flags: {
    WHATSAPP_DEBUG: env.whatsappDebug === true,
    DEBUG_API_ENABLED: env.debugApiEnabled === true
  },
  debugMountExpected: env.whatsappDebug === true && env.debugApiEnabled === true
});

process.exit(0);

