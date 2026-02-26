import { afterEach, describe, expect, it, vi } from "vitest";

type EnvOverrides = Record<string, string | undefined>;

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function createMockResponse() {
  let finishHandler: (() => void) | undefined;
  const headers: Record<string, string> = {};

  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      finishHandler?.();
      return this;
    },
    end() {
      finishHandler?.();
      return this;
    },
    once(event: string, callback: () => void) {
      if (event === "finish") {
        finishHandler = callback;
      }
      return this;
    },
    triggerFinish() {
      finishHandler?.();
    },
  };

  return reply;
}

async function loadGateway(overrides: EnvOverrides = {}) {
  restoreEnv();

  const defaults: EnvOverrides = {
    KEYCLOAK_ENABLED: "true",
    KEYCLOAK_BASE_URL: "http://localhost:8080",
    KEYCLOAK_REALM: "master",
    KEYCLOAK_CLIENT_ID: "daily-news-agent",
    KEYCLOAK_AUDIENCE: "daily-news-agent",
    KEYCLOAK_SCOPE: "openid profile email",
    KEYCLOAK_ISSUER_URL: "",
    KEYCLOAK_CLOCK_SKEW_SECONDS: "30",
    KEYCLOAK_JWKS_CACHE_SECONDS: "300",
    KEYCLOAK_ADMIN_ROLES_CSV: "admin,super-admin",
    KEYCLOAK_OPERATOR_ROLES_CSV: "operator,admin,super-admin",
    KEYCLOAK_EDITOR_ROLES_CSV: "editor,operator,admin,super-admin",
    KEYCLOAK_ANALYST_ROLES_CSV: "viewer,analyst,editor,operator,admin,super-admin",
  };

  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();

  const jwtVerifyMock = vi.fn();
  const createRemoteJWKSetMock = vi.fn(() => Symbol("jwks"));
  const logInfoMock = vi.fn();

  vi.doMock("jose", () => ({
    jwtVerify: jwtVerifyMock,
    createRemoteJWKSet: createRemoteJWKSetMock,
  }));

  vi.doMock("../src/utils/logger.js", () => ({
    logger: {
      info: logInfoMock,
    },
  }));

  const mod = await import("../src/services/keycloakGateway");

  return {
    mod,
    jwtVerifyMock,
    createRemoteJWKSetMock,
    logInfoMock,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnv();
});

describe("keycloakGateway", () => {
  it("exposes public auth config", async () => {
    const { mod } = await loadGateway();
    const config = mod.gatewayPublicAuthConfig();

    expect(config.provider).toBe("keycloak");
    expect(config.enabled).toBe(true);
    expect(config.authorizationEndpoint).toContain("/protocol/openid-connect/auth");
    expect(config.pkceMethod).toBe("S256");
  });

  it("exposes policy catalog and resolves expected policies", async () => {
    const { mod } = await loadGateway();

    const catalog = mod.gatewayPolicyCatalog();
    expect(catalog.length).toBeGreaterThan(5);
    expect(catalog.some((policy) => policy.id === "sources.read")).toBe(true);

    const policy = mod.gatewayTestKit.resolvePolicy("GET", "/sources");
    expect(policy?.id).toBe("sources.read");
    expect(mod.gatewayTestKit.normalizePath("/sources/")).toBe("/sources");
  });

  it("extracts merged roles from token payload", async () => {
    const { mod } = await loadGateway();

    const roles = mod.gatewayTestKit.collectTokenRoles({
      realm_access: { roles: ["admin", "editor"] },
      resource_access: {
        "daily-news-agent": { roles: ["operator", "editor"] },
      },
    } as any);

    expect(roles.realmRoles).toEqual(["admin", "editor"]);
    expect(roles.clientRoles).toEqual(["operator", "editor"]);
    expect(roles.roles).toEqual(["admin", "editor", "operator"]);
  });

  it("bypasses auth checks when keycloak is disabled", async () => {
    const { mod } = await loadGateway({ KEYCLOAK_ENABLED: "false" });
    const middleware = mod.createGatewayMiddleware();

    const request: any = {
      method: "GET",
      path: "/sources",
      originalUrl: "/sources",
      headers: {},
    };
    const reply = createMockResponse();
    const next = vi.fn(() => reply.triggerFinish());

    await middleware(request, reply as any, next as any);

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.gatewayContext?.authenticated).toBe(false);
    expect(request.gatewayContext?.policyId).toBe("sources.read");
    expect(reply.headers["X-Request-Id"]).toBeTruthy();
  });

  it("allows public policies when keycloak is enabled", async () => {
    const { mod } = await loadGateway();
    const middleware = mod.createGatewayMiddleware();

    const request: any = {
      method: "GET",
      path: "/health",
      originalUrl: "/health",
      headers: {},
    };
    const reply = createMockResponse();
    const next = vi.fn(() => reply.triggerFinish());

    await middleware(request, reply as any, next as any);

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.gatewayContext?.policyId).toBe("public.health");
  });

  it("handles CORS preflight directly", async () => {
    const { mod } = await loadGateway();
    const middleware = mod.createGatewayMiddleware();

    const request: any = {
      method: "OPTIONS",
      path: "/sources",
      originalUrl: "/sources",
      headers: {},
    };
    const reply = createMockResponse();
    const next = vi.fn();

    await middleware(request, reply as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(204);
  });

  it("returns 403 when no policy matches", async () => {
    const { mod } = await loadGateway();
    const middleware = mod.createGatewayMiddleware();

    const request: any = {
      method: "GET",
      path: "/unknown-path",
      originalUrl: "/unknown-path",
      headers: {},
    };
    const reply = createMockResponse();
    const next = vi.fn();

    await middleware(request, reply as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({ detail: "Forbidden" });
  });

  it("returns 401 for protected routes without bearer token", async () => {
    const { mod } = await loadGateway();
    const middleware = mod.createGatewayMiddleware();

    const request: any = {
      method: "GET",
      path: "/stats",
      originalUrl: "/stats",
      headers: {},
    };
    const reply = createMockResponse();
    const next = vi.fn();

    await middleware(request, reply as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ detail: "Unauthorized" });
  });

  it("returns 401 for invalid token verification", async () => {
    const { mod, jwtVerifyMock } = await loadGateway();
    jwtVerifyMock.mockRejectedValueOnce(new Error("signature invalid"));

    const middleware = mod.createGatewayMiddleware();
    const request: any = {
      method: "GET",
      path: "/stats",
      originalUrl: "/stats",
      headers: { authorization: "Bearer bad-token" },
    };
    const reply = createMockResponse();
    const next = vi.fn();

    await middleware(request, reply as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(401);
  });

  it("returns 403 when token roles do not satisfy route policy", async () => {
    const { mod, jwtVerifyMock } = await loadGateway();
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "user-1",
        iss: "http://localhost:8080/realms/master",
        aud: "daily-news-agent",
        realm_access: { roles: ["viewer"] },
      },
    });

    const middleware = mod.createGatewayMiddleware();
    const request: any = {
      method: "GET",
      path: "/aaa/policies",
      originalUrl: "/aaa/policies",
      headers: { authorization: "Bearer ok-token" },
    };
    const reply = createMockResponse();
    const next = vi.fn();

    await middleware(request, reply as any, next as any);

    expect(next).not.toHaveBeenCalled();
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({ detail: "Forbidden" });
  });

  it("allows access and populates principal context when role is sufficient", async () => {
    const { mod, jwtVerifyMock, createRemoteJWKSetMock } = await loadGateway();
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "user-1",
        preferred_username: "alice",
        email: "alice@example.com",
        iss: "http://localhost:8080/realms/master",
        aud: ["daily-news-agent"],
        jti: "token-id-1",
        exp: Math.floor(Date.now() / 1000) + 300,
        realm_access: { roles: ["admin"] },
        resource_access: {
          "daily-news-agent": { roles: ["editor"] },
        },
      },
    });

    const middleware = mod.createGatewayMiddleware();
    const request: any = {
      method: "GET",
      path: "/aaa/policies",
      originalUrl: "/aaa/policies",
      headers: { authorization: "Bearer good-token" },
    };
    const reply = createMockResponse();
    const next = vi.fn(() => reply.triggerFinish());

    await middleware(request, reply as any, next as any);

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.gatewayContext?.authenticated).toBe(true);
    expect(request.gatewayContext?.principal?.username).toBe("alice");
    expect(request.gatewayContext?.principal?.roles).toContain("admin");
    expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
    expect(jwtVerifyMock).toHaveBeenCalled();
    const verifyOptions = jwtVerifyMock.mock.calls[0][2] as any;
    expect(verifyOptions.audience).toBe("daily-news-agent");
  });

  it("falls back audience to client id when KEYCLOAK_AUDIENCE is unset", async () => {
    const { mod, jwtVerifyMock } = await loadGateway({ KEYCLOAK_AUDIENCE: undefined });
    jwtVerifyMock.mockResolvedValueOnce({
      payload: {
        sub: "user-2",
        iss: "http://localhost:8080/realms/master",
        aud: "daily-news-agent",
        realm_access: { roles: ["viewer"] },
      },
    });

    const middleware = mod.createGatewayMiddleware();
    const request: any = {
      method: "GET",
      path: "/stats",
      originalUrl: "/stats",
      headers: { authorization: "Bearer some-token" },
    };
    const reply = createMockResponse();
    const next = vi.fn(() => reply.triggerFinish());

    await middleware(request, reply as any, next as any);

    expect(next).toHaveBeenCalledTimes(1);
    const verifyOptions = jwtVerifyMock.mock.calls[0][2] as any;
    expect(verifyOptions.audience).toBe("daily-news-agent");
  });

  it("caches remote JWK set across multiple protected requests", async () => {
    const { mod, jwtVerifyMock, createRemoteJWKSetMock } = await loadGateway();
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: "user-3",
        iss: "http://localhost:8080/realms/master",
        aud: "daily-news-agent",
        realm_access: { roles: ["viewer"] },
      },
    });

    const middleware = mod.createGatewayMiddleware();

    for (let i = 0; i < 2; i += 1) {
      const request: any = {
        method: "GET",
        path: "/stats",
        originalUrl: "/stats",
        headers: { authorization: "Bearer token" },
      };
      const reply = createMockResponse();
      const next = vi.fn(() => reply.triggerFinish());
      await middleware(request, reply as any, next as any);
      expect(next).toHaveBeenCalledTimes(1);
    }

    expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
  });
});
