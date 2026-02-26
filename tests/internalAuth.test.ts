import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

type EnvOverrides = Record<string, string | undefined>;

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function encodeSegment(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signToken(
  payload: Record<string, unknown>,
  secret = "0123456789abcdef0123456789abcdef",
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
) {
  const headerSegment = encodeSegment(header);
  const payloadSegment = encodeSegment(payload);
  const unsigned = `${headerSegment}.${payloadSegment}`;
  const signature = crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function defaultClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "svc-user",
    iss: "daily-news-agent.internal",
    aud: "daily-news-agent.business",
    jti: crypto.randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 600,
    scope: ["internal:business"],
    ...overrides,
  };
}

async function loadInternalAuth(overrides: EnvOverrides = {}) {
  restoreEnv();

  const defaultEnv: EnvOverrides = {
    INTERNAL_AUTH_ENABLED: "true",
    INTERNAL_AUTH_USERNAME: "svc-user",
    INTERNAL_AUTH_PASSWORD: "StrongPass!1",
    INTERNAL_AUTH_PASSWORD_HASH: "",
    INTERNAL_AUTH_JWT_SECRET: "0123456789abcdef0123456789abcdef",
    INTERNAL_AUTH_ISSUER: "daily-news-agent.internal",
    INTERNAL_AUTH_AUDIENCE: "daily-news-agent.business",
    INTERNAL_AUTH_TOKEN_TTL_SECONDS: "900",
    INTERNAL_AUTH_ALLOWED_CLOCK_SKEW_SECONDS: "30",
    INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
    INTERNAL_AUTH_RATE_LIMIT_MAX_ATTEMPTS: "5",
  };

  for (const [key, value] of Object.entries({ ...defaultEnv, ...overrides })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();

  const executeMock = vi.fn().mockResolvedValue(1);
  const queryMock = vi.fn().mockResolvedValue([]);
  const logInfoMock = vi.fn();

  vi.doMock("../src/db/client.js", () => ({
    prisma: {
      $executeRawUnsafe: executeMock,
      $queryRawUnsafe: queryMock,
    },
  }));

  vi.doMock("../src/utils/logger.js", () => ({
    logger: {
      info: logInfoMock,
    },
  }));

  const mod = await import("../src/services/internalAuth");

  return {
    mod,
    executeMock,
    queryMock,
    logInfoMock,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnv();
});

describe("internalAuth", () => {
  it("authenticates a valid user and issues a JWT", async () => {
    const { mod, executeMock, logInfoMock } = await loadInternalAuth();

    const result = await mod.authenticateInternalUser({
      username: "svc-user",
      password: "StrongPass!1",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    });

    expect(result.token).toContain(".");
    expect(result.tokenType).toBe("Bearer");
    expect(result.expiresIn).toBe(900);
    expect(executeMock).toHaveBeenCalled();

    const claims = mod.internalAuthTestKit.verifyJwt(result.token);
    expect(claims.sub).toBe("svc-user");
    expect(claims.iss).toBe("daily-news-agent.internal");
    expect(claims.aud).toBe("daily-news-agent.business");
    expect(logInfoMock).toHaveBeenCalled();
  });

  it("authorizes business access for an active token session", async () => {
    const { mod, queryMock } = await loadInternalAuth();
    const auth = await mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    queryMock.mockResolvedValueOnce([
      {
        username: "svc-user",
        token_active: 1,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);

    const claims = await mod.authorizeBusinessAccess(auth.token);
    expect(claims.sub).toBe("svc-user");
    expect(claims.scope).toContain("internal:business");
  });

  it("logs out an active token session", async () => {
    const { mod, queryMock, executeMock } = await loadInternalAuth();
    const auth = await mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    queryMock.mockResolvedValueOnce([
      {
        username: "svc-user",
        token_active: 1,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);

    const response = await mod.logoutInternalToken(auth.token, {
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    });

    expect(response.loggedOut).toBe(true);
    expect(
      executeMock.mock.calls.some((call) =>
        String(call[0]).includes("UPDATE internal_jwt_sessions") && String(call[0]).includes("WHERE jti = ?"),
      ),
    ).toBe(true);
  });

  it("uses default metadata values when logout metadata is omitted", async () => {
    const { mod, queryMock, logInfoMock } = await loadInternalAuth();
    const auth = await mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    queryMock.mockResolvedValueOnce([
      {
        username: "svc-user",
        token_active: 1,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);

    await mod.logoutInternalToken(auth.token);

    const logoutLog = logInfoMock.mock.calls.find((call) => call[0]?.event === "internal_auth_logout");
    expect(logoutLog?.[0]?.ipAddress).toBe("unknown");
    expect(logoutLog?.[0]?.userAgent).toBe("");
  });

  it("rejects malformed bearer headers", async () => {
    const { mod } = await loadInternalAuth();

    expect(() => mod.extractBearerToken(undefined)).toThrow("Unauthorized");
    expect(() => mod.extractBearerToken("Basic abc")).toThrow("Unauthorized");
    expect(() => mod.extractBearerToken("Bearer")).toThrow("Unauthorized");
    expect(() => mod.extractBearerToken("Bearer a b")).toThrow("Unauthorized");
  });

  it("extracts valid bearer tokens", async () => {
    const { mod } = await loadInternalAuth();
    expect(mod.extractBearerToken("Bearer token-123")).toBe("token-123");
    expect(mod.isInternalAuthEnabled()).toBe(true);
  });

  it("returns 404 when internal auth is disabled", async () => {
    const { mod } = await loadInternalAuth({ INTERNAL_AUTH_ENABLED: "false" });

    expect(mod.isInternalAuthEnabled()).toBe(false);
    await expect(mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("fails closed when secret is missing or too short", async () => {
    const { mod } = await loadInternalAuth({ INTERNAL_AUTH_JWT_SECRET: "short-secret" });

    await expect(mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" })).rejects.toMatchObject({
      statusCode: 500,
      code: "misconfigured",
    });
  });

  it("supports PBKDF2 password hashes", async () => {
    const iterations = 180_000;
    const salt = crypto.randomBytes(16);
    const hash = crypto.pbkdf2Sync("HashPass!1", salt, iterations, 32, "sha256");
    const encoded = `pbkdf2_sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;

    const { mod } = await loadInternalAuth({
      INTERNAL_AUTH_PASSWORD: undefined,
      INTERNAL_AUTH_PASSWORD_HASH: encoded,
    });

    const response = await mod.authenticateInternalUser({ username: "svc-user", password: "HashPass!1" });
    expect(response.token).toContain(".");

    const parsed = mod.internalAuthTestKit.parsePasswordHash(encoded);
    expect(parsed?.iterations).toBe(iterations);
  });

  it("parses and rejects malformed hash formats", async () => {
    const { mod } = await loadInternalAuth();

    expect(mod.internalAuthTestKit.parsePasswordHash("bad")).toBeNull();
    expect(mod.internalAuthTestKit.parsePasswordHash("argon2$100000$a$b")).toBeNull();
    expect(mod.internalAuthTestKit.parsePasswordHash("pbkdf2_sha256$100000$$")).toBeNull();
  });

  it("fails when password configuration is missing", async () => {
    const { mod } = await loadInternalAuth({
      INTERNAL_AUTH_PASSWORD: undefined,
      INTERNAL_AUTH_PASSWORD_HASH: undefined,
    });

    await expect(mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" })).rejects.toMatchObject({
      statusCode: 500,
      code: "misconfigured",
    });
  });

  it("fails when password hash format is invalid", async () => {
    const { mod } = await loadInternalAuth({
      INTERNAL_AUTH_PASSWORD: undefined,
      INTERNAL_AUTH_PASSWORD_HASH: "pbkdf2_sha256$50$bad$bad",
    });

    await expect(mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" })).rejects.toMatchObject({
      statusCode: 500,
      code: "misconfigured",
    });
  });

  it("rejects invalid credential payloads", async () => {
    const { mod } = await loadInternalAuth();

    await expect(mod.authenticateInternalUser({ username: "", password: "x" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("enforces auth attempt rate limiting", async () => {
    const { mod } = await loadInternalAuth({
      INTERNAL_AUTH_RATE_LIMIT_MAX_ATTEMPTS: "2",
      INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS: "60",
    });

    await expect(
      mod.authenticateInternalUser({ username: "svc-user", password: "wrong-1", ipAddress: "10.0.0.1" }),
    ).rejects.toMatchObject({ statusCode: 401 });

    await expect(
      mod.authenticateInternalUser({ username: "svc-user", password: "wrong-2", ipAddress: "10.0.0.1" }),
    ).rejects.toMatchObject({ statusCode: 401 });

    await expect(
      mod.authenticateInternalUser({ username: "svc-user", password: "wrong-3", ipAddress: "10.0.0.1" }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it("rejects tampered JWT signatures", async () => {
    const { mod } = await loadInternalAuth();
    const auth = await mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    const tampered = `${auth.token.slice(0, -1)}${auth.token.endsWith("a") ? "b" : "a"}`;
    await expect(mod.authorizeBusinessAccess(tampered)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects malformed JWT structures", async () => {
    const { mod } = await loadInternalAuth();

    expect(() => mod.internalAuthTestKit.verifyJwt("invalid")).toThrow("Unauthorized");
    expect(() => mod.internalAuthTestKit.verifyJwt("a..b")).toThrow("Unauthorized");
    expect(() => mod.internalAuthTestKit.verifyJwt("abc.$$$.def")).toThrow("Unauthorized");
  });

  it("rejects JWT headers and signatures that violate policy", async () => {
    const { mod } = await loadInternalAuth();
    const claims = defaultClaims();

    const wrongAlgToken = signToken(claims, undefined, { alg: "HS384", typ: "JWT" });
    expect(() => mod.internalAuthTestKit.verifyJwt(wrongAlgToken)).toThrow("Unauthorized");

    const wrongTypToken = signToken(claims, undefined, { alg: "HS256", typ: "NOT_JWT" });
    expect(() => mod.internalAuthTestKit.verifyJwt(wrongTypToken)).toThrow("Unauthorized");

    const valid = signToken(claims);
    const [h, p] = valid.split(".");
    expect(() => mod.internalAuthTestKit.verifyJwt(`${h}.${p}.AA`)).toThrow("Unauthorized");
  });

  it("enforces claim checks for issuer, audience, subject and time windows", async () => {
    const { mod } = await loadInternalAuth();
    const now = Math.floor(Date.now() / 1000);

    const issuerMismatch = signToken(defaultClaims({ iss: "wrong-issuer" }));
    expect(() => mod.internalAuthTestKit.verifyJwt(issuerMismatch)).toThrow("Unauthorized");

    const audienceMismatch = signToken(defaultClaims({ aud: "other-audience" }));
    expect(() => mod.internalAuthTestKit.verifyJwt(audienceMismatch)).toThrow("Unauthorized");

    const subjectMismatch = signToken(defaultClaims({ sub: "other-user" }));
    expect(() => mod.internalAuthTestKit.verifyJwt(subjectMismatch)).toThrow("Unauthorized");

    const nbfFuture = signToken(defaultClaims({ nbf: now + 3600 }));
    expect(() => mod.internalAuthTestKit.verifyJwt(nbfFuture)).toThrow("Unauthorized");

    const iatFuture = signToken(defaultClaims({ iat: now + 3600 }));
    expect(() => mod.internalAuthTestKit.verifyJwt(iatFuture)).toThrow("Unauthorized");

    const expPast = signToken(defaultClaims({ exp: now - 3600 }));
    expect(() => mod.internalAuthTestKit.verifyJwt(expPast)).toThrow("Unauthorized");
  });

  it("accepts array audiences when expected audience is present", async () => {
    const { mod } = await loadInternalAuth();
    const token = signToken(defaultClaims({ aud: ["daily-news-agent.business", "secondary-aud"] }));
    const claims = mod.internalAuthTestKit.verifyJwt(token);
    expect(Array.isArray(claims.aud)).toBe(true);
  });

  it("rejects missing token state in database", async () => {
    const { mod, queryMock } = await loadInternalAuth();
    const auth = await mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    queryMock.mockResolvedValueOnce([]);
    await expect(mod.authorizeBusinessAccess(auth.token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("revokes expired token state and denies access", async () => {
    const { mod, queryMock, executeMock } = await loadInternalAuth();
    const auth = await mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    queryMock.mockResolvedValueOnce([
      {
        username: "svc-user",
        token_active: 1,
        expires_at: 1,
      },
    ]);

    const before = executeMock.mock.calls.length;
    await expect(mod.authorizeBusinessAccess(auth.token)).rejects.toMatchObject({ statusCode: 401 });

    const followupCalls = executeMock.mock.calls.slice(before);
    expect(
      followupCalls.some((call) => String(call[0]).includes("SET token_active = 0") && String(call[0]).includes("WHERE jti = ?")),
    ).toBe(true);
  });

  it("rejects token state when username mismatch occurs", async () => {
    const { mod, queryMock } = await loadInternalAuth();
    const auth = await mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    queryMock.mockResolvedValueOnce([
      {
        username: "another-user",
        token_active: 1,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);

    await expect(mod.authorizeBusinessAccess(auth.token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects token state when session is inactive", async () => {
    const { mod, queryMock } = await loadInternalAuth();
    const auth = await mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    queryMock.mockResolvedValueOnce([
      {
        username: "svc-user",
        token_active: 0,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);

    await expect(mod.authorizeBusinessAccess(auth.token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects JWT claims when issuer does not match runtime policy", async () => {
    const first = await loadInternalAuth();
    const auth = await first.mod.authenticateInternalUser({ username: "svc-user", password: "StrongPass!1" });

    const second = await loadInternalAuth({ INTERNAL_AUTH_ISSUER: "other-issuer.internal" });
    await expect(second.mod.authorizeBusinessAccess(auth.token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("provides deterministic constant-time compare behavior", async () => {
    const { mod } = await loadInternalAuth();

    expect(mod.internalAuthTestKit.timingSafeEqualText("abc123", "abc123")).toBe(true);
    expect(mod.internalAuthTestKit.timingSafeEqualText("abc123", "abc124")).toBe(false);
    expect(mod.internalAuthTestKit.timingSafeEqualText("abc", "abcd")).toBe(false);
  });
});
