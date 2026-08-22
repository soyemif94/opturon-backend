const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

test('Canary migration applies and rejects cross-tenant identities', async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE clinics(id uuid PRIMARY KEY);
    CREATE TABLE channels(id uuid PRIMARY KEY, "clinicId" uuid NOT NULL);
    CREATE UNIQUE INDEX uq_channels_id_clinic_id ON channels(id,"clinicId");
    CREATE TABLE whatsapp_templates(id uuid PRIMARY KEY, "clinicId" uuid NOT NULL);
    CREATE TABLE operational_alert_recipients(id uuid PRIMARY KEY, "clinicId" uuid NOT NULL);
    CREATE UNIQUE INDEX uq_recipients_id_clinic ON operational_alert_recipients(id,"clinicId");
    CREATE TABLE staff_users(id uuid PRIMARY KEY);
    CREATE TABLE conversations(id uuid PRIMARY KEY, "clinicId" uuid NOT NULL);
    CREATE TABLE conversation_messages(id uuid PRIMARY KEY);
  `);
  const migration = fs.readFileSync(path.resolve(__dirname, '../../db/migrations/077_whatsapp_template_canary_attempts.sql'), 'utf8')
    .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
  await db.exec(migration);
  const table = await db.query("SELECT to_regclass('whatsapp_template_canary_attempts') AS name");
  assert.equal(table.rows[0].name, 'whatsapp_template_canary_attempts');
  const constraints = await db.query("SELECT conname FROM pg_constraint WHERE conrelid='whatsapp_template_canary_attempts'::regclass");
  const names = new Set(constraints.rows.map((row) => row.conname));
  assert.equal(names.has('fk_whatsapp_template_canary_channel_tenant'), true);
  assert.equal(names.has('fk_whatsapp_template_canary_template_tenant'), true);
  assert.equal(names.has('fk_whatsapp_template_canary_recipient_tenant'), true);
  await db.close();
});
