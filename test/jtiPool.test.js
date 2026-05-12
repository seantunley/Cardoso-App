// Contract tests for src/services/jti/jtiPool.js — the JTI Sage pool
// MUST NOT fall back to the BAT pool. If the operator hasn't pinned
// the jti_export role, every call should fail loudly with the exact
// "configure Module Routing" hint, not silently route to BAT and
// query the wrong Sage company.
//
// We test the resolution layer (loadJtiSqlConfig via getJtiSagePool /
// getJtiPoolStatus) by stubbing the underlying db connection roles
// table + databaseconnection table. Real mssql.connect calls are not
// invoked — the tests mock the entire pool open path via vi.mock.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies BEFORE importing the module under test.

vi.mock('mssql', () => ({
  default: {
    connect: vi.fn(),
  },
}));

vi.mock('../src/db/index.js', () => ({
  default: {
    prepare: vi.fn(),
  },
}));

vi.mock('../src/services/encryption.js', () => ({
  decryptPassword: vi.fn((p) => `decrypted(${p})`),
}));

vi.mock('../src/services/mssqlSecurity.js', () => ({
  buildSqlServerConfig: vi.fn((cfg) => ({ ...cfg, _built: true })),
}));

vi.mock('../src/services/connectionRoles.js', () => ({
  getRoleConnectionId: vi.fn(),
}));

vi.mock('../src/lib/errorLog.js', () => ({
  logError: vi.fn(),
}));

import sql from 'mssql';
import db from '../src/db/index.js';
import { getRoleConnectionId } from '../src/services/connectionRoles.js';
import {
  getJtiSagePool,
  getJtiPoolStatus,
  resetJtiSagePool,
} from '../src/services/jti/jtiPool.js';

// Helper: configure the mocks so that `jti_export` role points at a
// connection of our choosing.
function configureMocks({ roleId, connectionRow }) {
  getRoleConnectionId.mockImplementation((role) => (role === 'jti_export' ? roleId : null));
  // db.prepare returns an object with a .get() method that returns
  // the configured row.
  db.prepare.mockImplementation(() => ({
    get: vi.fn(() => connectionRow),
  }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetJtiSagePool();    // ensure no pool leaks between tests
});

afterEach(async () => {
  await resetJtiSagePool();
});

describe('getJtiPoolStatus', () => {
  it('returns { configured: false } when jti_export role is unset', () => {
    configureMocks({ roleId: null, connectionRow: null });
    expect(getJtiPoolStatus()).toEqual({ configured: false, source: null });
  });

  it('returns { configured: false } when the assigned connection is missing/inactive', () => {
    // Role assigned but databaseconnection lookup returns null
    configureMocks({ roleId: 42, connectionRow: null });
    expect(getJtiPoolStatus()).toEqual({ configured: false, source: null });
  });

  it('returns { configured: true, source: ... } when properly configured', () => {
    configureMocks({
      roleId: 42,
      connectionRow: {
        id: 42, name: 'JTI Sage 300', host: '10.0.0.5', port: 1433,
        database_name: 'JTIDAT', username: 'sa', encrypted_password: 'enc',
        use_encryption: 1, status: 'active',
      },
    });
    const status = getJtiPoolStatus();
    expect(status.configured).toBe(true);
    expect(status.source).toMatch(/databaseconnection#42/);
    expect(status.source).toMatch(/JTI Sage 300/);
    expect(status.source).toMatch(/10\.0\.0\.5:1433\/JTIDAT/);
  });
});

describe('getJtiSagePool — NO BAT FALLBACK', () => {
  it('throws with the exact "Module routing" hint when role is unset', async () => {
    configureMocks({ roleId: null, connectionRow: null });
    await expect(getJtiSagePool()).rejects.toThrow(/Module routing/);
    await expect(getJtiSagePool()).rejects.toThrow(/JTI export/);
    // The fallback-NOT-allowed assertion in the message is the
    // promise to the operator that this is intentional design.
    await expect(getJtiSagePool()).rejects.toThrow(/does not fall back to the BAT/);
    // Critically — sql.connect was NEVER called. We do NOT silently
    // open a connection somewhere else.
    expect(sql.connect).not.toHaveBeenCalled();
  });

  it('throws when role is assigned but the connection row is missing', async () => {
    configureMocks({ roleId: 99, connectionRow: null });
    await expect(getJtiSagePool()).rejects.toThrow(/Module routing/);
    expect(sql.connect).not.toHaveBeenCalled();
  });
});

describe('getJtiSagePool — happy path', () => {
  beforeEach(() => {
    configureMocks({
      roleId: 42,
      connectionRow: {
        id: 42, name: 'JTI Sage 300', host: '10.0.0.5', port: 1433,
        database_name: 'JTIDAT', username: 'sa', encrypted_password: 'enc',
        use_encryption: 1, status: 'active',
      },
    });
  });

  it('opens a pool with the resolved config', async () => {
    const fakePool = { connected: true, request: vi.fn(), close: vi.fn() };
    sql.connect.mockResolvedValue(fakePool);
    const pool = await getJtiSagePool();
    expect(pool).toBe(fakePool);
    expect(sql.connect).toHaveBeenCalledTimes(1);
    const cfg = sql.connect.mock.calls[0][0];
    expect(cfg.server).toBe('10.0.0.5');
    expect(cfg.database).toBe('JTIDAT');
    expect(cfg.user).toBe('sa');
    expect(cfg.password).toBe('decrypted(enc)');
  });

  it('returns the cached pool on subsequent calls (no re-connect)', async () => {
    const fakePool = { connected: true, request: vi.fn(), close: vi.fn() };
    sql.connect.mockResolvedValue(fakePool);
    await getJtiSagePool();
    await getJtiSagePool();
    await getJtiSagePool();
    expect(sql.connect).toHaveBeenCalledTimes(1);
  });

  it('re-opens when the cached pool is no longer connected', async () => {
    const dead = { connected: false, request: vi.fn(), close: vi.fn() };
    const fresh = { connected: true, request: vi.fn(), close: vi.fn() };
    sql.connect.mockResolvedValueOnce(dead).mockResolvedValueOnce(fresh);
    const first = await getJtiSagePool();
    expect(first).toBe(dead);
    const second = await getJtiSagePool();
    expect(second).toBe(fresh);
    expect(sql.connect).toHaveBeenCalledTimes(2);
    expect(dead.close).toHaveBeenCalled();
  });
});

describe('resetJtiSagePool', () => {
  it('closes the cached pool and forces a re-open on next get', async () => {
    configureMocks({
      roleId: 42,
      connectionRow: {
        id: 42, name: 'X', host: 'h', port: 1433, database_name: 'd',
        username: 'u', encrypted_password: 'p', use_encryption: 0, status: 'active',
      },
    });
    const first = { connected: true, request: vi.fn(), close: vi.fn() };
    const second = { connected: true, request: vi.fn(), close: vi.fn() };
    sql.connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await getJtiSagePool();
    await resetJtiSagePool();
    await getJtiSagePool();

    expect(first.close).toHaveBeenCalled();
    expect(sql.connect).toHaveBeenCalledTimes(2);
  });
});
