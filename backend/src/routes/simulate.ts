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
 * Simulation route — stateless, no authentication required.
 *
 * POST /simulate
 *
 * Evaluates the on-chain pass condition for a given set of hypothetical vote
 * counts and returns a structured outcome.  No data is persisted; this is
 * purely a calculation endpoint useful for frontend UX previews and tooling.
 *
 * Pass condition (mirrors contracts/governance/src/lib.rs):
 *   total_votes = votes_yes + votes_no + votes_abstain
 *   passed      = total_votes >= quorum  AND  votes_yes > votes_no
 *
 * Rate limit: 1000 requests per hour per IP (via simulateRateLimit middleware).
 *
 * Issue #111
 */

import { Router, Request, Response } from "express";
import { getRedis } from "../middleware/redisCache";

const router = Router();

// ---------------------------------------------------------------------------
// Per-IP rate limiter — 1000 requests per hour (3600 s window).
// Falls back to pass-through when Redis is unavailable so the endpoint
// remains operational in local / test environments without Redis.
// ---------------------------------------------------------------------------

const SIMULATE_WINDOW_SECONDS = 3600; // 1 hour
const SIMULATE_LIMIT = 1000; // requests per window

/**
 * Rate-limit middleware scoped to the /simulate route.
 *
 * Uses the same Redis-backed sliding counter pattern as the global rateLimit
 * middleware, but with a 1-hour window and a limit of 1000 requests per IP.
 */
async function simulateRateLimit(
  req: Request,
  res: Response,
  next: () => void,
): Promise<void> {
  const reset = Math.ceil(Date.now() / 1000) + SIMULATE_WINDOW_SECONDS;
  res.setHeader("X-RateLimit-Limit", SIMULATE_LIMIT);
  res.setHeader("X-RateLimit-Reset", reset);

  const redis = getRedis();
  if (!redis?.isOpen) {
    // Redis unavailable — degrade gracefully, allow the request through.
    res.setHeader("X-RateLimit-Remaining", SIMULATE_LIMIT);
    next();
    return;
  }

  const key = `rate-limit:simulate:${req.ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, SIMULATE_WINDOW_SECONDS);
    const remaining = Math.max(0, SIMULATE_LIMIT - count);
    res.setHeader("X-RateLimit-Remaining", remaining);
    if (count > SIMULATE_LIMIT) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }
  } catch {
    // Redis error — degrade gracefully.
    res.setHeader("X-RateLimit-Remaining", SIMULATE_LIMIT);
  }

  next();
}

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

/** Expected JSON request body for POST /simulate. */
interface SimulateRequest {
  token_supply: number;
  votes_yes: number;
  votes_no: number;
  votes_abstain: number;
  quorum: number;
}

/**
 * Structured outcome returned by POST /simulate.
 *
 * @property passed       - Whether the proposal would pass under the given inputs.
 * @property total_votes  - Sum of yes + no + abstain votes.
 * @property quorum_met   - Whether total_votes >= quorum.
 * @property majority_met - Whether votes_yes > votes_no.
 * @property margin       - Difference between yes and no votes (signed).
 */
interface SimulateResponse {
  passed: boolean;
  total_votes: number;
  quorum_met: boolean;
  majority_met: boolean;
  margin: number;
}

// ---------------------------------------------------------------------------
// HTML tag validation (issue #320)
// ---------------------------------------------------------------------------

/**
 * Regex matching common HTML tag patterns.
 *
 * Matches `<tag>`, `<tag attr="value">`, `</tag>`, `<!-- comment -->`,
 * and self-closing `<tag/>`.
 */
const HTML_TAG_RE = /<\s*\/?\s*[a-zA-Z][^>]*>/;

/**
 * Returns true when `value` is a finite, non-negative number.
 * Rejects NaN, Infinity, and negative values.
 */
function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validates that a string value does not contain HTML tags.
 * Issue #320: the simulate endpoint must reject requests containing
 * HTML in any string field to prevent stored XSS via the API.
 *
 * @returns An error message if HTML tags are detected, or null if clean.
 */
function containsHtmlTags(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return HTML_TAG_RE.test(value);
}

/**
 * Validates and parses the POST /simulate request body.
 *
 * Issue #320: also rejects requests containing HTML tags in any string
 * field to prevent stored XSS via the API.
 *
 * @returns Parsed fields or a human-readable error message string.
 */
function parseBody(body: unknown): SimulateRequest | string {
  if (typeof body !== "object" || body === null) {
    return "Request body must be a JSON object";
  }

  const b = body as Record<string, unknown>;
  const fields: Array<keyof SimulateRequest> = [
    "token_supply",
    "votes_yes",
    "votes_no",
    "votes_abstain",
    "quorum",
  ];

  for (const field of fields) {
    if (!isNonNegativeFinite(b[field])) {
      return `Field '${field}' must be a non-negative finite number`;
    }
  }

  // Issue #320: reject HTML tags in any string field to prevent stored XSS.
  for (const [key, val] of Object.entries(b)) {
    if (typeof val === "string" && containsHtmlTags(val)) {
      return `Field '${key}' contains HTML tags, which are not allowed`;
    }
  }

  const parsed = b as unknown as SimulateRequest;

  if (parsed.quorum > parsed.token_supply) {
    return `'quorum' (${parsed.quorum}) must not exceed 'token_supply' (${parsed.token_supply})`;
  }

  return parsed;
}

/**
 * Applies the on-chain pass condition (mirrors contracts/governance/src/lib.rs).
 *
 *   total_votes = votes_yes + votes_no + votes_abstain
 *   quorum_met  = total_votes >= quorum
 *   majority_met = votes_yes > votes_no
 *   passed      = quorum_met AND majority_met
 *
 * @param req - Validated simulation parameters.
 * @returns Structured outcome object.
 */
function evaluate(req: SimulateRequest): SimulateResponse {
  const total_votes = req.votes_yes + req.votes_no + req.votes_abstain;
  const quorum_met = total_votes >= req.quorum;
  const majority_met = req.votes_yes > req.votes_no;
  const passed = quorum_met && majority_met;
  const margin = req.votes_yes - req.votes_no;

  return { passed, total_votes, quorum_met, majority_met, margin };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /simulate
 *
 * Stateless proposal simulation endpoint.  Accepts hypothetical vote counts
 * and a quorum threshold, then returns whether the proposal would pass.
 *
 * No authentication required.  Rate limited to 1000 req/hour per IP.
 *
 * @example
 * // Request
 * POST /simulate
 * Content-Type: application/json
 * {
 *   "token_supply": 10000000,
 *   "votes_yes":    6000000,
 *   "votes_no":     1000000,
 *   "votes_abstain": 500000,
 *   "quorum":       5000000
 * }
 *
 * // Response 200
 * {
 *   "passed": true,
 *   "total_votes": 7500000,
 *   "quorum_met": true,
 *   "majority_met": true,
 *   "margin": 5000000
 * }
 */
router.post("/simulate", simulateRateLimit, (req: Request, res: Response) => {
  const parsed = parseBody(req.body);

  if (typeof parsed === "string") {
    return res.status(400).json({ error: parsed });
  }

  const result = evaluate(parsed);
  return res.status(200).json(result);
});

export default router;
