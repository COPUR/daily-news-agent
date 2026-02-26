# Security Baseline (CMMI-oriented)

This document maps the internal JWT lifecycle service implementation to common secure coding and process controls aligned with CMMI-style engineering discipline.

## Scope

- Endpoints: `POST /authenticate`, `POST /logout`, `GET /business`
- Gateway/AAA: Keycloak-backed policy enforcement + PKCE login (`/login/`) and logout (`/logout/`)
- Runtime files:
  - `src/services/internalAuth.ts`
  - `src/services/keycloakGateway.ts`
  - `src/routes/api.ts`
  - `src/server.ts`
  - `src/config/env.ts`

## Implemented controls

1. Input validation (VER / PPQA)
- Credential payloads are validated with strict schema constraints (length and shape checks).
- Authorization header format is validated as strict `Bearer <token>`.

2. Strong token verification (VER)
- JWT signatures validated using HMAC SHA-256 (`HS256`) with strict `alg` enforcement.
- Claims validated for `iss`, `aud`, `sub`, `exp`, `nbf`, `iat`, `jti`.
- Constant-time comparisons used for sensitive string comparisons.

3. Stateful logout and replay resistance (REQM / TECHNICAL SOLUTION)
- Token sessions stored in SQLite with `token_active` state.
- Logout marks the token inactive.
- Protected endpoint (`/business`) validates both JWT cryptography and DB active-state.

4. Rate limiting (RISK MGMT)
- Authentication attempts are throttled per IP window.
- `429 Too Many Requests` and `Retry-After` support included.

5. Secure defaults and fail-safe behavior (PPQA)
- Internal auth can be disabled by default via configuration.
- Service fails closed when security-critical config is missing.
- Auth responses set `Cache-Control: no-store`.

6. Secure transport/application headers (PPQA)
- Baseline headers added:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy`
  - `Cross-Origin-Resource-Policy: same-origin`

7. Auditability (MA / PPQA)
- Authentication and logout events are logged without exposing secrets or plaintext passwords.
- Session records include issue/expiry/revocation timestamps for traceability.
- Gateway accounting logs include requestId, policy, user subject, role set, decision, and status code.

8. Federated authentication and role-based authorization (REQM / TS / VER)
- Keycloak access tokens are validated against realm JWKS with issuer/audience checks.
- Policy-based route controls enforce role groups (`admin`, `operator`, `editor`, `analyst`).
- Dashboard and public login page use PKCE authorization code flow for public-client authentication.

## Configuration management controls (CM)

Required environment keys:

- `INTERNAL_AUTH_ENABLED`
- `INTERNAL_AUTH_USERNAME`
- `INTERNAL_AUTH_PASSWORD` or `INTERNAL_AUTH_PASSWORD_HASH`
- `INTERNAL_AUTH_JWT_SECRET`
- `INTERNAL_AUTH_ISSUER`
- `INTERNAL_AUTH_AUDIENCE`
- `INTERNAL_AUTH_TOKEN_TTL_SECONDS`
- `INTERNAL_AUTH_ALLOWED_CLOCK_SKEW_SECONDS`
- `INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS`
- `INTERNAL_AUTH_RATE_LIMIT_MAX_ATTEMPTS`
- `KEYCLOAK_ENABLED`
- `KEYCLOAK_BASE_URL`
- `KEYCLOAK_REALM`
- `KEYCLOAK_CLIENT_ID`
- `KEYCLOAK_AUDIENCE`
- `KEYCLOAK_SCOPE`
- `KEYCLOAK_ISSUER_URL`
- `KEYCLOAK_CLOCK_SKEW_SECONDS`
- `KEYCLOAK_JWKS_CACHE_SECONDS`
- `KEYCLOAK_ADMIN_ROLES_CSV`
- `KEYCLOAK_OPERATOR_ROLES_CSV`
- `KEYCLOAK_EDITOR_ROLES_CSV`
- `KEYCLOAK_ANALYST_ROLES_CSV`

## Residual risks / next controls

1. Prefer TLS termination in front of this service for all environments.
2. Prefer hashed password mode (`INTERNAL_AUTH_PASSWORD_HASH`) over plaintext password env usage.
3. Rotate `INTERNAL_AUTH_JWT_SECRET` on a controlled schedule and invalidate active sessions after rotation.
4. Add integration tests that execute endpoint-level auth flows against a temporary SQLite DB and mocked Keycloak JWKS.
