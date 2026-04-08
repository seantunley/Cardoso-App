function envFlag(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function getTlsPolicy() {
  const envEncrypt = envFlag('MSSQL_ENCRYPT');
  const encrypt = envEncrypt ?? (process.env.NODE_ENV === 'production');

  const envTrust = envFlag('MSSQL_TRUST_SERVER_CERTIFICATE');
  const trustServerCertificate = envTrust ?? !encrypt;

  return { encrypt, trustServerCertificate };
}

/**
 * Build mssql connection config.
 * useEncryption: explicit per-connection override (boolean | null)
 *   - true  → encrypt on, trustServerCertificate off
 *   - false → encrypt off, trustServerCertificate on
 *   - null  → fall through to env/production defaults (existing behaviour)
 */
export function buildSqlServerConfig({ user, password, server, database, port, useEncryption = null }) {
  let encrypt, trustServerCertificate;
  if (useEncryption === true) {
    encrypt = true;
    trustServerCertificate = false;
  } else if (useEncryption === false) {
    encrypt = false;
    trustServerCertificate = true;
  } else {
    ({ encrypt, trustServerCertificate } = getTlsPolicy());
  }

  return {
    user,
    password,
    server,
    database,
    port: Number.parseInt(port, 10),
    options: {
      encrypt,
      trustServerCertificate,
      enableArithAbort: true,
    },
    requestTimeout: 60000,
    connectionTimeout: 15000,
  };
}

export function getMssqlTlsPolicy() {
  return getTlsPolicy();
}
