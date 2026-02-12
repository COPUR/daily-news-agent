# Daily News Agent (Node.js)

Local-first EV/SDV/Battery news agent implemented in Node.js.

## Stack
- Node.js 20+
- ExpressJS API + static dashboard
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
- Dashboard tabs: overview, sources, news, observability, newsletter, config/secrets, logs.

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
npm run seed
npm run dev
```

Open:
- API health: [http://localhost:8000/health](http://localhost:8000/health)
- Dashboard: [http://localhost:8000/dashboard/](http://localhost:8000/dashboard/)

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

Then restart API/dashboard.  
`POST /newsletter/documents/:id/refine` now calls the configured provider and preserves deterministic citations (`[A1]`, `[A2]`, ...).

## Tests

```bash
npm test
```

Current suite includes URL normalization and dedup clustering tests.

## Docker

```bash
cd /path/to/daily-news-agent
cp .env.example .env
docker compose up --build
```

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
