# Daily News Agent (Node.js)

Local-first EV/SDV/Battery news agent implemented in Node.js.

## Stack
- Node.js 20+
- ExpressJS API microservice
- Prisma ORM
- SQLite default DB (`file:./data/ev_news_node.db`)
- `node-cron` scheduler
- Optional LLM providers: OpenAI, Ollama, Hugging Face, xAI (Grok)

## Key capabilities
- Ingestion: RSS, scrape (HTML + optional JS rendering), X API, Grok source.
- Enrichment: full-text extraction, key facts, optional related links via Serper.
- Dedup: URL normalization + title similarity + SimHash + embedding cosine.
- Ranking: priority order
  `Tesla > Hypercars > NVIDIA > Openpilot > BYD > AV > Vehicle Software > BMS > Battery > SDV > EV > Other`.
- One daily post in `en` or `tr` with citations.
- Newsletter lifecycle in local NoSQL document store:
  document-level `draft -> authorized -> posted`, plus `manual_posted` and `deleted`,
  with per-language variant `post_status` flow `draft -> preauth -> authorized -> posted`.
- UI is hosted by the separate `dashboard-service` microservice.
- Internal JWT lifecycle service endpoints:
  - `POST /authenticate`
  - `POST /logout`
  - `GET /business`
  with stateful token invalidation and SQLite-backed active token checks.

## Pattern-based crawler modules (non-n8n)
Inspired by tool/workflow patterns but implemented as code services:
- `src/services/retrievalTools.ts`
  - `textRetrievalTool`: fetch + readable-text extraction + block detection metadata.
  - `urlRetrievalTool`: link extraction + absolute URL resolution + dedupe/filter.
- `src/services/connectors/scrape.ts`
  - Uses retrieval tool pattern for resilient link discovery.
- `src/services/enrichment.ts`
  - Persists retrieval status (blocked/reason/resolved URL) inside extracted facts.

## Quick start (no Docker)

```bash
cd /path/to/daily-news-agent
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:push
npm run dev
```

Open:
- API health: [http://localhost:8000/health](http://localhost:8000/health)
- Dashboard service: [http://localhost:8001/dashboard/](http://localhost:8001/dashboard/)

## Run Both Services Together (Recommended)

Prerequisites:

- sibling checkout exists at `../dashboard-service` (or set `DASHBOARD_REPO_PATH`)
- dependencies installed in both repos (`npm ci`)

Run from `daily-news-agent`:

```bash
npm run dev:with-dashboard
```

Optional overrides:

```bash
API_PORT=9000 DASHBOARD_PORT=9001 npm run dev:with-dashboard
```

The script will:

- run Prisma generate + db push for the API service
- start API and dashboard service together
- stop both on `Ctrl+C`

## One-off pipeline run

```bash
npm run run:pipeline
```

Or API:

```bash
curl -X POST http://localhost:8000/pipeline/run/async \
  -H "Content-Type: application/json" \
  -d '{"outputLanguage":"tr","forcePost":false}'
```

## Turkish refine via Hugging Face (YTU)

Set provider and key before using newsletter refine:

```bash
LLM_PROVIDER=huggingface
HUGGINGFACE_API_KEY=hf_xxx
HUGGINGFACE_MODEL_ID=ytu-ce-cosmos/turkish-gpt2-large-750m-instruct-v0.1
```

Then restart API and dashboard-service.  
`POST /newsletter/documents/:id/refine` now calls the configured provider and preserves deterministic citations (`[A1]`, `[A2]`, ...).

## Tests

```bash
npm test
npm run test:coverage
```

Current suite includes URL normalization and dedup clustering tests.
Coverage for the gateway/auth TDD scope is enforced in Vitest (`vitest.config.ts`) with >=90% targets for lines/statements/functions and >=85% branches.

## Internal JWT service (secure-by-default controls)

The service is intended for private/internal networks only.

Configuration keys in `.env`:

- `INTERNAL_AUTH_ENABLED`
- `INTERNAL_AUTH_USERNAME`
- `INTERNAL_AUTH_PASSWORD` or `INTERNAL_AUTH_PASSWORD_HASH`
- `INTERNAL_AUTH_JWT_SECRET` (use 32+ characters)
- `INTERNAL_AUTH_ISSUER`
- `INTERNAL_AUTH_AUDIENCE`
- `INTERNAL_AUTH_TOKEN_TTL_SECONDS`
- `INTERNAL_AUTH_ALLOWED_CLOCK_SKEW_SECONDS`
- `INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS`
- `INTERNAL_AUTH_RATE_LIMIT_MAX_ATTEMPTS`

OpenAPI signature:

- `docs/openapi/internal-jwt-lifecycle.yaml`

Password hash format for `INTERNAL_AUTH_PASSWORD_HASH`:

- `pbkdf2_sha256$<iterations>$<salt_base64url>$<hash_base64url>`

Generate a hash value:

```bash
npm run security:hash-password -- "your-strong-password"
```

## Keycloak Gateway AAA (PKCE + RBAC)

Public pages:

- Login: `/login/`
- Logout: `/logout/`

Gateway public auth config endpoint:

- `GET /auth/config`

Gateway AAA endpoints:

- `GET /aaa/me`
- `GET /aaa/policies`

Keycloak settings in `.env`:

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

When `KEYCLOAK_ENABLED=true`, API access is enforced by gateway policy with user+role checks and request accounting logs.

## Public migration guardrails

```bash
npm run verify:public
```

The check fails if tracked/local env data is present or if business/database data files are committed. Only database creation scripts are allowed for SQL content.

## Docker

```bash
cd /path/to/daily-news-agent
cp .env.example .env
docker compose up --build
```

## Gitpod

Open this repository directly in Gitpod:

- `https://gitpod.io/#https://github.com/COPUR/daily-news-agent`

Workspace bootstrap is automated by `.gitpod.yml` and will:

- copy `.env.example` to `.env` if needed
- create `data/` and `.runtime/` folders
- install dependencies
- run Prisma generate + db push
- start the app with `npm run dev`

After startup, open:

- API health: [http://localhost:8000/health](http://localhost:8000/health)
- Dashboard service (separate repo): [http://localhost:8001/dashboard/](http://localhost:8001/dashboard/)

If you need provider credentials (OpenAI, xAI, Hugging Face, X, Serper), add them as Gitpod workspace/project environment variables and restart the workspace.

## Roadmap and migration docs
- `docs/README.md`
- `docs/ARCHITECTURE_UML.md`
- `docs/INTEGRATION_MAP.md`
- `docs/DEPENDENCY_MAP.md`
- `docs/IMPLEMENTATION_DOCUMENTATION.md`
- `docs/DATA_JOURNEY.md`
- `docs/RUNTIME_OPERATIONS.md`
- `docs/DEPLOYMENT_GUIDE.md`
- `docs/CI_CD.md`
- `docs/SECURITY_CMMI_BASELINE.md`
- `docs/openapi/internal-jwt-lifecycle.yaml`
- `docs/openapi/keycloak-gateway-aaa.yaml`
