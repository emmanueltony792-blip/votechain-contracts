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
 * Tests for the simulate endpoint's HTML tag validation (issue #320).
 *
 * The simulate endpoint must reject requests containing HTML tags in any
 * string field to prevent stored XSS via the API.
 */

import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mock Redis so the rate limiter degrades gracefully (allows all requests).
vi.mock("../src/middleware/redisCache", () => ({
  getRedis: () => null,
  isRedisReady: () => false,
  connectRedis: vi.fn().mockResolvedValue(undefined),
}));

// Import the simulate router (default export).
import simulateRouter from "../src/routes/simulate";

// Minimal Express app with just the simulate route mounted.
const app = express();
app.use(express.json());
app.use(simulateRouter);

describe("POST /simulate — HTML tag validation (#320)", () => {
  it("rejects a request with HTML <script> tags in a string field", async () => {
    const res = await request(app)
      .post("/simulate")
      .send({
        token_supply: 10_000_000,
        votes_yes: 6_000_000,
        votes_no: 1_000_000,
        votes_abstain: 500_000,
        quorum: 5_000_000,
        title: "<script>alert(1)</script>",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("HTML tags");
  });

  it("rejects a request with HTML <img> tags with onerror handler", async () => {
    const res = await request(app)
      .post("/simulate")
      .send({
        token_supply: 10_000_000,
        votes_yes: 6_000_000,
        votes_no: 1_000_000,
        votes_abstain: 500_000,
        quorum: 5_000_000,
        description: '<img src=x onerror=alert(1)>',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("HTML tags");
  });

  it("accepts a valid request without any HTML tags", async () => {
    const res = await request(app)
      .post("/simulate")
      .send({
        token_supply: 10_000_000,
        votes_yes: 6_000_000,
        votes_no: 1_000_000,
        votes_abstain: 500_000,
        quorum: 5_000_000,
      });

    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(true);
  });

  it("rejects a request with HTML in any extra string field", async () => {
    const res = await request(app)
      .post("/simulate")
      .send({
        token_supply: 10_000_000,
        votes_yes: 6_000_000,
        votes_no: 1_000_000,
        votes_abstain: 500_000,
        quorum: 5_000_000,
        comment: "<iframe src=evil></iframe>",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("HTML tags");
  });
});
