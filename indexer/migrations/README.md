# Indexer Database Migrations

VoteChain indexer uses [sqlx built-in migrations](https://docs.rs/sqlx/latest/sqlx/macro.migrate.html)
to manage the PostgreSQL schema incrementally.

## How it works

- Migration files live in this directory (`indexer/migrations/`).
- At startup the indexer calls `sqlx::migrate!("./migrations").run(&pool)` which:
  1. Creates a `_sqlx_migrations` tracking table if it does not exist.
  2. Reads all `*.sql` files in this directory, sorted by version number.
  3. Applies only the migrations that have not yet been run.
  4. Records each applied migration with a checksum in `_sqlx_migrations`.

This replaces the previous `sqlx::raw_sql(include_str!(...))` approach which
re-executed the full schema script on every startup. The old approach was safe
only because all statements used `CREATE TABLE IF NOT EXISTS`, but it could not
handle `ALTER TABLE`, column additions, data backfills, or any change that is
not idempotent via `IF NOT EXISTS`.

## File naming convention

```
{version}_{description}.sql
```

- `version`: zero-padded integer, e.g. `001`, `002`, `003`
- `description`: snake_case description of the change

Examples:
- `001_init.sql` — initial schema
- `002_add_voter_index.sql` — voter address index

## Adding a new migration

1. Create a new file: `indexer/migrations/003_your_description.sql`
2. Write forward-only SQL (no rollback — sqlx does not support down migrations by default)
3. Test locally: `sqlx migrate run --database-url $DATABASE_URL`
4. Commit the file; it will be applied automatically on the next indexer startup

## Running migrations manually

```bash
# Apply all pending migrations
sqlx migrate run --database-url "$DATABASE_URL" --source indexer/migrations

# Check migration status
sqlx migrate info --database-url "$DATABASE_URL" --source indexer/migrations
```

Install the sqlx CLI: `cargo install sqlx-cli --no-default-features --features postgres`

## Pre-deployment migration check (#275)

Before deploying the backend or indexer to staging/production, run the
migration check script to detect and apply pending migrations:

```bash
# Interactive (prompts before applying)
DATABASE_URL="$DATABASE_URL" ./scripts/check-db-migrations.sh

# Non-interactive / CI (auto-applies pending migrations)
SKIP_MIGRATION_CONFIRMATION=yes DATABASE_URL="$DATABASE_URL" ./scripts/check-db-migrations.sh

# Abort on pending (do not auto-apply — requires manual intervention)
SKIP_MIGRATION_CONFIRMATION=no DATABASE_URL="$DATABASE_URL" ./scripts/check-db-migrations.sh
```

The script:
1. Runs `sqlx migrate info` to list migration status.
2. If migrations are pending and confirmation is enabled (default in CI),
   applies them atomically via `sqlx migrate run`.
3. Verifies all migrations are applied after the run.
4. Exits non-zero on any failure, blocking the deployment.

The staging deploy workflow (`.github/workflows/deploy-staging.yml`) runs
this check automatically before deploying contracts.

## Rollback procedure for failed migrations

sqlx migrations are forward-only — there is no automatic `down` migration.
If a migration fails or produces unexpected results, follow this manual
rollback procedure:

### 1. Identify the failed migration

```bash
sqlx migrate info --database-url "$DATABASE_URL" --source indexer/migrations
```

Look for migrations with status "Pending" (failed mid-apply) or the most
recent "Applied" migration if the issue was discovered after application.

### 2. Restore from a database backup (recommended)

The safest rollback is to restore the database from a snapshot taken before
the migration was applied. This is the recommended approach for production:

```bash
# Drop and recreate the database (or restore from pg_dump backup)
psql "$DATABASE_URL" -c "DROP DATABASE IF EXISTS votechain_indexer;"
psql "$DATABASE_URL" -c "CREATE DATABASE votechain_indexer;"
# Restore from backup
psql "$DATABASE_URL" < backup_before_migration.sql

# Verify the _sqlx_migrations table reflects the pre-migration state
sqlx migrate info --database-url "$DATABASE_URL" --source indexer/migrations
```

### 3. Manually revert the schema changes (if no backup available)

If no backup exists, manually undo the SQL statements in the failed
migration file. Each migration file is self-contained, so read the SQL and
write the inverse operations (e.g. `DROP TABLE` for `CREATE TABLE`, `DROP
COLUMN` for `ADD COLUMN`):

```bash
# Example: reverting migration 002 (added voter_address column)
psql "$DATABASE_URL" -c "ALTER TABLE contract_events DROP COLUMN IF EXISTS voter_address;"
psql "$DATABASE_URL" -c "DROP INDEX IF EXISTS idx_events_voter;"

# Remove the failed migration from the tracking table so sqlx re-runs it
# next time (only do this if you've fully reverted its changes):
psql "$DATABASE_URL" -c "DELETE FROM _sqlx_migrations WHERE version = '<failed_version>';"
```

### 4. Fix and re-apply

After rolling back:
1. Fix the migration SQL file (or the data that caused the failure).
2. Re-run `sqlx migrate run` to re-apply.
3. Run the pre-deployment check to confirm all migrations are applied:
   ```bash
   ./scripts/check-db-migrations.sh
   ```

> **Warning:** Never edit an already-applied migration file. sqlx stores a
> checksum per migration in `_sqlx_migrations` and will refuse to proceed if
> the file has changed. Always create a new migration file to fix a bad
> migration, or delete the tracking row only after fully reverting its
> effects.

## Existing migrations

| Version | File                        | Description                                       |
|---------|-----------------------------|---------------------------------------------------|
| 001     | `001_init.sql`              | Initial schema: `indexer_cursor`, `contract_events`, indexes |
| 002     | `002_add_voter_index.sql`   | Add `voter_address` column and index for voter vote history |
| 003     | `003_dedupe_events.sql`     | Remove duplicate events and add a unique index so `ON CONFLICT DO NOTHING` de-duplicates |
| 004     | `004_admin_audit_log.sql`   | Append-only `admin_audit_log` table for admin governance operations (issue #321) |
