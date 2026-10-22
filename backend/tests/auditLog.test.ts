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
 * Tests for the admin audit-log service and route (issue #321).
 *
 * Covers:
 *   - Audit log entries are append-only (no update/delete)
 *   - GET /admin/audit-log requires admin auth
 *   - GET /admin/audit-log returns entries with correct fields
 *   - Pagination works
 *   - Filtering by operation and admin_address works
 *
 * Test structure:
 *   - Service-level tests exercise the auditLogService directly.
 *   - Auth tests use a separate Express app with the *real* adminAuth
 *     middleware (only 3 requests — well within the 10 req/min rate limit).
 *   - Data/pagination/filtering tests use an app with a bypass middleware so
 *     the adminAuth rate limiter does not interfere.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

// Mock Redis so the rate limiter degrades gracefully (allows all requests).
vi.mock("../src/middleware/redisCache", () => ({
  getRedis: () => null,
  isRedisReady: () => false,
  connectRedis: vi.fn().mockResolvedValue(undefined),
}));

// Mock adminAuth to a pass-through for the data/pagination/filtering tests.
// Auth tests create a separate app that uses the real middleware (via
// vi.importActual) to avoid the module-level rate limiter interacting with
// the many data tests.
vi.mock("../src/middleware/adminAuth", () => ({
  adminAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));

import adminAuditLogRouter from "../src/routes/adminAuditLog";
import {
  append,
  query,
  recordFromEvent,
  ADMIN_EVENT_TOPICS,
  _clearStoreForTesting,
  _storeLengthForTesting,
  _storeForTesting,
} from "../src/services/auditLogService";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADMIN_ADDRESS = "GADMIN1234567890";
const JWT_SECRET = "test-secret";
const OTHER_ADDRESS = "GVOTER9876543210";

/** Signs a valid admin JWT for the test admin address. */
function adminToken(): string {
  return jwt.sign({ stellarAddress: ADMIN_ADDRESS }, JWT_SECRET);
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/**
 * Data app — uses the mocked (bypass) adminAuth via the imported route.
 * Used for all data, pagination, and filtering tests.
 */
const dataApp = express();
dataApp.use(express.json());
dataApp.use(adminAuditLogRouter);

/**
 * Auth app — created lazily in the auth describe block using the real
 * adminAuth middleware (loaded via vi.importActual) so that 401/403
 * behavior is tested without interfering with the data test rate limiter.
 */
let authApp: express.Express;

beforeEach(() => {
  // Clear the in-memory store before each test so they are independent.
  _clearStoreForTesting();
  // Set the env vars that adminAuth reads.
  process.env.ADMIN_JWT_SECRET = JWT_SECRET;
  process.env.ADMIN_STELLAR_ADDRESS = ADMIN_ADDRESS;
});

// ---------------------------------------------------------------------------
// Service-level tests
// ---------------------------------------------------------------------------

describe("auditLogService — append-only invariant", () => {
  beforeEach(() => _clearStoreForTesting());

  it("append adds entries and assigns monotonic IDs", () => {
    const e1 = append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 1,
      tx_hash: "tx-a",
    });
    const e2 = append({
      admin_address: ADMIN_ADDRESS,
      operation: "cancel",
      proposal_id: 2,
      tx_hash: "tx-b",
    });

    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(_storeLengthForTesting()).toBe(2);
  });

  it("append assigns ISO-8601 timestamps", () => {
    const entry = append({
      admin_address: ADMIN_ADDRESS,
      operation: "pause",
      proposal_id: null,
      tx_hash: "tx-pause",
    });

    expect(entry.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/,
    );
  });

  it("entries are never updated or deleted — the store only grows", () => {
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 1,
      tx_hash: "tx-a",
    });

    const snapshot = _storeForTesting().slice();
    expect(snapshot.length).toBe(1);

    // Appending a new entry does not change the existing one.
    append({
      admin_address: OTHER_ADDRESS,
      operation: "cancel",
      proposal_id: 2,
      tx_hash: "tx-b",
    });

    const after = _storeForTesting().slice();
    expect(after.length).toBe(2);
    // First entry is unchanged.
    expect(after[0]).toEqual(snapshot[0]);
  });

  it("query returns all entries with total count", () => {
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 1,
      tx_hash: "tx-a",
    });
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "cancel",
      proposal_id: 2,
      tx_hash: "tx-b",
    });

    const result = query({ limit: 50 });
    expect(result.data.length).toBe(2);
    expect(result.total).toBe(2);
  });

  it("query returns entries newest-first", () => {
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 1,
      tx_hash: "tx-a",
    });
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "cancel",
      proposal_id: 2,
      tx_hash: "tx-b",
    });

    const result = query();
    expect(result.data[0].id).toBe(2);
    expect(result.data[1].id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordFromEvent — indexer integration
// ---------------------------------------------------------------------------

describe("recordFromEvent", () => {
  beforeEach(() => _clearStoreForTesting());

  it("records a cancel event", () => {
    const entry = recordFromEvent({
      topic: "cancelled",
      tx_hash: "tx-cancel",
      admin_address: ADMIN_ADDRESS,
      proposal_id: 42,
    });

    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe("cancel");
    expect(entry!.proposal_id).toBe(42);
    expect(entry!.tx_hash).toBe("tx-cancel");
  });

  it("records an execute event", () => {
    const entry = recordFromEvent({
      topic: "executed",
      tx_hash: "tx-exec",
      admin_address: ADMIN_ADDRESS,
      proposal_id: 7,
    });

    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe("execute");
  });

  it("records an update_quorum event", () => {
    const entry = recordFromEvent({
      topic: "qupdate",
      tx_hash: "tx-quorum",
      admin_address: ADMIN_ADDRESS,
      proposal_id: 5,
    });

    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe("update_quorum");
  });

  it("records a transfer_admin event with null proposal_id", () => {
    const entry = recordFromEvent({
      topic: "admxfer",
      tx_hash: "tx-admxfer",
      admin_address: ADMIN_ADDRESS,
    });

    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe("transfer_admin");
    expect(entry!.proposal_id).toBeNull();
  });

  it("records a pause event with null proposal_id", () => {
    const entry = recordFromEvent({
      topic: "paused",
      tx_hash: "tx-pause",
      admin_address: ADMIN_ADDRESS,
    });

    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe("pause");
    expect(entry!.proposal_id).toBeNull();
  });

  it("records an unpause event with null proposal_id", () => {
    const entry = recordFromEvent({
      topic: "unpaused",
      tx_hash: "tx-unpause",
      admin_address: ADMIN_ADDRESS,
    });

    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe("unpause");
    expect(entry!.proposal_id).toBeNull();
  });

  it("returns null for a non-admin event topic (e.g. vote)", () => {
    const entry = recordFromEvent({
      topic: "vote",
      tx_hash: "tx-vote",
      admin_address: OTHER_ADDRESS,
      proposal_id: 1,
    });

    expect(entry).toBeNull();
  });

  it("ADMIN_EVENT_TOPICS contains all admin topics", () => {
    expect(ADMIN_EVENT_TOPICS.has("cancelled")).toBe(true);
    expect(ADMIN_EVENT_TOPICS.has("executed")).toBe(true);
    expect(ADMIN_EVENT_TOPICS.has("qupdate")).toBe(true);
    expect(ADMIN_EVENT_TOPICS.has("admxfer")).toBe(true);
    expect(ADMIN_EVENT_TOPICS.has("paused")).toBe(true);
    expect(ADMIN_EVENT_TOPICS.has("unpaused")).toBe(true);
    expect(ADMIN_EVENT_TOPICS.has("vote")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth tests — uses the REAL adminAuth middleware on a separate app
// ---------------------------------------------------------------------------

describe("GET /admin/audit-log — auth", () => {
  beforeEach(async () => {
    _clearStoreForTesting();

    // Load the real adminAuth (not the mocked version) and build a minimal
    // app that uses it.  Only 3 requests are made in this block, well within
    // the 10 req/min rate limit.
    const actual = await vi.importActual<
      typeof import("../src/middleware/adminAuth")
    >("../src/middleware/adminAuth");

    authApp = express();
    authApp.use(express.json());
    authApp.get(
      "/admin/audit-log",
      actual.adminAuth,
      (_req: Request, res: Response) => {
        const result = query();
        res.json(result);
      },
    );
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await request(authApp).get("/admin/audit-log");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for an invalid JWT", async () => {
    const res = await request(authApp)
      .get("/admin/audit-log")
      .set("Authorization", "Bearer invalid-token");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("returns 403 when the JWT payload has the wrong Stellar address", async () => {
    const token = jwt.sign({ stellarAddress: "WRONG_ADDRESS" }, JWT_SECRET);

    const res = await request(authApp)
      .get("/admin/audit-log")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// Data / pagination / filtering tests — uses bypassed auth
// ---------------------------------------------------------------------------

describe("GET /admin/audit-log — data, pagination, filtering", () => {
  beforeEach(() => _clearStoreForTesting());

  // ── Empty log ────────────────────────────────────────────────────────────────

  it("returns an empty array when the log is empty", async () => {
    const res = await request(dataApp).get("/admin/audit-log");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });

  // ── Returns entries with correct fields ────────────────────────────────────

  it("returns entries with the correct fields", async () => {
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 42,
      tx_hash: "tx-abc",
    });

    const res = await request(dataApp).get("/admin/audit-log");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const entry = res.body.data[0];
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("timestamp");
    expect(entry.admin_address).toBe(ADMIN_ADDRESS);
    expect(entry.operation).toBe("execute");
    expect(entry.proposal_id).toBe(42);
    expect(entry.tx_hash).toBe("tx-abc");
  });

  // ── Pagination ──────────────────────────────────────────────────────────────

  it("pagination returns the correct page and total", async () => {
    // Insert 5 entries.
    for (let i = 1; i <= 5; i++) {
      append({
        admin_address: ADMIN_ADDRESS,
        operation: "execute",
        proposal_id: i,
        tx_hash: `tx-${i}`,
      });
    }

    // Page 1: limit=2, offset=0 → newest 2 (IDs 5, 4)
    const page1 = await request(dataApp).get("/admin/audit-log?limit=2&offset=0");

    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.data[0].id).toBe(5);
    expect(page1.body.data[1].id).toBe(4);
    expect(page1.body.total).toBe(5);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);

    // Page 2: limit=2, offset=2 → IDs 3, 2
    const page2 = await request(dataApp).get("/admin/audit-log?limit=2&offset=2");

    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.data[0].id).toBe(3);
    expect(page2.body.data[1].id).toBe(2);
  });

  it("clamps limit to a maximum of 100", async () => {
    const res = await request(dataApp).get("/admin/audit-log?limit=500");

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });

  it("defaults limit to 50 when omitted", async () => {
    const res = await request(dataApp).get("/admin/audit-log");

    expect(res.body.limit).toBe(50);
  });

  // ── Filtering ────────────────────────────────────────────────────────────────

  it("filters by operation", async () => {
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 1,
      tx_hash: "tx-exec",
    });
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "cancel",
      proposal_id: 2,
      tx_hash: "tx-cancel",
    });
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 3,
      tx_hash: "tx-exec2",
    });

    const res = await request(dataApp).get("/admin/audit-log?operation=execute");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(
      res.body.data.every(
        (e: { operation: string }) => e.operation === "execute",
      ),
    ).toBe(true);
    expect(res.body.total).toBe(2);
  });

  it("filters by admin_address", async () => {
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 1,
      tx_hash: "tx-a",
    });
    append({
      admin_address: OTHER_ADDRESS,
      operation: "execute",
      proposal_id: 2,
      tx_hash: "tx-b",
    });

    const res = await request(dataApp).get(
      `/admin/audit-log?admin_address=${ADMIN_ADDRESS}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].admin_address).toBe(ADMIN_ADDRESS);
  });

  it("filters by proposal_id", async () => {
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "execute",
      proposal_id: 42,
      tx_hash: "tx-a",
    });
    append({
      admin_address: ADMIN_ADDRESS,
      operation: "cancel",
      proposal_id: 99,
      tx_hash: "tx-b",
    });

    const res = await request(dataApp).get("/admin/audit-log?proposal_id=42");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].proposal_id).toBe(42);
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it("returns 400 for an invalid operation filter", async () => {
    const res = await request(dataApp).get("/admin/audit-log?operation=bogus");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 400 for a negative proposal_id", async () => {
    const res = await request(dataApp).get("/admin/audit-log?proposal_id=-1");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
  });
});
