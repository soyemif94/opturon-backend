const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(root, 'db/migrations/063_portal_password_reset_tokens.sql'), 'utf8');

assert.match(migration, /CREATE TABLE IF NOT EXISTS portal_password_reset_tokens/);
assert.match(migration, /"userId" UUID NOT NULL REFERENCES staff_users\(id\) ON DELETE CASCADE/);
assert.match(migration, /"tokenHash" TEXT NOT NULL/);
assert.match(migration, /"expiresAt" TIMESTAMPTZ NOT NULL/);
assert.match(migration, /"consumedAt" TIMESTAMPTZ NULL/);
assert.match(migration, /uniq_portal_password_reset_tokens_token_hash/);
assert.match(migration, /idx_portal_password_reset_tokens_active_user/);

console.log('portal-password-reset-migration.test.js: ok');
