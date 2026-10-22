// Copyright 2024 VoteChain Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Append-only audit log service for admin operations (issue #321).
 *
 * Records every admin governance operation — cancel, execute, update_quorum,
 * transfer_admin, pause, unpause — in an immutable log with the admin address,
 * affected proposal ID (when applicable), and the on-chain transaction hash.
 *
 * Storage strategy:
 *   Today the backend has no PostgreSQL connection (it uses Redis for caching).
 *   This service is implemented as an in-memory append-only store with a clean
 *   interface so it can later be swapped for a PostgreSQL-backed implementation
 *   that writes to the `admin_audit_log` table created by indexer migration
 *   004.  The interface below (append / query / recordFromEvent) is the
 *   contract the rest of the codebase depends on.
 *
 * Append-only guarantee:
 *   Once an entry is added via `append` it can never be modified or removed.
 *   The internal array is never mutated except by `append`, and no delete or
 *   update methods exist on the service.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** The admin operations that are audited. */
export type AdminOperation =
  | "cancel"
  | "execute"
  | "update_quorum"
  | "transfer_admin"
  | "pause"
  | "unpause";

/** A single immutable audit-log entry. */
export interface AuditLogEntry {
  /** Monotonically increasing ID assigned by the service. */
  id: number;
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** The Stellar address of the admin who performed the operation. */
  admin_address: string;
  /** The admin operation that was performed. */
  operation: AdminOperation;
  /** The proposal ID affected, or null for pause/unpause/transfer_admin. */
  proposal_id: number | null;
  /** The on-chain transaction hash of the admin operation. */
  tx_hash: string;
}

/** Input shape for appending — `id` and `timestamp` are assigned by the service. */
export interface AppendInput {
  admin_address: string;
  operation: AdminOperation;
  proposal_id: number | null;
  tx_hash: string;
}

/** Query options for filtering and paginating the audit log. */
export interface QueryOptions {
  /** Maximum entries to return (default 50, hard cap 100). */
  limit?: number;
  /** Number of entries to skip (default 0). */
  offset?: number;
  /** Filter by admin Stellar address. */
  admin_address?: string;
  /** Filter by operation type. */
  operation?: AdminOperation;
  /** Filter by affected proposal ID. */
  proposal_id?: number;
}

/** The shape of an indexer contract event that represents an admin operation. */
export interface IndexerAdminEvent {
  /** The contract event topic — maps to an AdminOperation. */
  topic: string;
  /** The on-chain transaction hash. */
  tx_hash: string;
  /** The admin address extracted from the event payload. */
  admin_address: string;
  /** The proposal ID (if present in the event). */
  proposal_id?: number | null;
}

// ── Topic → operation mapping ─────────────────────────────────────────────

const TOPIC_TO_OPERATION: Record<string, AdminOperation> = {
  cancelled: "cancel",
  executed: "execute",
  qupdate: "update_quorum",
  admxfer: "transfer_admin",
  paused: "pause",
  unpaused: "unpause",
};

/**
 * Set of indexer topics that represent admin operations.
 * Used by `recordFromEvent` to decide whether an event is auditable.
 */
export const ADMIN_EVENT_TOPICS = new Set(Object.keys(TOPIC_TO_OPERATION));

// ── In-memory append-only store ────────────────────────────────────────────

/**
 * The internal store.  Entries are pushed in order and never removed.
 *
 * Module-level singleton — in production a PostgreSQL table replaces this.
 */
const store: AuditLogEntry[] = [];

/** Monotonic counter for entry IDs. */
let nextId = 1;

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Appends a new audit-log entry.  The entry is immutable once added.
 *
 * @param input  Fields supplied by the caller; `id` and `timestamp` are
 *               assigned by the service.
 * @returns      The fully-formed entry that was stored.
 */
export function append(input: AppendInput): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    admin_address: input.admin_address,
    operation: input.operation,
    proposal_id: input.proposal_id,
    tx_hash: input.tx_hash,
  };

  // Push is the only mutation path — no update or delete exists.
  store.push(entry);

  return entry;
}

/**
 * Queries the audit log with optional filters and pagination.
 *
 * Entries are returned newest-first (most recent append has the highest `id`),
 * matching the convention used by the proposals endpoint.
 *
 * @param options  Pagination + filter options.
 * @returns        `{ data, total, limit, offset }` — `total` is the count
 *                 after filtering but before pagination.
 */
export function query(options: QueryOptions = {}): {
  data: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
} {
  const limit = clampLimit(options.limit);
  const offset = Math.max(0, options.offset ?? 0);

  // Apply filters
  let filtered = store;

  if (options.admin_address) {
    filtered = filtered.filter(
      (e) => e.admin_address === options.admin_address,
    );
  }

  if (options.operation) {
    filtered = filtered.filter((e) => e.operation === options.operation);
  }

  if (options.proposal_id !== undefined) {
    filtered = filtered.filter((e) => e.proposal_id === options.proposal_id);
  }

  const total = filtered.length;

  // Sort newest-first, then apply offset/limit.
  const sorted = filtered.slice().sort((a, b) => b.id - a.id);
  const data = sorted.slice(offset, offset + limit);

  return { data, total, limit, offset };
}

/**
 * Records an audit-log entry from a parsed indexer contract event.
 *
 * Only events whose topic maps to an admin operation (see
 * `ADMIN_EVENT_TOPICS`) are recorded; all other events are ignored
 * (return `null`).
 *
 * @param event  The indexer event to record.
 * @returns      The entry that was stored, or `null` if the topic is not an
 *               admin operation.
 */
export function recordFromEvent(event: IndexerAdminEvent): AuditLogEntry | null {
  const operation = TOPIC_TO_OPERATION[event.topic];

  if (!operation) {
    return null;
  }

  return append({
    admin_address: event.admin_address,
    operation,
    proposal_id: event.proposal_id ?? null,
    tx_hash: event.tx_hash,
  });
}

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Clears the in-memory store.  ONLY for use in tests — never exported to
 * production callers.  Production code must never call this; the log is
 * append-only by design.
 *
 * @internal
 */
export function _clearStoreForTesting(): void {
  store.length = 0;
  nextId = 1;
}

/**
 * Returns the raw number of entries in the store.  Useful for testing the
 * append-only invariant.
 *
 * @internal
 */
export function _storeLengthForTesting(): number {
  return store.length;
}

/**
 * Returns a direct reference to the internal store array for testing.
 * Tests must never mutate the returned array.
 *
 * @internal
 */
export function _storeForTesting(): readonly AuditLogEntry[] {
  return store;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Clamp limit to [1, 100] with a default of 50. */
function clampLimit(raw: number | undefined): number {
  const n = raw ?? 50;
  if (Number.isNaN(n) || n < 1) return 50;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}
