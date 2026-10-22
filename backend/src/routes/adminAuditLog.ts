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
 * Admin audit-log routes (issue #321).
 *
 * GET /admin/audit-log — returns paginated, filtered audit-log entries for
 * admin governance operations.  Protected by the adminAuth middleware so only
 * the on-chain admin can access the log.
 *
 * Query parameters:
 *   limit          Page size (default 50, max 100)
 *   offset         Number of entries to skip (default 0)
 *   admin_address  Filter by admin Stellar address
 *   operation      Filter by operation type (cancel, execute, update_quorum,
 *                  transfer_admin, pause, unpause)
 *   proposal_id    Filter by affected proposal ID
 */

import { Router, Request, Response } from "express";
import { adminAuth } from "../middleware/adminAuth";
import {
  query,
  AdminOperation,
  ADMIN_EVENT_TOPICS,
} from "../services/auditLogService";

const router = Router();

/** Valid operation filter values, used for request validation. */
const VALID_OPERATIONS = new Set<string>([
  "cancel",
  "execute",
  "update_quorum",
  "transfer_admin",
  "pause",
  "unpause",
]);

/**
 * GET /admin/audit-log
 *
 * Response 200:
 *   {
 *     "data": [
 *       {
 *         "id": 1,
 *         "timestamp": "2026-01-15T10:30:00.000Z",
 *         "admin_address": "G...",
 *         "operation": "execute",
 *         "proposal_id": 42,
 *         "tx_hash": "abc123..."
 *       },
 *       ...
 *     ],
 *     "total": 127,
 *     "limit": 50,
 *     "offset": 0
 *   }
 *
 * Response 400:
 *   { "error": { "code": "INVALID_REQUEST", "message": "...", "details": [] } }
 *
 * Response 401/403 — handled by adminAuth middleware.
 */
router.get("/admin/audit-log", adminAuth, (req: Request, res: Response) => {
  // ── Parse & validate query params ──────────────────────────────────────

  // limit (default 50, max 100)
  const rawLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.min(100, Math.max(1, rawLimit));

  // offset (default 0)
  const rawOffset = Number.parseInt(String(req.query.offset ?? "0"), 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  // admin_address filter
  const adminAddress =
    typeof req.query.admin_address === "string" && req.query.admin_address !== ""
      ? req.query.admin_address
      : undefined;

  // operation filter
  const operation =
    typeof req.query.operation === "string" ? req.query.operation : undefined;

  if (operation && !VALID_OPERATIONS.has(operation)) {
    return res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: `Invalid operation. Allowed: ${[...VALID_OPERATIONS].join(", ")}`,
        details: [],
      },
    });
  }

  // proposal_id filter
  let proposalId: number | undefined;
  if (req.query.proposal_id !== undefined) {
    const parsed = Number.parseInt(String(req.query.proposal_id), 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return res.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "proposal_id must be a non-negative integer",
          details: [],
        },
      });
    }
    proposalId = parsed;
  }

  // ── Query the audit log ──────────────────────────────────────────────────

  const result = query({
    limit,
    offset,
    admin_address: adminAddress,
    operation: operation as AdminOperation | undefined,
    proposal_id: proposalId,
  });

  return res.json(result);
});

// Re-export for consumers that need the set of recognised admin event topics.
export { ADMIN_EVENT_TOPICS };

export default router;
