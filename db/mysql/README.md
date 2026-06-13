# Postgres → MySQL migration

Converts the AstraReach database (schema + data) to MySQL 8.0.16+.
Note: this migrates the **database only** — the app code still uses Postgres
(`pg`, `$1` placeholders, JSONB operators, `ON CONFLICT`, `RETURNING`, etc.).

## Steps (run on your Mac)

```bash
# 1. Install and start MySQL 8
brew install mysql
brew services start mysql

# 2. Load the converted schema (creates the astrareach database)
mysql -u root < db/mysql/schema.mysql.sql

# 3. Copy data from your running Postgres into MySQL
MYSQL_URL=mysql://root@localhost:3306/astrareach node scripts/migrate-to-mysql.js
```

The script reads Postgres from `DATABASE_URL` in `.env`, copies all 23 tables
in batches of 500, skips rows that already exist, and finishes with a
per-table row-count verification (exits non-zero on any mismatch).

## Type mappings

| PostgreSQL | MySQL |
|---|---|
| `UUID DEFAULT gen_random_uuid()` | `CHAR(36) DEFAULT (UUID())` |
| `JSONB`, `TEXT[]` | `JSON` (arrays become JSON arrays) |
| `TIMESTAMPTZ` | `DATETIME(6)` stored as UTC |
| `BIGSERIAL` | `BIGINT AUTO_INCREMENT` |
| `NUMERIC(p,s)` | `DECIMAL(p,s)` |
| indexed `TEXT` | `VARCHAR(n)` (MySQL can't index bare TEXT) |
| GIN tsvector index | `FULLTEXT` index |
| GIN on JSONB/arrays | none — add generated-column indexes per query if needed |
| partial index `WHERE status='queued'` | plain index `(status, scheduled_at)` |

## Caveats

- JSON columns have no DEFAULT in MySQL here; the data copy fills real values,
  but new inserts must supply `{}`/`[]` explicitly (the Postgres app code did this via defaults).
- `ILIKE`, `::casts`, `ON CONFLICT`, `RETURNING` in app queries are Postgres-only —
  the app cannot run against MySQL without a code migration (~379 queries).
- FULLTEXT search behaves differently from Postgres `to_tsvector` (no stemming config, boolean mode syntax).
