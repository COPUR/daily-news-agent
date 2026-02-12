import { ArticleStatus, RunStatus, RunTrigger, SourceType, Topic } from "@prisma/client";

export type JsonRecord = Record<string, unknown>;

export interface ConnectorRecord {
  externalId?: string;
  title: string;
  url: string;
  publishedAt?: Date;
  author?: string;
  summary?: string;
  payload?: JsonRecord;
}

export interface ConnectorResult {
  records: ConnectorRecord[];
  warnings: string[];
  errors: string[];
  sourceConfigUpdates?: JsonRecord;
}

export interface PipelineOutcome {
  runId: string;
  status: RunStatus;
  itemsIngested: number;
  itemsNormalized: number;
  duplicatesCount: number;
  selectedCount: number;
  errorsCount: number;
  generatedPostId?: number;
}

export interface CitationReference {
  citation_id: string;
  article_id: number;
  url: string;
  title: string;
}

export interface CitationValidation {
  required_citations: string[];
  referenced_citations: string[];
  missing_citations: string[];
  orphan_citations: string[];
  linked_ratio: number;
  valid: boolean;
}

export interface DailyPostGenerated {
  headline: string;
  markdown: string;
  text: string;
  provider: string;
  promptSnapshot: JsonRecord;
  citationCatalog?: CitationReference[];
}

export interface NewsletterVariant {
  language: string;
  headline: string;
  content_markdown: string;
  content_text: string;
  tone: string;
  context_level: string;
  updated_at: string;
  post_status?: "draft" | "preauth" | "authorized" | "posted";
  approved_at?: string | null;
  posted_at?: string | null;
  citation_validation?: CitationValidation;
}

export interface NewsletterCollection {
  collection_id: string;
  news: JsonRecord[];
  language_variants: NewsletterVariant[];
  citation_catalog?: CitationReference[];
}

export interface NewsletterDocument {
  id: string;
  post_date: string;
  daily_post_id: number;
  pipeline_run_id: string;
  status: "draft" | "authorized" | "posted" | "manual_posted" | "deleted";
  created_at: string;
  updated_at: string;
  newsletter: {
    newsletter_id: string;
    news_collections: NewsletterCollection[];
  };
  x_publish: {
    posted: boolean;
    tweet_id?: string | null;
    url?: string | null;
    posted_at?: string | null;
    dedupe_key?: string | null;
    correlation_id?: string | null;
  };
  versions?: JsonRecord[];
  audit: JsonRecord[];
}

export { ArticleStatus, RunStatus, RunTrigger, SourceType, Topic };
