// "Sync all" for the Connections screens. Skips connections that can't be
// synced into the customer/stock tables (BAT-only — refused by the server — and
// switched off), and keeps going when one fails: the old loop stopped at the
// first error, and since the BAT connection is often listed first, "Sync all"
// failed straight away and synced nothing.

export function syncableConnections(connections = []) {
  return connections.filter((c) => !Number(c.is_bat_only) && c.status !== 'inactive');
}

/**
 * @param {Array<{id: any, name?: string, is_bat_only?: any, status?: string}>} connections
 * @param {(id: any) => Promise<any>} runImport
 * @returns {Promise<Array<{ conn: any, ok: boolean, result?: any, error?: unknown }>>}
 */
export async function syncAllConnections(connections, runImport) {
  const results = [];
  for (const conn of syncableConnections(connections)) {
    try {
      results.push({ conn, ok: true, result: await runImport(conn.id) });
    } catch (error) {
      results.push({ conn, ok: false, error });
    }
  }
  return results;
}
