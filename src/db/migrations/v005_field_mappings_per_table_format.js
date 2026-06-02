import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 5,
      name: 'field_mappings_per_table_format',
      up(db) {
        const connections = db.prepare('SELECT id, table_configs, field_mappings FROM databaseconnection').all();
        for (const conn of connections) {
          try {
            const raw = JSON.parse(conn.field_mappings || '{}');
            const isFlat = Object.keys(raw).length > 0 &&
              Object.values(raw).some((v) => v && typeof v === 'object' && v.sourceField);
            if (!isFlat) continue;
            const tableConfigs = JSON.parse(conn.table_configs || '[]');
            if (!tableConfigs.length) continue;
            const migrated = {};
            for (const t of tableConfigs) {
              migrated[t.table_name] = raw;
            }
            db.prepare('UPDATE databaseconnection SET field_mappings = ? WHERE id = ?')
              .run(JSON.stringify(migrated), conn.id);
            console.log(`[migration] Migrated field_mappings to per-table format for connection ${conn.id}`);
          } catch (e) {
            console.error(`[migration] Failed to migrate field_mappings for connection ${conn.id}:`, e.message);
          }
        }
      },
    };
