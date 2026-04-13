# Hub Postgres Bootstrap Notes

1. Export `HUB_POSTGRES_URL` before running bootstrap or verification.
2. Use a non-production schema first, for example `HUB_POSTGRES_SCHEMA=hub_phase2_dev`.
3. Run dry-run first:
   - `npm run hub:postgres:bootstrap -- --dry-run`
4. Apply the schema:
   - `npm run hub:postgres:bootstrap`
5. Verify table presence:
   - `npm run hub:postgres:verify`

This flow is intentionally separate from normal app startup so there is no accidental Hub cutover.
