import crypto from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../db/client.js";
import { logger } from "../utils/logger.js";

type AuthErrorCode =
  | "auth_disabled"
  | "misconfigured"
  | "invalid_request"
  | "invalid_credentials"
  | "invalid_token"
  | "rate_limited";

type AuthErrorOptions = {
  retryAfterSeconds?: number;
};

export class InternalAuthError extends Error {
  statusCode: number;
  code: AuthErrorCode;
  retryAfterSeconds?: number;

  constructor(statusCode: number, code: AuthErrorCode, message: string, options?: AuthErrorOptions) {
    super(message);
    this.name = "InternalAuthError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

type AuthenticateRequest = {
  username: unknown;
  password: unknown;
  ipAddress?: string;
  userAgent?: string;
};

type ValidatedJwtClaims = {
  sub: string;
  iss: string;
  aud: string | string[];
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  scope: string[];
};

type RateLimitEntry = {
  count: number;
  resetAtMs: number;
};

const loginSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
});

const jwtHeaderSchema = z.object({
  alg: z.literal("HS256"),
  typ: z.string().optional(),
});

const jwtClaimsSchema = z.object({
  sub: z.string().trim().min(1).max(128),
  iss: z.string().trim().min(1).max(256),
  aud: z.union([z.string().trim().min(1).max(256), z.array(z.string().trim().min(1).max(256)).min(1).max(16)]),
  jti: z.string().uuid(),
  iat: z.number().int().positive(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  scope: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
});

const loginRateLimit = new Map<string, RateLimitEntry>();

const TOKEN_TABLE_NAME = "internal_jwt_sessions";
const TOKEN_SCOPE = ["internal:business"];

let tableInitPromise: Promise<void> | null = null;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function toBase64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function fromBase64UrlJson(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Malformed JWT segment");
  }
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function timingSafeEqualText(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireEnabled() {
  if (!env.INTERNAL_AUTH_ENABLED) {
    throw new InternalAuthError(404, "auth_disabled", "Not found");
  }
}

function getJwtSecret() {
  const secret = env.INTERNAL_AUTH_JWT_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new InternalAuthError(
      500,
      "misconfigured",
      "Internal authentication is not configured",
    );
  }
  return Buffer.from(secret, "utf8");
}

function parsePasswordHash(input: string) {
  const parts = input.split("$");
  if (parts.length !== 4) return null;
  if (parts[0] !== "pbkdf2_sha256") return null;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 5_000_000) return null;

  let salt: Buffer;
  let expectedHash: Buffer;
  try {
    salt = Buffer.from(parts[2], "base64url");
    expectedHash = Buffer.from(parts[3], "base64url");
  } catch {
    return null;
  }

  if (!salt.length || !expectedHash.length) return null;

  return {
    iterations,
    salt,
    expectedHash,
  };
}

function verifyPassword(candidatePassword: string) {
  const configuredHash = env.INTERNAL_AUTH_PASSWORD_HASH?.trim();
  if (configuredHash) {
    const parsedHash = parsePasswordHash(configuredHash);
    if (!parsedHash) {
      throw new InternalAuthError(
        500,
        "misconfigured",
        "Internal authentication is not configured",
      );
    }

    const actualHash = crypto.pbkdf2Sync(
      candidatePassword,
      parsedHash.salt,
      parsedHash.iterations,
      parsedHash.expectedHash.length,
      "sha256",
    );
    if (actualHash.length !== parsedHash.expectedHash.length) return false;
    return crypto.timingSafeEqual(actualHash, parsedHash.expectedHash);
  }

  const configuredPassword = env.INTERNAL_AUTH_PASSWORD;
  if (!configuredPassword) {
    throw new InternalAuthError(
      500,
      "misconfigured",
      "Internal authentication is not configured",
    );
  }

  return timingSafeEqualText(candidatePassword, configuredPassword);
}

function signJwt(claims: ValidatedJwtClaims) {
  const secret = getJwtSecret();
  const headerSegment = toBase64UrlJson({ alg: "HS256", typ: "JWT" });
  const payloadSegment = toBase64UrlJson(claims);
  const unsignedToken = `${headerSegment}.${payloadSegment}`;
  const signatureSegment = crypto.createHmac("sha256", secret).update(unsignedToken).digest("base64url");
  return `${unsignedToken}.${signatureSegment}`;
}

function pruneRateLimitMap(nowMs: number) {
  for (const [key, value] of loginRateLimit.entries()) {
    if (value.resetAtMs <= nowMs) {
      loginRateLimit.delete(key);
    }
  }
}

function assertWithinRateLimit(ipAddress: string) {
  const nowMs = Date.now();
  pruneRateLimitMap(nowMs);

  const key = ipAddress || "unknown";
  const existing = loginRateLimit.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    loginRateLimit.set(key, {
      count: 0,
      resetAtMs: nowMs + env.INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
    });
    return;
  }

  if (existing.count >= env.INTERNAL_AUTH_RATE_LIMIT_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
    throw new InternalAuthError(429, "rate_limited", "Too many authentication attempts", { retryAfterSeconds });
  }
}

function registerFailedAttempt(ipAddress: string) {
  const key = ipAddress || "unknown";
  const nowMs = Date.now();
  const existing = loginRateLimit.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    loginRateLimit.set(key, {
      count: 1,
      resetAtMs: nowMs + env.INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
    });
    return;
  }
  existing.count += 1;
  loginRateLimit.set(key, existing);
}

function clearFailedAttempts(ipAddress: string) {
  const key = ipAddress || "unknown";
  loginRateLimit.delete(key);
}

async function ensureTokenTable() {
  if (!tableInitPromise) {
    tableInitPromise = (async () => {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${TOKEN_TABLE_NAME} (
          jti TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          token_active INTEGER NOT NULL DEFAULT 1 CHECK(token_active IN (0, 1)),
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_${TOKEN_TABLE_NAME}_username_active
          ON ${TOKEN_TABLE_NAME}(username, token_active)`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS idx_${TOKEN_TABLE_NAME}_expires_at
          ON ${TOKEN_TABLE_NAME}(expires_at)`,
      );
    })().catch((error) => {
      tableInitPromise = null;
      throw error;
    });
  }

  await tableInitPromise;
}

async function cleanupExpiredTokens(currentSeconds: number) {
  const cutoff = currentSeconds - 24 * 60 * 60;
  await prisma.$executeRawUnsafe(
    `DELETE FROM ${TOKEN_TABLE_NAME}
      WHERE expires_at <= ? AND token_active = 0`,
    cutoff,
  );
}

function validateJwtClaims(payloadRaw: unknown, currentSeconds: number) {
  let claims: z.infer<typeof jwtClaimsSchema>;
  try {
    claims = jwtClaimsSchema.parse(payloadRaw);
  } catch {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  const allowedClockSkew = env.INTERNAL_AUTH_ALLOWED_CLOCK_SKEW_SECONDS;
  if (claims.iss !== env.INTERNAL_AUTH_ISSUER) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(env.INTERNAL_AUTH_AUDIENCE)) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (!timingSafeEqualText(claims.sub, env.INTERNAL_AUTH_USERNAME)) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (claims.nbf > currentSeconds + allowedClockSkew) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (claims.iat > currentSeconds + allowedClockSkew) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (claims.exp <= currentSeconds - allowedClockSkew) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  return {
    ...claims,
    scope: claims.scope ?? TOKEN_SCOPE,
  } as ValidatedJwtClaims;
}

function verifyJwt(token: string) {
  const secret = getJwtSecret();
  const pieces = token.split(".");
  if (pieces.length !== 3) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  const [headerSegment, payloadSegment, signatureSegment] = pieces;
  if (!headerSegment || !payloadSegment || !signatureSegment) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  let headerRaw: unknown;
  let payloadRaw: unknown;
  try {
    headerRaw = fromBase64UrlJson(headerSegment);
    payloadRaw = fromBase64UrlJson(payloadSegment);
  } catch {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  let header: z.infer<typeof jwtHeaderSchema>;
  try {
    header = jwtHeaderSchema.parse(headerRaw);
  } catch {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (header.typ && header.typ !== "JWT") {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signatureSegment, "base64url");
  } catch {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();

  if (providedSignature.length !== expectedSignature.length) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (!crypto.timingSafeEqual(providedSignature, expectedSignature)) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  return validateJwtClaims(payloadRaw, nowSeconds());
}

async function validateTokenState(claims: ValidatedJwtClaims) {
  await ensureTokenTable();

  const currentSeconds = nowSeconds();
  const rows = await prisma.$queryRawUnsafe<Array<{ username: string; token_active: number; expires_at: number }>>(
    `SELECT username, token_active, expires_at
      FROM ${TOKEN_TABLE_NAME}
      WHERE jti = ?
      LIMIT 1`,
    claims.jti,
  );

  const row = rows[0];
  if (!row) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (row.token_active !== 1) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (!timingSafeEqualText(row.username, claims.sub)) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  if (row.expires_at <= currentSeconds) {
    await prisma.$executeRawUnsafe(
      `UPDATE ${TOKEN_TABLE_NAME}
        SET token_active = 0,
            revoked_at = COALESCE(revoked_at, ?),
            updated_at = ?
        WHERE jti = ?`,
      currentSeconds,
      currentSeconds,
      claims.jti,
    );
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }
}

export function extractBearerToken(authorizationHeader: string | undefined) {
  if (!authorizationHeader) {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/);
  if (!scheme || !token || rest.length > 0 || scheme.toLowerCase() !== "bearer") {
    throw new InternalAuthError(401, "invalid_token", "Unauthorized");
  }

  return token;
}

export async function authenticateInternalUser(input: AuthenticateRequest) {
  requireEnabled();
  await ensureTokenTable();

  const ipAddress = String(input.ipAddress ?? "unknown").slice(0, 64);
  assertWithinRateLimit(ipAddress);

  let payload: z.infer<typeof loginSchema>;
  try {
    payload = loginSchema.parse({ username: input.username, password: input.password });
  } catch {
    registerFailedAttempt(ipAddress);
    throw new InternalAuthError(400, "invalid_request", "Invalid credentials payload");
  }

  const usernameMatches = timingSafeEqualText(payload.username, env.INTERNAL_AUTH_USERNAME);
  const passwordMatches = verifyPassword(payload.password);

  if (!usernameMatches || !passwordMatches) {
    registerFailedAttempt(ipAddress);
    throw new InternalAuthError(401, "invalid_credentials", "Unauthorized");
  }

  clearFailedAttempts(ipAddress);

  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + env.INTERNAL_AUTH_TOKEN_TTL_SECONDS;
  const jti = crypto.randomUUID();

  const claims: ValidatedJwtClaims = {
    sub: env.INTERNAL_AUTH_USERNAME,
    iss: env.INTERNAL_AUTH_ISSUER,
    aud: env.INTERNAL_AUTH_AUDIENCE,
    jti,
    iat: issuedAt,
    nbf: issuedAt,
    exp: expiresAt,
    scope: TOKEN_SCOPE,
  };

  const token = signJwt(claims);

  await cleanupExpiredTokens(issuedAt);
  await prisma.$executeRawUnsafe(
    `UPDATE ${TOKEN_TABLE_NAME}
      SET token_active = 0,
          revoked_at = COALESCE(revoked_at, ?),
          updated_at = ?
      WHERE username = ? AND token_active = 1`,
    issuedAt,
    issuedAt,
    env.INTERNAL_AUTH_USERNAME,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TOKEN_TABLE_NAME}
      (jti, username, token_active, issued_at, expires_at, revoked_at, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, NULL, ?, ?)`,
    jti,
    env.INTERNAL_AUTH_USERNAME,
    issuedAt,
    expiresAt,
    issuedAt,
    issuedAt,
  );

  logger.info(
    {
      event: "internal_auth_authenticated",
      ipAddress,
      userAgent: String(input.userAgent ?? "").slice(0, 256),
      username: env.INTERNAL_AUTH_USERNAME,
      jti,
    },
    "internal_auth_event",
  );

  return {
    token,
    tokenType: "Bearer",
    expiresIn: env.INTERNAL_AUTH_TOKEN_TTL_SECONDS,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export async function logoutInternalToken(token: string, metadata?: { ipAddress?: string; userAgent?: string }) {
  requireEnabled();
  await ensureTokenTable();

  const claims = verifyJwt(token);
  await validateTokenState(claims);

  const revokedAt = nowSeconds();
  await prisma.$executeRawUnsafe(
    `UPDATE ${TOKEN_TABLE_NAME}
      SET token_active = 0,
          revoked_at = COALESCE(revoked_at, ?),
          updated_at = ?
      WHERE jti = ?`,
    revokedAt,
    revokedAt,
    claims.jti,
  );

  logger.info(
    {
      event: "internal_auth_logout",
      ipAddress: String(metadata?.ipAddress ?? "unknown").slice(0, 64),
      userAgent: String(metadata?.userAgent ?? "").slice(0, 256),
      jti: claims.jti,
    },
    "internal_auth_event",
  );

  return {
    loggedOut: true,
  };
}

export async function authorizeBusinessAccess(token: string) {
  requireEnabled();
  const claims = verifyJwt(token);
  await validateTokenState(claims);
  return claims;
}

export function isInternalAuthEnabled() {
  return env.INTERNAL_AUTH_ENABLED;
}

export const internalAuthTestKit = {
  parsePasswordHash,
  timingSafeEqualText,
  verifyJwt,
};
