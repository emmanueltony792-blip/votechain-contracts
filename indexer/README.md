# VoteChain Indexer

Off-chain indexer for VoteChain contract events on Stellar.

## Features

- Subscribes to Stellar Horizon event stream for contract events
- Parses and stores all VoteChain events in PostgreSQL
- Handles reorgs and missed events with cursor-based backfill
- Exposes REST API for frontend queries
- Processes events with < 5s latency (configurable poll interval)

## Architecture

The indexer is a single Rust binary (`votechain-indexer`) that runs two
concurrent halves in one process: a background ingestion loop and a small
Axum REST API, both sharing one `sqlx` PostgreSQL connection pool.

```
┌──────────────┐   poll every        ┌────────────────────────┐
│ Stellar      │◄── POLL_INTERVAL ───┤ Indexer — ingest loop   │
│ Horizon      │   GET /contracts/   │ (tokio::spawn, main.rs) │
│ (RPC/events) │   {id}/events       │                         │
└──────────────┘                     │  1. read cursor         │
                                      │  2. fetch events after  │
                                      │     cursor from Horizon │
                                      │  3. filter known topics │
                                      │  4. INSERT ... ON       │
                                      │     CONFLICT DO NOTHING │
                                      │  5. advance cursor      │
                                      │  6. POST /invalidate to │
                                      │     BACKEND_URL (async) │
                                      └───────────┬─────────────┘
                                                  │ writes
                                                  ▼
                                    ┌──────────────────────────┐
                                    │ PostgreSQL                │
                                    │  - indexer_cursor          │
                                    │  - contract_events          │
                                    └───────────┬───────────────┘
                                                  │ reads
                                                  ▼
                                    ┌──────────────────────────┐
                                    │ Indexer — REST API          │
                                    │ (Axum, same process)        │
                                    │  GET /events                │
                                    │  GET /events/proposals/{id} │
                                    └───────────┬───────────────┘
                                                  │
                                                  ▼
                                      Frontend / `backend` service
                                      (backend/ also has its own
                                      Redis-cached /proposals API
                                      that is invalidated by step 6
                                      above — see ../backend)
```

The indexer never queries Horizon *on demand* for API requests — it polls
Horizon on a timer, persists events, and the REST API only ever reads from
Postgres. This keeps read latency low and decouples API availability from
Horizon's uptime. See [`docs/adr/`](../docs/adr/) for the ADRs covering why
a separate indexer service, PostgreSQL, and the Redis caching layer in
`backend/` were chosen:

- [ADR-013](../docs/adr/ADR-013-separate-indexer-service.md) — separate indexer service
- [ADR-014](../docs/adr/ADR-014-postgresql-storage-backend.md) — PostgreSQL storage backend
- [ADR-015](../docs/adr/ADR-015-redis-caching-strategy.md) — Redis caching strategy
- [ADR-016](../docs/adr/ADR-016-indexer-technology-postgresql-rust.md) — consolidated indexer technology choice (PostgreSQL + Rust)

## Prerequisites

- Rust (stable toolchain; see the repo's root `rust-toolchain`/CI for the pinned version)
- PostgreSQL 14+ reachable from wherever the indexer runs
- Network access to a Stellar Horizon endpoint (testnet or mainnet)
- Docker, only if you want to run Postgres via `docker-compose.yml` at the repo root instead of a local install

## Setup

### 1. Install prerequisites

```bash
# From the repo root — starts a local Postgres via Docker (optional; you can
# instead point DATABASE_URL at any Postgres instance you already have).
docker run -d --name votechain-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=votechain \
  postgres:16-alpine
```

### 2. Configure environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string, e.g. `postgres://user:pass@localhost/votechain`. Must use the `postgres://` or `postgresql://` scheme and include a host. |
| `DATABASE_PASSWORD_FILE` | No | — | Path to a file containing the DB password. If set, `DATABASE_URL` must **not** embed a password itself — the indexer reads and injects it, then scrubs both env vars from its own process environment on startup so credentials never appear in `/proc/self/environ`. |
| `CONTRACT_ID` | Yes | — | Deployed VoteChain governance contract address (starts with `C`). |
| `HORIZON_URL` | No | `https://horizon-testnet.stellar.org` | Horizon endpoint to poll for contract events. Use a mainnet Horizon URL (or your own instance) in production. |
| `POLL_INTERVAL_SECS` | No | `3` | How often to poll Horizon for new events. See [Performance tuning](#performance-tuning). |
| `BACKEND_URL` | No | — | Base URL of the `backend/` service. When set, the indexer fires a best-effort `POST {BACKEND_URL}/api/proposals/invalidate` after ingesting a state-changing event, so the backend's Redis cache doesn't serve stale data. Safe to leave unset — cache invalidation is skipped, not fatal. |

Example:

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/votechain"
export CONTRACT_ID="CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
export HORIZON_URL="https://horizon-testnet.stellar.org"
export POLL_INTERVAL_SECS="3"
export BACKEND_URL="http://localhost:3001"   # optional
```

If any required variable is missing, the indexer fails fast at startup with
a single error listing every missing variable (rather than crashing on the
first one it hits) — see `validate_env()` in `src/main.rs`.

### 3. Run migrations

Migrations are **applied automatically on startup** via
`sqlx::migrate!("./migrations").run(&pool)` — you do not need a separate
migration step in normal operation. See
[`migrations/README.md`](migrations/README.md) for the full mechanism, how
to add a new migration, and how to run migrations manually with `sqlx-cli`
(useful for CI or pre-flighting a schema change before deploying).

### 4. Start the indexer

```bash
# From the repo root
cargo run -p votechain-indexer
```

This starts both the ingestion loop (background task) and the REST API
(`0.0.0.0:4000`) in one process. Logs go to stdout via `tracing_subscriber`;
set `RUST_LOG=votechain_indexer=debug` (or `info`/`warn`) to control verbosity.

## API Endpoints

- `GET /events` — last 100 events across all proposals, newest first
- `GET /events/proposals/{id}` — all events for a specific proposal, oldest first

## Event Types

| Topic | Description |
|-------|-------------|
| `init` | Contract initialized |
| `created` | Proposal created |
| `vote` | Vote cast |
| `final` | Proposal finalized (Passed/Rejected) |
| `executed` | Proposal executed |
| `cancelled` | Proposal cancelled |
| `qupdate` | Quorum updated |
| `admxfer` | Admin transferred |
| `paused` | Contract paused |
| `unpaused` | Contract unpaused |
| `durationupdate` | Duration limits updated |

Any topic not in this list is logged as `unknown event topic — skipping`
and is **not** persisted, but the ingestion cursor still advances past it
(see [Troubleshooting](#unknown-event-topic-warnings)).

### Admin audit log (issue #321)

In addition to persisting all contract events in `contract_events`, the
indexer also writes an entry to the append-only `admin_audit_log` table
(migration `004_admin_audit_log.sql`) for every admin governance operation:

| Event topic | `admin_audit_log.operation` |
|-------------|-----------------------------|
| `cancelled` | `cancel`                    |
| `executed`  | `execute`                    |
| `qupdate`   | `update_quorum`             |
| `admxfer`   | `transfer_admin`            |
| `paused`    | `pause`                     |
| `unpaused`  | `unpause`                    |

Each row records:

- `timestamp` — when the entry was recorded
- `admin_address` — the admin's Stellar address
- `operation` — the admin operation performed
- `proposal_id` — the affected proposal (NULL for pause/unpause/transfer_admin)
- `tx_hash` — the on-chain transaction hash

The table is **append-only** — the indexer only INSERTs. No UPDATE or DELETE
is ever issued. The backend exposes this log via `GET /admin/audit-log`
(admin-auth required).

## The cursor mechanism

The indexer tracks ingestion progress per contract in the `indexer_cursor`
table:

```sql
CREATE TABLE indexer_cursor (
    contract_id TEXT PRIMARY KEY,
    last_ledger  BIGINT NOT NULL DEFAULT 0
);
```

On every poll cycle (`poll_once` in `src/main.rs`):

1. Read `last_ledger` for `CONTRACT_ID` (defaults to `0` if no row exists yet — i.e. index from the very first ledger the contract could have emitted events on).
2. Fetch up to 200 events from Horizon with `cursor=<last_ledger>&order=asc`.
3. Insert each recognized event with `INSERT ... ON CONFLICT DO NOTHING`, deduplicated by `(contract_id, ledger_seq, tx_hash, topic, payload)` (migration `003_dedupe_events.sql`).
4. Advance `last_ledger` to the highest ledger seen in the batch and persist it — **but only after the whole batch inserts successfully**. If any insert in the batch fails (e.g. a transient DB error), the cursor is *not* advanced, so the next poll retries the same batch from the same starting point rather than skipping events.

### Resetting / replaying from a specific ledger

To force the indexer to re-ingest from an earlier point (e.g. you suspect
events were missed, or you're backfilling a freshly deployed contract to an
existing database), directly update the cursor row:

```sql
-- Replay everything from ledger 1000000 onward for this contract.
UPDATE indexer_cursor
SET last_ledger = 1000000
WHERE contract_id = 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

-- Or, to replay from the very beginning:
DELETE FROM indexer_cursor
WHERE contract_id = 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
```

Because inserts use `ON CONFLICT DO NOTHING` on the dedupe key, replaying a
range that was already ingested is safe — already-stored events are simply
skipped again rather than duplicated. Restart the indexer process (or just
wait for the next poll tick) after changing the cursor.

## Troubleshooting

### "unknown event topic" warnings

```
WARN unknown event topic — skipping other="mystery"
```

This means Horizon returned a contract event whose first topic segment
isn't in the recognized list above. Causes:

- A new contract version emits a topic the indexer doesn't know about yet — add it to the `match topic { ... }` arm in `poll_once` (`src/main.rs`) and to the table above.
- `CONTRACT_ID` points at the wrong contract (e.g. the token contract instead of the governance contract, or a stale/test deployment), so you're seeing unrelated events.
- Horizon is indexing a contract upgrade transition and topic shapes changed mid-migration.

These events are **not** stored, but the cursor still advances past their
ledger so the indexer doesn't get stuck re-fetching them forever. If you add
support for a new topic later, use the [replay procedure](#resetting--replaying-from-a-specific-ledger)
to re-ingest the ledger range where it first appeared.

### Database connection errors

- `connect to postgres` error at startup — verify `DATABASE_URL` is reachable from where the indexer runs (not just from your workstation), and that the `postgres://`/`postgresql://` scheme and host are correct. Error messages intentionally never include the URL itself, to avoid leaking credentials into logs.
- `DATABASE_URL must not embed a password when DATABASE_PASSWORD_FILE is set` — pick one credential-supply mechanism, not both.
- `run database migrations` error at startup — usually means the DB user lacks `CREATE TABLE`/`ALTER TABLE` privileges, or a migration was hand-edited after being applied (sqlx tracks a checksum per migration in `_sqlx_migrations` and refuses to proceed on a mismatch). Never edit an already-applied migration file — add a new one instead (see [`migrations/README.md`](migrations/README.md)).
- Connection pool exhaustion under load — the pool is capped at 5 connections (`PgPoolOptions::new().max_connections(5)`); if you're running many concurrent API consumers, consider raising this in `src/main.rs` and checking Postgres's own `max_connections`.

### Horizon 429 rate limits

Horizon's public testnet/mainnet endpoints rate-limit aggressively under
sustained polling. Symptoms: `poll error: ... 429 Too Many Requests` in the
logs, with ingestion stalling until the next successful poll.

Mitigations:

- Increase `POLL_INTERVAL_SECS` (see [Performance tuning](#performance-tuning)) — 429s are almost always a sign you're polling faster than the endpoint allows for your traffic tier.
- Run your own Horizon instance (or use a paid RPC provider) for mainnet production indexing instead of the public `horizon-testnet.stellar.org` / `horizon.stellar.org` endpoints, which are shared and best-effort.
- The indexer does not currently implement retry-with-backoff on 429s specifically — a failed poll simply logs the error and waits for the next `POLL_INTERVAL_SECS` tick, which acts as a crude backoff. If you're hitting 429s frequently, that tick interval is your effective retry delay, so raising it directly reduces rate-limit pressure.

## Performance tuning

`POLL_INTERVAL_SECS` controls the ingestion loop's polling frequency and is
the main lever for balancing event latency against Horizon load:

| Environment | Suggested `POLL_INTERVAL_SECS` | Rationale |
|-------------|-------------------------------|-----------|
| Local development / testnet | `2`–`5` (default `3`) | Testnet traffic is low-volume; fast polling gives near-real-time feedback while iterating and rarely hits rate limits. |
| Shared/public testnet under load-testing | `5`–`10` | Load tests generate bursts of events; a shorter interval multiplies request volume against Horizon without meaningfully improving perceived latency once you're batching 200 events per poll anyway. |
| Mainnet (public Horizon) | `10`–`15` | Public Horizon aggressively rate-limits; a longer interval avoids 429s at the cost of up to ~15s event latency, which is acceptable for a governance UI (proposals run for days). |
| Mainnet (dedicated/paid Horizon or self-hosted) | `3`–`5` | With a non-shared endpoint you can safely poll closer to testnet cadence for lower latency, since you control the rate limit. |

Each poll fetches up to 200 events (`limit=200` in the Horizon query) — if a
single contract regularly produces more than 200 events per poll interval,
lower `POLL_INTERVAL_SECS` rather than raising the limit, so no single poll
cycle risks falling permanently behind.

## Testing

`src/main.rs` includes integration tests that spin up a real PostgreSQL
instance via `testcontainers` (Docker required) and an in-process mock
Horizon server:

```bash
cargo test -p votechain-indexer
```

These cover: normal ingestion, unknown-topic skipping, event
deduplication on re-delivery, and that the cursor does not advance when a
batch fails partway through (see [The cursor mechanism](#the-cursor-mechanism)).
