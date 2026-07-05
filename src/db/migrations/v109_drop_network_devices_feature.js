export default {
  version: 109,
  name: 'drop_network_devices_feature',
  up(db) {
    // The ntopng / "Network Devices" feature was removed. Its data tables were
    // already dropped by earlier migrations (network_devices etc. in v030/v031);
    // this cleans up the two traces that survived a full migration run:
    //   • the per-user permission column `user.can_access_network_devices`
    //   • the ntopng connection rows in hub_settings (hub installs only)
    const cols = db.prepare('PRAGMA table_info(user)').all();
    if (cols.some((c) => c.name === 'can_access_network_devices')) {
      db.exec('ALTER TABLE user DROP COLUMN can_access_network_devices');
    }
    // hub_settings only exists on hub installs — guard for site DBs.
    const hasHubSettings = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='hub_settings'",
    ).get();
    if (hasHubSettings) {
      db.prepare(
        "DELETE FROM hub_settings WHERE key IN ('ntopng_url','ntopng_user','ntopng_password')",
      ).run();
    }
  },
};
