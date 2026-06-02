import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 4,
      name: 'query_mode_and_inventory_columns',
      up(db) {
        ensureColumn(db, 'databaseconnection', 'sync_query', 'TEXT');
        ensureColumn(db, 'databaseconnection', 'query_index_field', 'TEXT');
        ensureColumn(db, 'databaseconnection', 'query_field_mappings', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'stocking_uom', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'commodity', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'inventory_value', 'TEXT');
        ensureColumn(db, 'databaseconnection', 'record_type', `TEXT DEFAULT 'customer'`);
        ensureColumn(db, 'databaseconnection', 'sync_interval_hours', 'INTEGER');
      },
    };
