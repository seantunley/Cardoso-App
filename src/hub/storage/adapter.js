export function createSqliteHubStorageAdapter(sqliteDb, { hubPostgresConfig } = {}) {
  return {
    kind: 'sqlite',
    dialect: 'sqlite',
    role: 'hub',
    postgresScaffold: hubPostgresConfig || null,
    getSqliteDb() {
      return sqliteDb;
    },
    prepare(sql) {
      return sqliteDb.prepare(sql);
    },
    exec(sql) {
      return sqliteDb.exec(sql);
    },
    transaction(fn) {
      return sqliteDb.transaction(fn);
    },
    queryOne(sql, ...params) {
      return sqliteDb.prepare(sql).get(...params);
    },
    queryAll(sql, ...params) {
      return sqliteDb.prepare(sql).all(...params);
    },
    run(sql, ...params) {
      return sqliteDb.prepare(sql).run(...params);
    },
  };
}
