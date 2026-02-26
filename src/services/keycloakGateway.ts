import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

type RoutePolicy = {
  id: string;
  description: string;
  methods: string[];
  pathRegex: RegExp;
  allowPublic?: boolean;
  anyRoles?: string[];
};

export type GatewayPrincipal = {
  subject: string;
  username: string | null;
  email: string | null;
  issuer: string;
  audience: string[];
  roles: string[];
  realmRoles: string[];
  clientRoles: string[];
  tokenId: string | null;
  expiresAt: string | null;
};

export type GatewayRequestContext = {
  requestId: string;
  policyId: string;
  authenticated: boolean;
  principal: GatewayPrincipal | null;
};

type AccountingDecision = "allow" | "deny" | "bypass";

class GatewayAuthError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "GatewayAuthError";
    this.statusCode = statusCode;
  }
}

const REQUEST_ID_HEADER = "X-Request-Id";

const ACCEPTED_JWT_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function parseCsv(input: string) {
  return input
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function keycloakIssuer() {
  if (env.KEYCLOAK_ISSUER_URL?.trim()) {
    return env.KEYCLOAK_ISSUER_URL.trim().replace(/\/$/, "");
  }
  return `${env.KEYCLOAK_BASE_URL.replace(/\/$/, "")}/realms/${encodeURIComponent(env.KEYCLOAK_REALM)}`;
}

function keycloakEndpoints() {
  const issuer = keycloakIssuer();
  return {
    issuer,
    authorizationEndpoint: `${issuer}/protocol/openid-connect/auth`,
    tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
    certsEndpoint: `${issuer}/protocol/openid-connect/certs`,
    endSessionEndpoint: `${issuer}/protocol/openid-connect/logout`,
  };
}

function toArrayAudience(aud: JWTPayload["aud"]) {
  if (!aud) return [];
  return Array.isArray(aud) ? aud.map(String) : [String(aud)];
}

function normalizePath(path: string) {
  const trimmed = path.split("?")[0].replace(/\/+$/, "");
  return trimmed || "/";
}

function roleSet(roles: string[]) {
  return new Set(roles.map((role) => role.toLowerCase()));
}

function collectTokenRoles(payload: JWTPayload) {
  const realmRolesRaw = (payload as any)?.realm_access?.roles;
  const clientRolesRaw = (payload as any)?.resource_access?.[env.KEYCLOAK_CLIENT_ID]?.roles;

  const realmRoles = Array.isArray(realmRolesRaw)
    ? realmRolesRaw.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const clientRoles = Array.isArray(clientRolesRaw)
    ? clientRolesRaw.map((item) => String(item).trim()).filter(Boolean)
    : [];

  return {
    realmRoles,
    clientRoles,
    roles: unique([...realmRoles, ...clientRoles]),
  };
}

const roleGroups = {
  admin: parseCsv(env.KEYCLOAK_ADMIN_ROLES_CSV),
  operator: parseCsv(env.KEYCLOAK_OPERATOR_ROLES_CSV),
  editor: parseCsv(env.KEYCLOAK_EDITOR_ROLES_CSV),
  analyst: parseCsv(env.KEYCLOAK_ANALYST_ROLES_CSV),
};

const policies: RoutePolicy[] = [
  {
    id: "public.health",
    description: "Health checks",
    methods: ["GET"],
    pathRegex: /^\/(health|health\/verbose)$/,
    allowPublic: true,
  },
  {
    id: "public.auth-config",
    description: "Public Keycloak config",
    methods: ["GET"],
    pathRegex: /^\/auth\/config$/,
    allowPublic: true,
  },
  {
    id: "public.internal-auth",
    description: "Legacy internal auth endpoints",
    methods: ["POST"],
    pathRegex: /^\/(authenticate|logout)$/,
    allowPublic: true,
  },
  {
    id: "business.access",
    description: "Business test endpoint",
    methods: ["GET"],
    pathRegex: /^\/business$/,
    anyRoles: roleGroups.analyst,
  },
  {
    id: "aaa.profile",
    description: "Authenticated principal introspection",
    methods: ["GET"],
    pathRegex: /^\/aaa\/me$/,
    anyRoles: roleGroups.analyst,
  },
  {
    id: "aaa.policies",
    description: "Gateway policy introspection",
    methods: ["GET"],
    pathRegex: /^\/aaa\/policies$/,
    anyRoles: roleGroups.admin,
  },
  {
    id: "sources.read",
    description: "Source read operations",
    methods: ["GET"],
    pathRegex: /^\/sources(?:\/health)?$/,
    anyRoles: roleGroups.analyst,
  },
  {
    id: "sources.write",
    description: "Source write operations",
    methods: ["POST", "PUT", "DELETE"],
    pathRegex: /^\/sources(?:\/[^/]+(?:\/toggle)?)?$/,
    anyRoles: roleGroups.editor,
  },
  {
    id: "articles.read",
    description: "Article read operations",
    methods: ["GET"],
    pathRegex: /^\/articles\/page$/,
    anyRoles: roleGroups.analyst,
  },
  {
    id: "articles.write",
    description: "Article update operations",
    methods: ["PATCH"],
    pathRegex: /^\/articles\/[^/]+\/status$/,
    anyRoles: roleGroups.editor,
  },
  {
    id: "clusters.read",
    description: "Cluster read operations",
    methods: ["GET"],
    pathRegex: /^\/clusters\/[^/]+$/,
    anyRoles: roleGroups.analyst,
  },
  {
    id: "pipeline.control",
    description: "Pipeline run controls",
    methods: ["POST"],
    pathRegex: /^\/pipeline\/run(?:\/async)?$/,
    anyRoles: roleGroups.operator,
  },
  {
    id: "pipeline.read",
    description: "Pipeline read operations",
    methods: ["GET"],
    pathRegex: /^\/pipeline\/runs\/(?:page|[^/]+\/logs\/page)$/,
    anyRoles: roleGroups.analyst,
  },
  {
    id: "system.config",
    description: "System configuration and secrets",
    methods: ["GET", "PUT", "DELETE"],
    pathRegex: /^\/system\/(config(?:\/[^/]+)?|secrets(?:\/[^/]+)?|logs\/recent|metrics|recovery)$/,
    anyRoles: roleGroups.admin,
  },
  {
    id: "posts.read",
    description: "Daily posts and stats",
    methods: ["GET"],
    pathRegex: /^\/(posts\/(latest|[^/]+)|stats)$/,
    anyRoles: roleGroups.analyst,
  },
  {
    id: "newsletter.read",
    description: "Newsletter read operations",
    methods: ["GET"],
    pathRegex: /^\/newsletter\/documents\/(latest|page|[^/]+(?:\/versions)?)$/,
    anyRoles: roleGroups.analyst,
  },
  {
    id: "newsletter.write",
    description: "Newsletter write operations",
    methods: ["POST"],
    pathRegex: /^\/newsletter\/documents\/[^/]+\/(save-draft|refine|authorize|post-to-x|manual-posted|delete|rollback)$/,
    anyRoles: roleGroups.editor,
  },
];

function resolvePolicy(method: string, path: string) {
  return policies.find((policy) => {
    const methodMatch = policy.methods.includes(method.toUpperCase()) || policy.methods.includes("*");
    return methodMatch && policy.pathRegex.test(path);
  });
}

function extractBearerToken(headerValue: string | undefined) {
  if (!headerValue) {
    throw new GatewayAuthError(401, "Unauthorized");
  }
  const [scheme, token, ...rest] = headerValue.trim().split(/\s+/);
  if (!scheme || !token || rest.length > 0 || scheme.toLowerCase() !== "bearer") {
    throw new GatewayAuthError(401, "Unauthorized");
  }
  return token;
}

async function verifyKeycloakToken(token: string): Promise<GatewayPrincipal> {
  const endpoints = keycloakEndpoints();
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(endpoints.certsEndpoint), {
      cacheMaxAge: env.KEYCLOAK_JWKS_CACHE_SECONDS * 1000,
    });
  }

  const expectedAudience = env.KEYCLOAK_AUDIENCE?.trim() || env.KEYCLOAK_CLIENT_ID;

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, jwks, {
      issuer: endpoints.issuer,
      audience: expectedAudience,
      algorithms: ACCEPTED_JWT_ALGORITHMS,
      clockTolerance: env.KEYCLOAK_CLOCK_SKEW_SECONDS,
    });
    payload = verified.payload;
  } catch {
    throw new GatewayAuthError(401, "Unauthorized");
  }

  const subject = typeof payload.sub === "string" ? payload.sub : null;
  if (!subject) {
    throw new GatewayAuthError(401, "Unauthorized");
  }

  const roleBundle = collectTokenRoles(payload);
  const expiresAt = typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;

  return {
    subject,
    username: typeof payload.preferred_username === "string" ? payload.preferred_username : null,
    email: typeof payload.email === "string" ? payload.email : null,
    issuer: typeof payload.iss === "string" ? payload.iss : endpoints.issuer,
    audience: toArrayAudience(payload.aud),
    roles: roleBundle.roles,
    realmRoles: roleBundle.realmRoles,
    clientRoles: roleBundle.clientRoles,
    tokenId: typeof payload.jti === "string" ? payload.jti : null,
    expiresAt,
  };
}

function authorizeByPolicy(principal: GatewayPrincipal, policy: RoutePolicy) {
  const required = (policy.anyRoles || []).map((role) => role.toLowerCase());
  if (!required.length) return;

  const granted = roleSet(principal.roles);
  const allowed = required.some((role) => granted.has(role));
  if (!allowed) {
    throw new GatewayAuthError(403, "Forbidden");
  }
}

function buildRequestId(headerValue: unknown) {
  const candidate = typeof headerValue === "string" ? headerValue.trim() : "";
  if (candidate) return candidate.slice(0, 120);
  return crypto.randomUUID();
}

function accountingLog(params: {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  policyId: string | null;
  decision: AccountingDecision;
  reason: string;
  principal: GatewayPrincipal | null;
}) {
  logger.info(
    {
      event: "gateway_accounting",
      requestId: params.requestId,
      method: params.method,
      path: params.path,
      statusCode: params.statusCode,
      durationMs: params.durationMs,
      policyId: params.policyId,
      decision: params.decision,
      reason: params.reason,
      subject: params.principal?.subject ?? null,
      username: params.principal?.username ?? null,
      roles: params.principal?.roles ?? [],
      tokenId: params.principal?.tokenId ?? null,
    },
    "gateway_event",
  );
}

export function createGatewayMiddleware() {
  return async (request: Request, reply: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const method = request.method.toUpperCase();
    const path = normalizePath(request.path || request.originalUrl || "/");
    const requestId = buildRequestId(request.headers["x-request-id"]);
    reply.setHeader(REQUEST_ID_HEADER, requestId);

    const policy = resolvePolicy(method, path);
    let decision: AccountingDecision = "deny";
    let reason = "uninitialized";
    let principal: GatewayPrincipal | null = null;

    const finalize = () => {
      accountingLog({
        requestId,
        method,
        path,
        statusCode: reply.statusCode,
        durationMs: Date.now() - startedAt,
        policyId: policy?.id ?? null,
        decision,
        reason,
        principal,
      });
    };
    reply.once("finish", finalize);

    if (method === "OPTIONS") {
      decision = "allow";
      reason = "cors_preflight";
      reply.status(204).end();
      return;
    }

    if (!policy) {
      decision = "deny";
      reason = "missing_policy";
      reply.status(403).json({ detail: "Forbidden" });
      return;
    }

    if (!env.KEYCLOAK_ENABLED) {
      request.gatewayContext = {
        requestId,
        policyId: policy.id,
        authenticated: false,
        principal: null,
      };
      decision = "bypass";
      reason = "keycloak_disabled";
      next();
      return;
    }

    if (policy.allowPublic) {
      request.gatewayContext = {
        requestId,
        policyId: policy.id,
        authenticated: false,
        principal: null,
      };
      decision = "allow";
      reason = "public_policy";
      next();
      return;
    }

    try {
      const token = extractBearerToken(request.headers.authorization);
      principal = await verifyKeycloakToken(token);
      authorizeByPolicy(principal, policy);
      request.gatewayContext = {
        requestId,
        policyId: policy.id,
        authenticated: true,
        principal,
      };
      decision = "allow";
      reason = "authorized";
      next();
    } catch (error) {
      const statusCode = error instanceof GatewayAuthError ? error.statusCode : 500;
      decision = "deny";
      reason = error instanceof GatewayAuthError ? error.message : "internal_error";
      const detail = error instanceof GatewayAuthError ? error.message : "Internal server error";
      reply.status(statusCode).json({ detail });
    }
  };
}

export function gatewayPublicAuthConfig() {
  const endpoints = keycloakEndpoints();
  return {
    enabled: env.KEYCLOAK_ENABLED,
    provider: "keycloak",
    issuer: endpoints.issuer,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
    endSessionEndpoint: endpoints.endSessionEndpoint,
    clientId: env.KEYCLOAK_CLIENT_ID,
    audience: env.KEYCLOAK_AUDIENCE || env.KEYCLOAK_CLIENT_ID,
    scope: env.KEYCLOAK_SCOPE,
    pkceMethod: "S256",
  };
}

export function gatewayPolicyCatalog() {
  return policies.map((policy) => ({
    id: policy.id,
    description: policy.description,
    methods: policy.methods,
    pathPattern: policy.pathRegex.source,
    allowPublic: Boolean(policy.allowPublic),
    anyRoles: policy.anyRoles ?? [],
  }));
}

export const gatewayTestKit = {
  collectTokenRoles,
  resolvePolicy,
  normalizePath,
};
