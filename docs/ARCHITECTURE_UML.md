# Architecture and UML

This document describes the current Node.js implementation architecture (`src/`) and its operational model.

For field-level lineage and transformation details, see `DATA_JOURNEY.md`.

## 1) System Context

```mermaid
flowchart LR
    User["Operator / Editor"] --> Dashboard["Web Dashboard (/dashboard/)"]
    Dashboard --> API["Express API (src/routes/api.ts)"]
    Scheduler["node-cron Scheduler"] --> API
    API --> Pipeline["Pipeline Orchestrator (src/services/pipeline.ts)"]
    Pipeline --> Connectors["Connectors: RSS / Scrape / X / Grok"]
    Pipeline --> Enrichment["Extraction + Enrichment"]
    Pipeline --> Dedup["Dedup + Clustering"]
    Pipeline --> Ranking["Ranking + Selection"]
    Pipeline --> PostGen["Daily Post Generation (LLM/Rule-based)"]
    PostGen --> NewsletterStore["Newsletter NoSQL Store (.runtime/newsletter_documents.json)"]
    API --> NewsletterStore
    API --> RuntimeAdmin["Runtime Config + Secret Admin"]
    Pipeline --> DB["SQLite via Prisma"]
    API --> DB
    PostGen --> LLMs["OpenAI / Ollama / Hugging Face / xAI"]
    API --> XPost["X Post API"]
```

## 2) Pipeline Stages

Execution order in `runPipeline`:

1. Ingestion
2. Normalization
3. Enrichment
4. Dedup/Clustering
5. Ranking and Daily Post Generation
6. Draft persistence to newsletter NoSQL

Each stage emits persisted step logs (`PipelineLog`) with timing and payload snapshots.

## 3) Component Diagram

```mermaid
classDiagram
    class Server {
      +bootstrap()
      +shutdown()
    }

    class ApiRouter {
      +health endpoints
      +source CRUD
      +pipeline run endpoints
      +newsletter endpoints
      +observability endpoints
    }

    class PipelineService {
      +runPipeline()
      +ingestSources()
      +normalizeRawItems()
      +enrichArticles()
      +deduplicateRecent()
      +rankAndGeneratePost()
    }

    class NewsletterStore {
      +upsertPipelineDraft()
      +saveDraft()
      +refineWithChatbot()
      +authorize()
      +postDocumentToX()
      +markManualPosted()
      +markDeleted()
      +rollbackToVersion()
    }

    class SchedulerService {
      +startScheduler()
      +stopScheduler()
      +schedulerStatus()
    }

    class RuntimeAdmin {
      +listConfig()
      +updateConfig()
      +listSecrets()
      +setSecret()
      +clearSecret()
    }

    Server --> ApiRouter
    Server --> SchedulerService
    ApiRouter --> PipelineService
    ApiRouter --> NewsletterStore
    ApiRouter --> RuntimeAdmin
    PipelineService --> NewsletterStore
```

## 4) Use Cases

### 4.1 Actors

- Operator (manages sources, runs pipeline, monitors system)
- Editor (refines, approves, posts newsletter variants)
- Scheduler (automated daily trigger)
- External Integrations (RSS/Web/X/Grok/LLM providers)

### 4.2 Use Case Diagram

```mermaid
flowchart LR
    Operator["Operator"] --> UC1["Manage Sources"]
    Operator --> UC2["Run Pipeline"]
    Operator --> UC3["Observe Health and Logs"]
    Editor["Editor"] --> UC4["Refine Draft (EN/TR)"]
    Editor --> UC5["Approve Variant"]
    Editor --> UC6["Post to X"]
    Editor --> UC7["Manual Post / Delete / Rollback"]
    Scheduler["Scheduler"] --> UC8["Scheduled Pipeline Execution"]

    subgraph System["Daily News Agent Node"]
      UC1
      UC2
      UC3
      UC4
      UC5
      UC6
      UC7
      UC8
    end
```

### 4.3 Use Case Details

| ID | Use Case | Trigger | Primary Outcome | Failure Mode |
|---|---|---|---|---|
| UC1 | Manage Sources | Dashboard/API | Source CRUD persisted in DB | Validation/uniqueness errors |
| UC2 | Run Pipeline | Manual API/Dashboard | New run with logs + optional draft update | Run marked failed with error log |
| UC3 | Observe Health and Logs | Dashboard/API | Runtime visibility (health/metrics/logs) | Partial probe warnings |
| UC4 | Refine Draft | Editor action | New language variant content + version entry | LLM JSON/transport failure |
| UC5 | Approve Variant | Editor action | Variant `post_status=authorized` | Citation validation fails |
| UC6 | Post to X | Editor action | X post verified + status `posted` | Integration error, stays authorized |
| UC7 | Manual lifecycle actions | Editor action | `manual_posted` or `deleted` or rollback state | Invalid transition |
| UC8 | Scheduled run | Cron trigger | Same as UC2 with trigger `scheduled` | Logged failure, scheduler continues |

## 5) Data Model (Prisma + NoSQL)

### 5.1 Relational Core (SQLite via Prisma)

```mermaid
classDiagram
    class Source {
      +id: Int
      +sourceType: rss|scrape|x|grok
      +name: String (unique)
      +enabled: Bool
      +pollingMinutes: Int
      +configJson: String
      +authJson: String?
      +lastFetchedAt: DateTime?
    }

    class RawItem {
      +id: Int
      +sourceId: Int
      +runId: String
      +title: String
      +url: String
      +normalizedUrl: String
      +summary: String?
      +rawPayload: String?
    }

    class Article {
      +id: Int
      +sourceId: Int
      +rawItemId: Int?
      +title: String
      +url: String
      +normalizedUrl: String
      +fullText: String?
      +topic: Topic
      +status: ArticleStatus
      +simhashValue: String?
      +embedding: Bytes?
      +extractedFactsJson: String?
    }

    class DedupCluster {
      +id: Int
      +primaryArticleId: Int?
      +methodSummary: String?
    }

    class DailyPost {
      +id: Int
      +postDate: String (unique)
      +headline: String
      +contentMarkdown: String
      +contentText: String
      +generatedBy: String
      +metadataJson: String?
    }

    class PipelineRun {
      +id: String
      +trigger: RunTrigger
      +status: RunStatus
      +itemsIngested: Int
      +itemsNormalized: Int
      +duplicatesCount: Int
      +errorsCount: Int
      +selectedCount: Int
      +summaryJson: String?
    }

    class PipelineLog {
      +id: Int
      +runId: String
      +level: String
      +step: String
      +sourceId: Int?
      +message: String
      +payloadJson: String?
      +durationMs: Int?
    }

    Source "1" --> "*" RawItem
    Source "1" --> "*" Article
    RawItem "1" --> "0..1" Article
    Article "*" --> "0..1" DedupCluster
    DailyPost "1" --> "*" Article : via DailyPostItem
    PipelineRun "1" --> "*" PipelineLog
    Source "1" --> "*" PipelineLog
```

### 5.2 Newsletter NoSQL Model

Newsletter documents are stored in `.runtime/newsletter_documents.json`.

Structure (simplified):

- Document-level status: `draft | authorized | posted | manual_posted | deleted`
- Collection-level data:
  - source news items
  - citation catalog
  - `language_variants[]`
- Variant-level posting state:
  - `post_status: draft | preauth | authorized | posted`
  - `approved_at`, `posted_at`
- Version history entries with payload snapshots and citation validation
- Audit trail entries

## 6) State Diagrams

### 6.1 Pipeline Run State

```mermaid
stateDiagram-v2
    [*] --> running
    running --> success : no unhandled error
    running --> failed : exception in pipeline
    success --> [*]
    failed --> [*]
```

### 6.2 Newsletter Document State

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> authorized : authorize()
    authorized --> posted : postDocumentToX() success
    draft --> manual_posted : markManualPosted()
    authorized --> manual_posted : markManualPosted()
    manual_posted --> deleted : markDeleted()
    draft --> deleted : markDeleted()
    authorized --> deleted : markDeleted()
```

### 6.3 Variant Posting State (Per Language)

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> preauth : pipeline/refine result persisted
    preauth --> authorized : authorize(collection, language)
    authorized --> posted : post-to-x success
    authorized --> authorized : post-to-x error/fallback
```

## 7) Sequence Diagrams

### 7.1 Scheduled Pipeline Execution

```mermaid
sequenceDiagram
    participant Cron as Scheduler
    participant Pipe as PipelineService
    participant Conn as Connectors
    participant DB as Prisma/SQLite
    participant Gen as PostGeneration
    participant Store as NewsletterStore

    Cron->>Pipe: runPipeline(trigger=scheduled)
    Pipe->>DB: create PipelineRun(status=running)
    Pipe->>Conn: fetch sources (rss/scrape/x/grok)
    Conn-->>Pipe: records + warnings + errors
    Pipe->>DB: persist RawItem
    Pipe->>DB: normalize RawItem -> Article
    Pipe->>Pipe: enrichArticle()
    Pipe->>Pipe: deduplicateRecent()
    Pipe->>Pipe: selectTopArticles()
    Pipe->>Gen: generateDailyPost()
    Gen-->>Pipe: headline + markdown + text + citations
    Pipe->>DB: persist DailyPost + DailyPostItem
    Pipe->>Store: upsertPipelineDraft()
    Pipe->>DB: update PipelineRun(status=success/failed)
```

### 7.2 Chat Refine to Turkish Variant

```mermaid
sequenceDiagram
    participant Editor
    participant API
    participant Store as NewsletterStore
    participant Refine as NewsletterRefine
    participant HF as HuggingFace

    Editor->>API: POST /newsletter/documents/{id}/refine
    API->>Store: refineWithChatbot(collectionId, en->tr)
    Store->>Refine: refineNewsletterVariant(args)
    Refine->>HF: prompt + strict JSON contract
    HF-->>Refine: response
    Refine-->>Store: tr headline/markdown/text
    Store->>Store: set variant.post_status=preauth
    Store-->>API: updated document
    API-->>Editor: 200 + updated TR variant
```

### 7.3 Approve and Post Variant with Fallback

```mermaid
sequenceDiagram
    participant Editor
    participant API
    participant Store as NewsletterStore
    participant X as X API

    Editor->>API: POST /newsletter/documents/{id}/authorize (collectionId, language)
    API->>Store: authorize()
    Store->>Store: citation validation
    Store->>Store: variant.post_status=authorized
    API-->>Editor: authorized

    Editor->>API: POST /newsletter/documents/{id}/post-to-x
    API->>Store: postDocumentToX()
    Store->>X: create tweet + verify tweet
    alt success
      X-->>Store: tweet id/url
      Store->>Store: variant.post_status=posted, doc.status=posted
      API-->>Editor: posted
    else error
      X--xStore: error
      Store--xAPI: NewsletterDocumentError
      API-->>Editor: 4xx with detail
      Note over Store: document remains authorized draft
    end
```

## 8) API Surface (Current)

Grouped by responsibility:

- Health/Status
  - `GET /health`
  - `GET /health/verbose`

- Runtime Admin
  - `GET /system/config`
  - `PUT /system/config/:key`
  - `GET /system/secrets`
  - `PUT /system/secrets/:key`
  - `DELETE /system/secrets/:key`

- Sources
  - `GET /sources`
  - `GET /sources/health`
  - `POST /sources`
  - `PUT /sources/:sourceId`
  - `POST /sources/:sourceId/toggle`
  - `DELETE /sources/:sourceId`

- News/Clusters
  - `GET /articles/page`
  - `PATCH /articles/:articleId/status`
  - `GET /clusters/:clusterId`

- Pipeline
  - `POST /pipeline/run`
  - `POST /pipeline/run/async`
  - `GET /pipeline/runs/page`
  - `GET /pipeline/runs/:runId/logs/page`

- Observability
  - `GET /system/logs/recent`
  - `GET /system/metrics`
  - `GET /system/recovery`
  - `GET /stats`

- Daily Posts
  - `GET /posts/latest`
  - `GET /posts/:postDate`

- Newsletter Workflow
  - `GET /newsletter/documents/latest`
  - `GET /newsletter/documents/page`
  - `GET /newsletter/documents/:documentId`
  - `GET /newsletter/documents/:documentId/versions`
  - `POST /newsletter/documents/:documentId/save-draft`
  - `POST /newsletter/documents/:documentId/refine`
  - `POST /newsletter/documents/:documentId/authorize`
  - `POST /newsletter/documents/:documentId/post-to-x`
  - `POST /newsletter/documents/:documentId/manual-posted`
  - `POST /newsletter/documents/:documentId/delete`
  - `POST /newsletter/documents/:documentId/rollback`

## 9) Design Notes and Constraints

- Local-first persistence:
  - relational data in SQLite via Prisma
  - newsletter documents in local JSON store
- Safety:
  - scraping respects robots checks in scrape connector
  - blocked/bot-protection signals are detected and persisted
- Deterministic source traceability:
  - citation tokens (`[A1]`, `[A2]`, ...) are preserved and validated
- Polymorphic ingestion:
  - source type strategy (`rss/scrape/x/grok`) controlled by DB configuration
