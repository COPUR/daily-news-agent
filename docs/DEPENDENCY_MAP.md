# Dependency Map

This document describes package-level and module-level dependencies for the Node.js runtime.

## 1) Package Dependency Layers

### Runtime core
- `express`, `cors`
- `dotenv`, `zod`
- `pino`

### Data layer
- `@prisma/client`
- `prisma` (dev/runtime tooling)

### Connector and extraction layer
- `axios`
- `rss-parser`
- `cheerio`
- `@mozilla/readability`
- `jsdom`
- `playwright` (optional JS-rendered scraping)

### Scheduling and orchestration
- `node-cron`

### LLM/provider layer
- `openai`
- `axios` (xAI, Hugging Face, Ollama HTTP calls)

### Tooling and tests
- `typescript`, `tsx`
- `vitest`
- `@types/*`

## 2) Internal Module Dependency Graph

```mermaid
flowchart TD
    Server["src/server.ts"] --> Router["src/routes/api.ts"]
    Server --> Scheduler["src/services/scheduler.ts"]
    Server --> Prisma["src/db/client.ts"]

    Router --> Pipeline["src/services/pipeline.ts"]
    Router --> NewsletterStore["src/services/newsletterStore.ts"]
    Router --> RuntimeAdmin["src/services/runtimeAdmin.ts"]
    Router --> XPublisher["src/services/xPublisher.ts"]

    Pipeline --> ConnRSS["connectors/rss.ts"]
    Pipeline --> ConnScrape["connectors/scrape.ts"]
    Pipeline --> ConnX["connectors/x.ts"]
    Pipeline --> ConnGrok["connectors/grok.ts"]
    Pipeline --> Enrichment["enrichment.ts"]
    Pipeline --> Dedup["dedup.ts"]
    Pipeline --> Ranking["ranking.ts"]
    Pipeline --> PostGen["postGeneration.ts"]
    Pipeline --> NewsletterStore

    Enrichment --> Extraction["extraction.ts"]
    Enrichment --> RetrievalTools["retrievalTools.ts"]
    ConnScrape --> RetrievalTools

    PostGen --> HF["huggingface.ts"]
    NewsletterStore --> Refine["newsletterRefine.ts"]
    Refine --> HF

    Router --> Utils["utils/json.ts + utils/url.ts + utils/logger.ts"]
    Pipeline --> Utils
    NewsletterStore --> Utils
```

## 3) Critical Path Dependencies

### Request path: run pipeline

```mermaid
sequenceDiagram
    participant API as /pipeline/run
    participant PIPE as pipeline.ts
    participant DB as Prisma/SQLite
    participant EXT as Connectors + Providers
    participant DOC as Newsletter NoSQL

    API->>PIPE: runPipeline()
    PIPE->>DB: create PipelineRun
    PIPE->>EXT: ingest (rss/scrape/x/grok)
    PIPE->>DB: RawItem + Article writes
    PIPE->>EXT: enrichment + optional serper
    PIPE->>DB: dedup + ranking + DailyPost writes
    PIPE->>DOC: upsertPipelineDraft()
    PIPE->>DB: finalize run + logs
```

### Request path: refine newsletter

```mermaid
sequenceDiagram
    participant API as /newsletter/.../refine
    participant STORE as newsletterStore.ts
    participant REF as newsletterRefine.ts
    participant LLM as OpenAI/Ollama/HF/xAI
    participant DOC as NoSQL JSON

    API->>STORE: refineWithChatbot()
    STORE->>REF: refineNewsletterVariant(args)
    REF->>LLM: prompt request
    LLM-->>REF: strict JSON content
    REF-->>STORE: refined headline/markdown/text
    STORE->>DOC: update variant + version + audit
```

## 4) Optional vs Required Dependencies

| Dependency | Required for base run | Required for full feature set |
|---|---|---|
| `express`, `@prisma/client`, `node-cron`, `axios`, `zod` | Yes | Yes |
| `playwright` | No | Needed for JS-render scrape sources |
| `openai` | No | Needed only when `LLM_PROVIDER=openai` |
| Hugging Face/xAI/Ollama HTTP endpoints | No | Needed based on selected provider |
| X credentials | No | Needed for X ingestion and publish |
| Serper API key | No | Needed for related-links enrichment |

## 5) Dependency Risk Notes

- `playwright` increases image size and cold-start time; keep optional at source level (`jsRender=true` only where needed).
- Provider SDK/API versions should be pinned and reviewed before major upgrades.
- Prisma schema changes should be coordinated with `prisma db push` and seed/test runs.

## 6) Upgrade Strategy

1. Check current graph: `npm ls --depth=1`
2. Review available updates: `npm outdated`
3. Upgrade incrementally by layer:
   - tooling/dev
   - connectors/parsers
   - DB/runtime
   - provider SDKs
4. Validate with:
   - `npm run build`
   - `npm test`
   - `npm run run:pipeline`
   - `GET /health/verbose`
