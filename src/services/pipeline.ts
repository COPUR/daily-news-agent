import crypto from "node:crypto";
import {
  ArticleStatus,
  RunStatus,
  RunTrigger,
  SourceType,
  Topic,
  type Article,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../db/client.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { normalizeUrl, canonicalDomain } from "../utils/url.js";
import { stringifyJson, parseJson } from "../utils/json.js";
import { fetchRss } from "./connectors/rss.js";
import { fetchScrape } from "./connectors/scrape.js";
import { fetchX } from "./connectors/x.js";
import { fetchGrok } from "./connectors/grok.js";
import { enrichArticle } from "./enrichment.js";
import { deduplicateRecent } from "./dedup.js";
import { selectTopArticles, scoreArticle } from "./ranking.js";
import { generateDailyPost } from "./postGeneration.js";
import { newsletterStore } from "./newsletterStore.js";
import type { CitationReference, PipelineOutcome, JsonRecord } from "../types/domain.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function topicFromTags(tags: string[]): Topic {
  const set = new Set(tags.map((item) => item.toLowerCase()));
  if (["av", "autonomous", "self-driving", "otonom"].some((keyword) => set.has(keyword))) return Topic.AV;
  if (["vehicle software", "vehicle_software", "ota"].some((keyword) => set.has(keyword))) return Topic.VEHICLE_SOFTWARE;
  if (["bms", "battery management system", "batarya yönetim sistemi", "batarya yonetim sistemi"].some((keyword) => set.has(keyword))) return Topic.BMS;
  if (["battery", "batteries", "batarya"].some((keyword) => set.has(keyword))) return Topic.BATTERY;
  if (["sdv", "software-defined vehicle"].some((keyword) => set.has(keyword))) return Topic.SDV;
  if (["ev", "electric"].some((keyword) => set.has(keyword))) return Topic.EV;
  return Topic.OTHER;
}

function sourceIsDue(lastFetchedAt: Date | null, pollingMinutes: number): { due: boolean; nextDue?: Date } {
  if (pollingMinutes <= 0 || !lastFetchedAt) {
    return { due: true };
  }
  const nextDue = new Date(lastFetchedAt.getTime() + pollingMinutes * 60_000);
  return { due: Date.now() >= nextDue.getTime(), nextDue };
}

async function logStep(args: {
  runId: string;
  level: "info" | "warning" | "error";
  step: string;
  message: string;
  sourceId?: number;
  payload?: JsonRecord;
  durationMs?: number;
}) {
  const { runId, level, step, message, sourceId, payload, durationMs } = args;
  if (level === "warning") {
    logger.warn({ runId, step, sourceId, payload, durationMs, message }, "pipeline_step");
  } else {
    logger[level]({ runId, step, sourceId, payload, durationMs, message }, "pipeline_step");
  }

  await prisma.pipelineLog.create({
    data: {
      runId,
      level,
      step,
      sourceId: sourceId ?? null,
      message,
      payloadJson: payload ? stringifyJson(payload) : null,
      durationMs: durationMs ?? null,
    },
  });
}

async function ingestSources(runId: string) {
  const sources = await prisma.source.findMany({ where: { enabled: true }, orderBy: { id: "asc" } });
  let itemsIngested = 0;
  let errorsCount = 0;
  const sourceSummary: JsonRecord[] = [];

  for (const source of sources) {
    const started = Date.now();
    const config = parseJson<Record<string, unknown>>(source.configJson, {});
    const dueInfo = sourceIsDue(source.lastFetchedAt, source.pollingMinutes);
    if (!dueInfo.due) {
      await logStep({
        runId,
        level: "info",
        step: "ingestion",
        sourceId: source.id,
        message: `Source skipped: ${source.name}`,
        payload: {
          pollingMinutes: source.pollingMinutes,
          lastFetchedAt: source.lastFetchedAt?.toISOString() ?? null,
          nextDueAt: dueInfo.nextDue?.toISOString() ?? null,
        },
        durationMs: Date.now() - started,
      });
      sourceSummary.push({
        sourceId: source.id,
        sourceName: source.name,
        ingested: 0,
        errors: [],
        warnings: [],
        skipped: true,
      });
      continue;
    }

    let result;
    if (source.sourceType === SourceType.rss) {
      result = await fetchRss(config, source.name);
    } else if (source.sourceType === SourceType.scrape) {
      result = await fetchScrape(config, source.name);
    } else if (source.sourceType === SourceType.x) {
      result = await fetchX(config, source.name);
    } else if (source.sourceType === SourceType.grok) {
      result = await fetchGrok(config, source.name);
    } else {
      result = { records: [], warnings: [], errors: [`Unknown source type: ${source.sourceType}`] };
    }

    for (const record of result.records) {
      await prisma.rawItem.create({
        data: {
          sourceId: source.id,
          runId,
          externalId: record.externalId ?? null,
          title: record.title,
          url: record.url,
          normalizedUrl: normalizeUrl(record.url),
          publishedAt: record.publishedAt ?? null,
          author: record.author ?? null,
          summary: record.summary ?? null,
          rawPayload: stringifyJson(record.payload ?? {}),
        },
      });
      itemsIngested += 1;
    }

    errorsCount += result.errors.length;
    sourceSummary.push({
      sourceId: source.id,
      sourceName: source.name,
      ingested: result.records.length,
      warnings: result.warnings,
      errors: result.errors,
      skipped: false,
    });

    await prisma.source.update({
      where: { id: source.id },
      data: {
        lastFetchedAt: new Date(),
        configJson: stringifyJson({ ...config, ...(result.sourceConfigUpdates ?? {}) }),
      },
    });

    for (const warning of result.warnings) {
      await logStep({ runId, level: "warning", step: "ingestion", sourceId: source.id, message: warning });
    }
    for (const error of result.errors) {
      await logStep({ runId, level: "error", step: "ingestion", sourceId: source.id, message: error });
    }

    await logStep({
      runId,
      level: "info",
      step: "ingestion",
      sourceId: source.id,
      message: `Source ingested: ${source.name}`,
      payload: { records: result.records.length },
      durationMs: Date.now() - started,
    });

    await delay(Math.round(env.REQUEST_RATE_LIMIT_SECONDS * 1000));
  }

  return { itemsIngested, errorsCount, sources: sourceSummary };
}

async function normalizeRawItems(runId: string) {
  const raws = await prisma.rawItem.findMany({ where: { runId }, orderBy: { id: "asc" } });
  let created = 0;

  for (const raw of raws) {
    const source = await prisma.source.findUnique({ where: { id: raw.sourceId } });
    const tags = source ? parseJson<string[]>(source.tagsJson, []) : [];

    await prisma.article.create({
      data: {
        sourceId: raw.sourceId,
        rawItemId: raw.id,
        title: raw.title,
        url: raw.url,
        normalizedUrl: raw.normalizedUrl,
        canonicalDomain: canonicalDomain(raw.normalizedUrl),
        publishedAt: raw.publishedAt,
        author: raw.author,
        summary: raw.summary,
        language: "en",
        tagsJson: stringifyJson(tags),
        topic: topicFromTags(tags),
        status: ArticleStatus.new,
      },
    });
    created += 1;
  }

  return created;
}

async function enrichArticles(runId: string) {
  const articles = await prisma.article.findMany({
    where: { rawItem: { runId } },
    orderBy: { id: "asc" },
    take: 30,
  });

  for (const article of articles) {
    await enrichArticle(article.id);
  }
}

function buildCitationCatalogFromArticles(items: Article[]): CitationReference[] {
  return items.map((item, idx) => ({
    citation_id: `A${idx + 1}`,
    article_id: item.id,
    url: item.url,
    title: item.title,
  }));
}

function serializeSelectedNews(items: Article[], citationCatalog: CitationReference[]) {
  const citationByArticleId = new Map<number, string>(
    citationCatalog.map((item) => [item.article_id, item.citation_id]),
  );
  return items.map((item) => ({
    article_id: item.id,
    citation_id: citationByArticleId.get(item.id) ?? null,
    title: item.title,
    url: item.url,
    summary: item.summary || item.fullText || "",
    topic: item.topic,
    language: item.language,
    published_at: item.publishedAt?.toISOString() ?? null,
  }));
}

async function rankAndGeneratePost(args: {
  runId: string;
  forcePost: boolean;
  outputLanguage?: "en" | "tr";
}) {
  const now = new Date();
  const postDate = now.toISOString().slice(0, 10);
  const language = args.outputLanguage || env.DAILY_POST_LANGUAGE;

  const existingPost = await prisma.dailyPost.findUnique({ where: { postDate } });
  if (existingPost && !args.forcePost) {
    const existingMetadata = parseJson<Record<string, unknown>>(existingPost.metadataJson, {});
    const existingItems = await prisma.dailyPostItem.findMany({ where: { postId: existingPost.id }, orderBy: { position: "asc" } });
    const selected: Article[] = [];
    for (const item of existingItems) {
      const article = await prisma.article.findUnique({ where: { id: item.articleId } });
      if (article) selected.push(article);
    }
    const fallbackCatalog = buildCitationCatalogFromArticles(selected);
    const existingCatalogRaw = Array.isArray(existingMetadata.citation_catalog)
      ? (existingMetadata.citation_catalog as CitationReference[])
      : [];
    const citationCatalog = existingCatalogRaw.length
      ? existingCatalogRaw.map((item, idx) => ({
          citation_id: item.citation_id || `A${idx + 1}`,
          article_id: Number(item.article_id),
          url: item.url,
          title: item.title,
        }))
      : fallbackCatalog;

    newsletterStore().upsertPipelineDraft({
      runId: args.runId,
      postDate,
      dailyPostId: existingPost.id,
      outputLanguage: language,
      headline: existingPost.headline,
      contentMarkdown: existingPost.contentMarkdown,
      contentText: existingPost.contentText,
      selectedNews: serializeSelectedNews(selected, citationCatalog),
      citationCatalog,
    });

    return { selected: [], generatedPostId: existingPost.id };
  }

  const horizon = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const articles = await prisma.article.findMany({
    where: {
      status: { not: ArticleStatus.ignored },
      OR: [{ publishedAt: null }, { publishedAt: { gte: horizon } }],
    },
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
  });

  const clusters = await prisma.dedupCluster.findMany();
  const clusterPrimary = new Map<number, number | null>(clusters.map((cluster) => [cluster.id, cluster.primaryArticleId]));
  const clusterSizes = new Map<number, number>();

  for (const article of articles) {
    if (!article.clusterId) {
      clusterSizes.set(article.id, 1);
    } else {
      clusterSizes.set(article.clusterId, (clusterSizes.get(article.clusterId) ?? 0) + 1);
    }
  }

  const primaryArticles = articles.filter((article) => {
    if (!article.clusterId) return true;
    return clusterPrimary.get(article.clusterId) === article.id;
  });

  const articleClusterSizes = new Map<number, number>();
  for (const article of primaryArticles) {
    if (!article.clusterId) {
      articleClusterSizes.set(article.id, 1);
    } else {
      articleClusterSizes.set(article.id, clusterSizes.get(article.clusterId) ?? 1);
    }
  }

  const selected = selectTopArticles(
    primaryArticles,
    articleClusterSizes,
    env.DAILY_ITEMS_MIN,
    env.DAILY_ITEMS_MAX,
    env.DAILY_ITEMS,
  );

  if (!selected.length) {
    return { selected: [], generatedPostId: undefined };
  }

  if (existingPost && args.forcePost) {
    await prisma.dailyPost.delete({ where: { id: existingPost.id } });
  }

  for (const article of selected) {
    await prisma.article.update({
      where: { id: article.id },
      data: { relevanceScore: scoreArticle(article, articleClusterSizes.get(article.id) ?? 1) },
    });
  }

  const generated = await generateDailyPost(selected, language);
  const citationCatalog = generated.citationCatalog?.length
    ? generated.citationCatalog
    : buildCitationCatalogFromArticles(selected);

  const dailyPost = await prisma.dailyPost.create({
    data: {
      postDate,
      headline: generated.headline,
      contentMarkdown: generated.markdown,
      contentText: generated.text,
      generatedBy: generated.provider,
      metadataJson: stringifyJson({
        run_id: args.runId,
        selected_article_ids: selected.map((item) => item.id),
        output_language: language,
        citation_catalog: citationCatalog,
        prompt_snapshot: generated.promptSnapshot,
      }),
    },
  });

  for (let idx = 0; idx < selected.length; idx += 1) {
    const article = selected[idx];
    await prisma.article.update({ where: { id: article.id }, data: { status: ArticleStatus.selected } });
    await prisma.dailyPostItem.create({
      data: {
        postId: dailyPost.id,
        articleId: article.id,
        position: idx + 1,
        rationale: `rank=${scoreArticle(article, articleClusterSizes.get(article.id) ?? 1)}`,
      },
    });
  }

  newsletterStore().upsertPipelineDraft({
    runId: args.runId,
    postDate,
    dailyPostId: dailyPost.id,
    outputLanguage: language,
    headline: dailyPost.headline,
    contentMarkdown: dailyPost.contentMarkdown,
    contentText: dailyPost.contentText,
    selectedNews: serializeSelectedNews(selected, citationCatalog),
    citationCatalog,
  });

  return { selected, generatedPostId: dailyPost.id };
}

export async function runPipeline(options?: {
  trigger?: RunTrigger;
  forcePost?: boolean;
  outputLanguage?: "en" | "tr";
  runId?: string;
}): Promise<PipelineOutcome> {
  const runId = options?.runId || crypto.randomUUID();
  const trigger = options?.trigger || RunTrigger.manual;
  const startedAt = new Date();

  await prisma.pipelineRun.create({
    data: {
      id: runId,
      trigger,
      status: RunStatus.running,
      startedAt,
    },
  });

  let ingest = { itemsIngested: 0, errorsCount: 0, sources: [] as JsonRecord[] };
  let itemsNormalized = 0;
  let duplicatesCount = 0;
  let selected: Article[] = [];
  let generatedPostId: number | undefined;
  let runError: string | null = null;

  try {
    const ingestStart = Date.now();
    ingest = await ingestSources(runId);
    await logStep({ runId, level: "info", step: "ingestion", message: "Ingestion completed", durationMs: Date.now() - ingestStart, payload: ingest as unknown as JsonRecord });

    const normalizeStart = Date.now();
    itemsNormalized = await normalizeRawItems(runId);
    await logStep({ runId, level: "info", step: "normalization", message: "Normalization completed", durationMs: Date.now() - normalizeStart, payload: { itemsNormalized } });

    const enrichStart = Date.now();
    await enrichArticles(runId);
    await logStep({ runId, level: "info", step: "enrichment", message: "Enrichment completed", durationMs: Date.now() - enrichStart });

    const dedupStart = Date.now();
    duplicatesCount = await deduplicateRecent(3);
    await logStep({ runId, level: "info", step: "dedup", message: "Dedup completed", durationMs: Date.now() - dedupStart, payload: { duplicatesCount } });

    const rankingStart = Date.now();
    const ranked = await rankAndGeneratePost({
      runId,
      forcePost: Boolean(options?.forcePost),
      outputLanguage: options?.outputLanguage,
    });
    selected = ranked.selected;
    generatedPostId = ranked.generatedPostId;
    await logStep({
      runId,
      level: "info",
      step: "post_generation",
      message: "Post generation completed",
      durationMs: Date.now() - rankingStart,
      payload: { selectedCount: selected.length, generatedPostId },
    });
  } catch (error) {
    runError = String(error);
    await logStep({ runId, level: "error", step: "run", message: "Pipeline failed", payload: { error: runError } });
  }

  const finishedAt = new Date();
  const status = runError ? RunStatus.failed : RunStatus.success;
  await prisma.pipelineRun.update({
    where: { id: runId },
    data: {
      status,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      itemsIngested: ingest.itemsIngested,
      itemsNormalized,
      duplicatesCount,
      errorsCount: ingest.errorsCount + (runError ? 1 : 0),
      selectedCount: selected.length,
      summaryJson: stringifyJson({
        sources: ingest.sources,
        generatedPostId,
        error: runError,
        outputLanguage: options?.outputLanguage || env.DAILY_POST_LANGUAGE,
      }),
    },
  });

  return {
    runId,
    status,
    itemsIngested: ingest.itemsIngested,
    itemsNormalized,
    duplicatesCount,
    selectedCount: selected.length,
    errorsCount: ingest.errorsCount + (runError ? 1 : 0),
    generatedPostId,
  };
}
