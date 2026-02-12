# Deployment Guide

This guide covers local and server-style deployment of the Node runtime.

## 1) Deployment Targets

- Developer local machine (no Docker)
- Single-host Docker Compose deployment
- GitHub Actions build validation (CI)

Current repository is Node runtime only.

## 2) Deployment Architecture

```mermaid
flowchart LR
    Repo["Git Repository"] --> Build["Node Build (tsc + prisma generate)"]
    Build --> Image["Docker Image (Dockerfile)"]
    Image --> Host["Deployment Host"]
    Host --> App["Node App Container"]
    App --> SQLite["SQLite File Volume"]
    App --> RuntimeStore[".runtime Volume (newsletter docs, logs)"]
    User["Operator Browser"] --> App
```

## 3) Preconditions

- Node 20+ (for non-Docker)
- Docker + Docker Compose (for container mode)
- `.env` configured from `.env.example`
- `HUGGINGFACE_API_KEY` and model config for Turkish refine
- X credentials configured if posting to X is required

## 4) Non-Docker Deployment

From `/path/to/daily-news-agent`:

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:push
npm run seed
npm run build
npm run start
```

Validate:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/health/verbose
```

Open dashboard:

- `http://127.0.0.1:8000/dashboard/`

## 5) Docker Deployment

`docker-compose.yml` mounts persistence volumes:

- `./data:/app/data`
- `./.runtime:/app/.runtime`

Run:

```bash
cd /path/to/daily-news-agent
cp .env.example .env
docker compose up --build -d
```

Stop:

```bash
docker compose down
```

Check:

```bash
docker compose ps
curl http://127.0.0.1:8000/health
```

## 6) Deployment Sequence

```mermaid
sequenceDiagram
    participant Operator
    participant Host
    participant Docker
    participant App as Node App
    participant DB as SQLite/NoSQL

    Operator->>Host: pull latest code
    Operator->>Docker: docker compose build
    Operator->>Docker: docker compose up -d
    Docker->>App: start container
    App->>DB: prisma db push
    App->>App: bootstrap server + scheduler
    Operator->>App: GET /health and /health/verbose
```

## 7) Persistent Data and Backups

Persist these paths:

- SQLite DB path (Prisma-resolved path; verify actual file on host)
- `.runtime/newsletter_documents.json`
- optional `.runtime` logs and artifacts

Backup recommendation:

1. Stop app (or ensure no writes during snapshot).
2. Copy DB file and `.runtime/newsletter_documents.json`.
3. Store timestamped archive.

## 8) Rollback Plan

For source-based deployments:

1. Checkout previous commit/tag.
2. Rebuild (`npm run build` or docker build).
3. Restart app.
4. Keep same persisted data if schema-compatible.

For schema risk:

1. Backup DB and newsletter JSON before rollout.
2. Restore backup if rollback is required.

## 9) Security and Hardening Checklist

- Rotate API keys and tokens regularly.
- Do not commit `.env`.
- Restrict network exposure to required ports only.
- Use a reverse proxy/TLS for internet-facing deployment.
- Limit filesystem permissions on data and runtime directories.
- Monitor `/health/verbose` integration warnings.

## 10) Production Caveats

- Single-process, single-host model by default.
- SQLite is suitable for local-first and small deployments; for scale, migrate DB provider.
- X posting requires full credential set and bearer verification flow.
- LLM provider availability impacts refine/generation quality; fallback paths exist for post generation but refine expects strict JSON output.
