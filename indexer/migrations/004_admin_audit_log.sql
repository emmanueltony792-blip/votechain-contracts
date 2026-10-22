-- Copyright 2024 VoteChain Contributors
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- Migration 004: admin audit log table (issue #321)
--
-- Stores an immutable record of every admin governance operation:
-- cancel, execute, update_quorum, transfer_admin, pause, unpause.
--
-- The table is append-only by application design:
--   - The indexer only ever INSERTs into this table.
--   - No UPDATE or DELETE statements are issued against it.
--   - No UPDATE/DELETE privileges are granted to the indexer role (enforced
--     at the application layer; consider a database role with INSERT-only
--     privileges for defence-in-depth).
--
-- Columns:
--   id            — BIGSERIAL primary key (monotonic)
--   timestamp     — when the entry was recorded (ISO-8601, UTC)
--   admin_address — the Stellar address of the admin who performed the operation
--   operation     — one of: cancel, execute, update_quorum, transfer_admin,
--                   pause, unpause
--   proposal_id   — the affected proposal ID, or NULL for pause/unpause/
--                   transfer_admin
--   tx_hash       — the on-chain transaction hash of the admin operation

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id            BIGSERIAL   PRIMARY KEY,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    admin_address TEXT        NOT NULL,
    operation     TEXT        NOT NULL,
    proposal_id   BIGINT,  -- NULL for pause/unpause/transfer_admin
    tx_hash       TEXT        NOT NULL
);

-- Index for filtering by admin address (GET /admin/audit-log?admin_address=...)
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin
    ON admin_audit_log (admin_address);

-- Index for filtering by operation (GET /admin/audit-log?operation=...)
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_operation
    ON admin_audit_log (operation);

-- Index for filtering by proposal ID (GET /admin/audit-log?proposal_id=...)
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_proposal
    ON admin_audit_log (proposal_id)
    WHERE proposal_id IS NOT NULL;

-- Index for chronological ordering (newest-first queries)
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_id_desc
    ON admin_audit_log (id DESC);

-- Check constraint: operation must be a recognised admin operation.
ALTER TABLE admin_audit_log
    DROP CONSTRAINT IF EXISTS chk_admin_audit_log_operation;
ALTER TABLE admin_audit_log
    ADD CONSTRAINT chk_admin_audit_log_operation
    CHECK (operation IN (
        'cancel', 'execute', 'update_quorum',
        'transfer_admin', 'pause', 'unpause'
    ));

-- Comment for documentation purposes.
COMMENT ON TABLE admin_audit_log IS
    'Append-only audit log of admin governance operations (issue #321). '
    'Only INSERTs are permitted — no UPDATE or DELETE.';
