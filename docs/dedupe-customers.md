# Customer Dedupe Tool

This tool removes duplicate `datarecord` rows while keeping the newest row for each `customer_number`.

## Safe rule

- Keep the latest record by `updated_date`, then `created_date`, then `synced_at`, then `id`
- Preserve flagged rows if they are the latest copy for that customer
- Use `--dry-run` first to preview removals

## Usage

```bash
node scripts/dedupe-customers.js /path/to/cardoso.db --dry-run
node scripts/dedupe-customers.js /path/to/cardoso.db
```

## Notes

- This does not delete the database file.
- It only removes duplicate customer rows from `datarecord`.
- If you want this exposed in the app UI or as a Hub action, I can wire that next.
