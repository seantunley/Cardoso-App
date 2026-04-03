import crypto from 'crypto';

// ==================== AES-256-GCM ENCRYPTION HELPERS ====================
export function getEncryptionKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) return null;
  if (raw.length !== 64) {
    console.warn('⚠️  ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Password encryption disabled.');
    return null;
  }
  try {
    return Buffer.from(raw, 'hex');
  } catch {
    console.warn('⚠️  ENCRYPTION_KEY is not valid hex. Password encryption disabled.');
    return null;
  }
}

// Returns 'iv:authTag:ciphertext' (all hex) or plaintext if no key
export function encryptPassword(plaintext) {
  const key = getEncryptionKey();
  if (!key || !plaintext) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

// Detects encrypted format (3 hex segments) and decrypts; falls back to plaintext
export function decryptPassword(stored) {
  if (!stored) return stored;
  const parts = stored.split(':');
  if (parts.length !== 3) return stored; // plaintext
  const key = getEncryptionKey();
  if (!key) return stored; // no key, return as-is (connection will fail if truly encrypted)
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    console.warn('⚠️  Failed to decrypt password — returning stored value as-is');
    return stored;
  }
}

// Returns true if value looks like encrypted format
export function isEncryptedFormat(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
}
