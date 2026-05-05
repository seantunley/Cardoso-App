import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import db from './db/index.js';
import { defaultPermissionsForRole } from './helpers.js';
import { encryptPassword, isEncryptedFormat, getEncryptionKey } from './services/encryption.js';

function hasStoredDatabasePasswords() {
  const row = db.prepare(`
    SELECT id
    FROM databaseconnection
    WHERE encrypted_password IS NOT NULL AND TRIM(encrypted_password) <> ''
    LIMIT 1
  `).get();
  return !!row;
}

function generateBootstrapPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

// Known placeholder values written by the installer — safe to auto-replace
const SESSION_SECRET_PLACEHOLDERS = new Set([
  'CHANGE_ME_RUN_SETUP',
  'change-me-to-a-long-random-string',
  '',
]);

function autoHealSessionSecret() {
  const envPath = path.resolve(process.cwd(), '.env');
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
      if (/^SESSION_SECRET=/m.test(content)) {
        content = content.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${generated}`);
      } else {
        content += `\nSESSION_SECRET=${generated}\n`;
      }
    } else {
      content = `SESSION_SECRET=${generated}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
    process.env.SESSION_SECRET = generated;
    console.warn('⚠️  SESSION_SECRET was a placeholder/too short — generated a secure secret and saved to .env. All active sessions have been reset.');
    return generated;
  } catch (e) {
    console.error(`FATAL: SESSION_SECRET is invalid and could not auto-heal .env: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Production-only auto-repair for SESSION_SECRET. Call BEFORE the zod
 * validator (`validateEnvOrExit` in src/config/env.js) so the parser sees
 * the healed value. In dev/test the validator handles the missing/short
 * secret as a hard error so the developer notices misconfiguration.
 *
 * Extracted from the old `validateSessionSecret` so that the zod schema
 * remains the single source of truth for length/format checks while this
 * keeps the production self-repair behaviour.
 */
export function autoHealSessionSecretIfNeeded() {
  if (process.env.NODE_ENV !== 'production') return;
  const secret = process.env.SESSION_SECRET;
  const isPlaceholder = !secret || SESSION_SECRET_PLACEHOLDERS.has(secret);
  const isTooShort = secret && secret.length < 32;
  if (isPlaceholder || isTooShort) {
    autoHealSessionSecret();
  }
}

export function validateEncryptionKey() {
  const key = getEncryptionKey();
  if (key) return;

  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) return;
  if (!hasStoredDatabasePasswords()) return;

  console.error('FATAL: ENCRYPTION_KEY is required in production when MSSQL credentials are stored. Refusing to start insecurely.');
  process.exit(1);
}

export function migrateUnencryptedPasswords() {
  const key = getEncryptionKey();
  if (!key) return;

  const connections = db.prepare('SELECT id, encrypted_password FROM databaseconnection').all();
  let migrated = 0;
  for (const conn of connections) {
    if (!conn.encrypted_password) continue;
    if (isEncryptedFormat(conn.encrypted_password)) continue;
    try {
      const encrypted = encryptPassword(conn.encrypted_password);
      db.prepare('UPDATE databaseconnection SET encrypted_password = ? WHERE id = ?')
        .run(encrypted, conn.id);
      migrated++;
    } catch (e) {
      console.error(`[migration] Failed to encrypt password for connection ${conn.id}:`, e.message);
    }
  }
  if (migrated > 0) {
    console.log(`🔐 Auto-migrated ${migrated} MSSQL password(s) to AES-256-GCM encryption`);
  }
}

export function recoverAbandonedSyncs() {
  const info = db.prepare(`
    UPDATE syncrun
    SET status = 'abandoned',
        completed_at = ?,
        message = COALESCE(message, 'Server restarted before sync completed')
    WHERE status = 'running'
  `).run(new Date().toISOString());

  if (info.changes > 0) {
    console.log(`Recovered ${info.changes} abandoned sync run(s)`);
  }
}

export async function ensureSeedUsers() {
  const admin = db.prepare(`SELECT * FROM "user" WHERE email = ?`).get('admin@example.com');
  const normal = db.prepare(`SELECT * FROM "user" WHERE email = ?`).get('user@example.com');
  const isProduction = process.env.NODE_ENV === 'production';

  const adminDefaults = defaultPermissionsForRole('admin');
  const userDefaults = defaultPermissionsForRole('user');

  if (!admin) {
    const bootstrapPassword = isProduction ? generateBootstrapPassword() : 'admin123';
    const hash = await bcrypt.hash(bootstrapPassword, 12);
    db.prepare(`
      INSERT INTO "user" (
        email, full_name, role, password_hash, is_active, must_change_password,
        can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory,
        can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends, can_access_hub_audit_log,
        can_access_records, can_access_reports, can_access_connections, can_access_settings,
        can_manage_users, can_manage_rules, can_edit_records, can_flag_records
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'admin@example.com',
      'Admin User',
      'admin',
      hash,
      1,
      1,
      adminDefaults.can_access_customer_search ? 1 : 0,
      adminDefaults.can_access_customer_balances !== false ? 1 : 0,
      adminDefaults.can_access_collections !== false ? 1 : 0,
      adminDefaults.can_access_inventory !== false ? 1 : 0,
      adminDefaults.can_access_hub_metrics ? 1 : 0,
      adminDefaults.can_access_hub_backups ? 1 : 0,
      adminDefaults.can_access_hub_trends ? 1 : 0,
      adminDefaults.can_access_hub_audit_log ? 1 : 0,
      adminDefaults.can_access_records ? 1 : 0,
      adminDefaults.can_access_reports ? 1 : 0,
      adminDefaults.can_access_connections ? 1 : 0,
      adminDefaults.can_access_settings ? 1 : 0,
      adminDefaults.can_manage_users ? 1 : 0,
      adminDefaults.can_manage_rules ? 1 : 0,
      adminDefaults.can_edit_records ? 1 : 0,
      adminDefaults.can_flag_records ? 1 : 0
    );
    if (isProduction) {
      console.warn(`⚠️  BOOTSTRAP ADMIN CREATED: admin@example.com / ${bootstrapPassword} — rotate immediately on first login`);
    } else {
      console.warn('⚠️  DEFAULT CREDENTIALS ACTIVE: admin@example.com / admin123 — CHANGE IMMEDIATELY');
    }
  } else if (!admin.password_hash) {
    const bootstrapPassword = isProduction ? generateBootstrapPassword() : 'admin123';
    const hash = await bcrypt.hash(bootstrapPassword, 12);
    db.prepare(`UPDATE "user" SET password_hash = ? WHERE id = ?`).run(hash, admin.id);
    db.prepare(`UPDATE "user" SET must_change_password = 1 WHERE id = ?`).run(admin.id);
    if (isProduction) {
      console.warn(`⚠️  BOOTSTRAP ADMIN RESET: admin@example.com / ${bootstrapPassword} — rotate immediately on first login`);
    } else {
      console.warn('⚠️  DEFAULT CREDENTIALS ACTIVE: admin@example.com / admin123 — CHANGE IMMEDIATELY');
    }
  }

  if (!normal) {
    if (isProduction) {
      return;
    }
    const hash = await bcrypt.hash('user123', 12);
    db.prepare(`
      INSERT INTO "user" (
        email, full_name, role, password_hash, is_active, must_change_password,
        can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory,
        can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends, can_access_hub_audit_log,
        can_access_records, can_access_reports, can_access_connections, can_access_settings,
        can_manage_users, can_manage_rules, can_edit_records, can_flag_records
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'user@example.com',
      'Regular User',
      'user',
      hash,
      1,
      1,
      userDefaults.can_access_customer_search ? 1 : 0,
      userDefaults.can_access_customer_balances !== false ? 1 : 0,
      userDefaults.can_access_collections !== false ? 1 : 0,
      userDefaults.can_access_inventory !== false ? 1 : 0,
      userDefaults.can_access_hub_metrics ? 1 : 0,
      userDefaults.can_access_hub_backups ? 1 : 0,
      userDefaults.can_access_hub_trends ? 1 : 0,
      userDefaults.can_access_hub_audit_log ? 1 : 0,
      userDefaults.can_access_records ? 1 : 0,
      userDefaults.can_access_reports ? 1 : 0,
      userDefaults.can_access_connections ? 1 : 0,
      userDefaults.can_access_settings ? 1 : 0,
      userDefaults.can_manage_users ? 1 : 0,
      userDefaults.can_manage_rules ? 1 : 0,
      userDefaults.can_edit_records ? 1 : 0,
      userDefaults.can_flag_records ? 1 : 0
    );
  } else if (!normal.password_hash) {
    if (isProduction) {
      return;
    }
    const hash = await bcrypt.hash('user123', 12);
    db.prepare(`UPDATE "user" SET password_hash = ? WHERE id = ?`).run(hash, normal.id);
    db.prepare(`UPDATE "user" SET must_change_password = 1 WHERE id = ?`).run(normal.id);
  }
}

export function createGetUserById(stmts) {
  return (id) => stmts.getUserById.get(id);
}
