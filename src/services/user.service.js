const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const env = require('../config/env');

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '').trim();
}

async function ensureUsersDbFile() {
  const fullPath = path.resolve(env.usersDbPath);
  const dir = path.dirname(fullPath);

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.access(fullPath);
  } catch (error) {
    await fs.writeFile(fullPath, '[]', 'utf-8');
  }

  return fullPath;
}

async function readUsers() {
  const fullPath = await ensureUsersDbFile();
  const raw = await fs.readFile(fullPath, 'utf-8');

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

async function writeUsers(users) {
  const fullPath = await ensureUsersDbFile();
  await fs.writeFile(fullPath, JSON.stringify(users, null, 2), 'utf-8');
}

async function registerUser({ name, phone }) {
  const users = await readUsers();
  const normalizedPhone = normalizePhone(phone);

  const existingUser = users.find((item) => normalizePhone(item.phone) === normalizedPhone);
  if (existingUser) {
    return {
      created: false,
      user: existingUser
    };
  }

  const user = {
    id: crypto.randomUUID(),
    name: String(name || '').trim(),
    phone: normalizedPhone,
    createdAt: new Date().toISOString()
  };

  users.push(user);
  await writeUsers(users);

  return {
    created: true,
    user
  };
}

module.exports = { registerUser, normalizePhone };

