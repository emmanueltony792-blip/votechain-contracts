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

import express from "express";
import cors from "cors";
import helmet from "helmet";
import http from "http";
import { connectRedis, getRedis } from "./middleware/redisCache";
import { requestTracing } from "./middleware/requestTracing";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { rateLimit } from "./middleware/rateLimit";
import healthRoutes from "./routes/health";
import proposalRoutes from "./routes/proposals";
import apiKeysRoutes from "./routes/apiKeys";
import adminAuditLogRoutes from "./routes/adminAuditLog";
import {
  notFoundHandler,
  globalErrorHandler,
} from "./middleware/errorHandler";

// ---------------------------------------------------------------------------
// Environment variable validation
// ---------------------------------------------------------------------------

interface EnvConfig {
  PORT: string;
  REDIS_URL: string;
  ALLOWED_ORIGINS: string;
}

function validateEnv(): EnvConfig {
  const required: Array<keyof Pick<EnvConfig, "REDIS_URL">> = ["REDIS_URL"];
  const missing: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    console.error(
      "[startup] Missing required environment variables:\n" +
        missing.map((k) => `  • ${k}`).join("\n") +
        "\n\nSet these variables before starting the server. " +
        "See .env.example for reference."
    );
    process.exit(1);
  }

  return {
    PORT: process.env.PORT ?? "3001",
    REDIS_URL: process.env.REDIS_URL!,
    // Default to localhost dev origin; production sets this to the real domain.
    ALLOWED_ORIGINS:
      process.env.ALLOWED_ORIGINS ?? "http://localhost:5173",
  };
}

const env = validateEnv();

// ---------------------------------------------------------------------------
// CORS configuration (#32)
// ---------------------------------------------------------------------------

const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Allow requests with no origin (curl, server-to-server, health checks)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  exposedHeaders: ["X-Request-Id", "X-Cache", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "X-RateLimit-Tier"],
  credentials: true,
  // Tells browsers to cache the preflight response for 10 minutes
  maxAge: 600,
};

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

// Security headers — must come before routes
app.use(helmet());

// Handle preflight OPTIONS for all routes
app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

app.use(requestTracing);
app.use(metricsMiddleware);
app.use(express.json());

// Health, readiness and metrics — mounted BEFORE rate-limiting and auth so
// load balancers, orchestrators and Prometheus can always reach them without
// credentials.
app.get("/metrics", metricsHandler);
app.use("/", healthRoutes);

// ── API key authentication & tiered rate limiting ──────────────────────────
//
// Order matters:
//   1. apiKeyAuth   — resolves the Bearer token, sets req.apiKeyTier
//   2. rateLimit    — uses req.apiKeyTier to select the correct window
//
// Both are async middleware applied to all /api routes.  Health routes are
// intentionally excluded (mounted above, before this block).
app.use("/api", apiKeyAuth);
app.use("/api", rateLimit);

// ── Routes ─────────────────────────────────────────────────────────────────
app.use("/api", proposalRoutes);
app.use("/api", apiKeysRoutes);
app.use("/api", adminAuditLogRoutes);

// Catch unmatched routes — must come after all real route registrations.
app.use(notFoundHandler);

// Global error handler — must be the very last middleware registered.
app.use(globalErrorHandler);

const PORT = parseInt(env.PORT, 10);

// ---------------------------------------------------------------------------
// Graceful shutdown (#231)
// ---------------------------------------------------------------------------

/**
 * How long (ms) to wait for in-flight requests to drain before forcing exit.
 * Kubernetes default termination grace period is 30 s; we match it.
 */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Registers SIGTERM / SIGINT handlers that:
 *   1. Stop the HTTP server accepting new connections.
 *   2. Wait up to SHUTDOWN_TIMEOUT_MS for in-flight requests to finish.
 *   3. Close the Redis connection cleanly.
 *   4. Log the drain count and exit.
 *
 * Any error during shutdown is logged but does not prevent process exit so
 * the container is always released by the orchestrator.
 */
function registerGracefulShutdown(server: http.Server): void {
  let inflightRequests = 0;

  // Track in-flight HTTP requests so we can report the drain count.
  server.on("request", (_req, res) => {
    inflightRequests++;
    res.on("finish", () => {
      inflightRequests--;
    });
  });

  async function shutdown(signal: string): Promise<void> {
    console.log(`[shutdown] received ${signal} — stopping server`);

    // Stop accepting new connections immediately.
    server.close(async (err) => {
      if (err) {
        console.error("[shutdown] server.close error:", err);
      }
    });

    // Give in-flight requests up to SHUTDOWN_TIMEOUT_MS to complete.
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (inflightRequests > 0 && Date.now() < deadline) {
      console.log(
        `[shutdown] waiting for ${inflightRequests} in-flight request(s)…`
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (inflightRequests > 0) {
      console.warn(
        `[shutdown] timeout reached — ${inflightRequests} request(s) still in flight; forcing exit`
      );
    } else {
      console.log("[shutdown] all in-flight requests drained");
    }

    // Close Redis cleanly so connection-pool resources are released.
    const redisClient = getRedis();
    if (redisClient?.isOpen) {
      try {
        await redisClient.quit();
        console.log("[shutdown] redis connection closed");
      } catch (redisErr) {
        console.error("[shutdown] redis quit error:", redisErr);
      }
    }

    console.log(
      `[shutdown] complete — drained ${inflightRequests === 0 ? "all" : "partial"} requests`
    );
    process.exit(inflightRequests > 0 ? 1 : 0);
  }

  process.once("SIGTERM", () => shutdown("SIGTERM").catch(console.error));
  process.once("SIGINT",  () => shutdown("SIGINT").catch(console.error));
}

// connectRedis now degrades gracefully on failure (#38) — the server always
// starts regardless of whether Redis is reachable.
connectRedis(env.REDIS_URL).then(() => {
  const server = http.createServer(app);
  registerGracefulShutdown(server);
  server.listen(PORT, () =>
    console.log(`[server] listening on :${PORT}`)
  );
});

export default app;
