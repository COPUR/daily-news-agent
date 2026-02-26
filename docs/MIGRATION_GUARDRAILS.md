# Migration Guardrails

## Scope

This repository (`daily-news-agent`) is API-only after migration.
UI assets are moved to the separate `dashboard-service` repository.

## Non-negotiable rules

- No tracked env files except templates (`.env.example`).
- No local env data before public publish (`.env`, `.env.local` must be absent or empty).
- No committed business/database data files (`*.db`, `*.sqlite*`, `*.csv`, `*.tsv`, `*.jsonl`).
- No tracked runtime/data directories (`data/`, `.runtime/`).
- SQL content is limited to database creation scripts only.
  - Allowed paths:
    - `prisma/schema.prisma`
    - `prisma/migrations/**/migration.sql`
    - `db/init.sql`
    - `db/migrations/*.sql`

## Enforcement

Run:

```bash
npm run verify:public
```

This command is wired into CI and must pass before publishing.
