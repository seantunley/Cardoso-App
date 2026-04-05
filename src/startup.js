import bcrypt from 'bcryptjs';
import db from './db/index.js';
import { encryptPassword, isEncryptedFormat, getEncryptionKey } from './services/encryption.js';
import { defaultPermissionsForRole } from './helpers.js';

export function validateSessionSecret(secret) {
  if (!secret) {
    console.error('❌ SESSION_SECRET environment variable is required. Set it in your .env file.');
    process.exit(1);
  }
  if (secret === 'change-me-to-a-long-random-string') {
    console.error('FATAL: SESSION_SECRET is set to the example value. Please generate a real secret in .env');
    process.exit(1);
  }
  if (secret.length < 32) {
    console.error('FATAL: SESSION_SECRET must be at least 32 characters long.');
    process.exit(1);
  }
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

  const adminDefaults = defaultPermissionsForRole('admin');
  const userDefaults = defaultPermissionsForRole('user');

  if (!admin) {
    const hash = await bcrypt.hash('admin123', 12);
    db.prepare(`
      INSERT INTO "user" (
        email, full_name, role, password_hash, is_active,
        can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory,
        can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends, can_access_hub_audit_log,
        can_access_records, can_access_reports, can_access_connections, can_access_settings,
        can_manage_users, can_manage_rules, can_edit_records, can_flag_records
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'admin@example.com',
      'Admin User',
      'admin',
      hash,
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
    console.warn('⚠️  DEFAULT CREDENTIALS ACTIVE: admin@example.com / admin123 — CHANGE IMMEDIATELY');
  } else if (!admin.password_hash) {
    const hash = await bcrypt.hash('admin123', 12);
    db.prepare(`UPDATE "user" SET password_hash = ? WHERE id = ?`).run(hash, admin.id);
    console.warn('⚠️  DEFAULT CREDENTIALS ACTIVE: admin@example.com / admin123 — CHANGE IMMEDIATELY');
  }

  if (!normal) {
    const hash = await bcrypt.hash('user123', 12);
    db.prepare(`
      INSERT INTO "user" (
        email, full_name, role, password_hash, is_active,
        can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory,
        can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends, can_access_hub_audit_log,
        can_access_records, can_access_reports, can_access_connections, can_access_settings,
        can_manage_users, can_manage_rules, can_edit_records, can_flag_records
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'user@example.com',
      'Regular User',
      'user',
      hash,
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
    const hash = await bcrypt.hash('user123', 12);
    db.prepare(`UPDATE "user" SET password_hash = ? WHERE id = ?`).run(hash, normal.id);
  }
}

export function createGetUserById(stmts) {
  return (id) => stmts.getUserById.get(id);
}
