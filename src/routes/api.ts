import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { Router, type Request, type Response } from "express";
import {
  ArticleStatus,
  RunStatus,
  RunTrigger,
  SourceType,
  Topic,
  type Prisma,
} from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/client.js";
import { runPipeline } from "../services/pipeline.js";
import { parseJson, stringifyJson } from "../utils/json.js";
import { newsletterStore } from "../services/newsletterStore.js";
import { clearSecret, listConfig, listSecrets, setSecret, updateConfig } from "../services/runtimeAdmin.js";
import { schedulerStatus } from "../services/scheduler.js";

function parseArticle(article: any) {
  return {
    ...article,
    tagsJson: parseJson(article.tagsJson, []),
    entitiesJson: parseJson(article.entitiesJson, {}),
    extractedFactsJson: parseJson(article.extractedFactsJson, {}),
  };
}

function parseSource(source: any) {
  return {
    ...source,
    sourceType: source.sourceType,
    tagsJson: parseJson(source.tagsJson, []),
    configJson: parseJson(source.configJson, {}),
    authJson: parseJson(source.authJson, null),
  };
}

function httpError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error);
  const lower = message.toLowerCase();
  const code = lower.includes("not found") ? 404 : 400;
  return { code, message };
}

function sendError(reply: Response, error: unknown) {
  const e = httpError(error);
  return reply.status(e.code).json({ detail: e.message });
}

type HealthStatus = "ok" | "warn" | "fail" | "skip";

async function timedProbe<T>(fn: () => Promise<T>) {
  const startedAt = Date.now();
  try {
    const data = await fn();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      data,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

export function createApiRouter() {
  const router = Router();

  router.get("/health", (_, reply) => {
    reply.json({ status: "ok", app: "Daily News Agent Node (Express)", utcTime: new Date().toISOString() });
  });

  router.get("/health/verbose", async (request, reply) => {
    const startedAt = Date.now();
    const probe = !["0", "false", "no", "off"].includes(String(request.query.probe ?? "true").toLowerCase());
    const timeoutMs = Math.max(1000, Math.min(Number(request.query.timeoutMs ?? 5000), 20000));
    const checks: Array<{
      id: string;
      category: string;
      status: HealthStatus;
      configured?: boolean;
      latencyMs?: number;
      message: string;
      details?: unknown;
    }> = [];

    const addCheck = (entry: {
      id: string;
      category: string;
      status: HealthStatus;
      configured?: boolean;
      latencyMs?: number;
      message: string;
      details?: unknown;
    }) => {
      checks.push(entry);
    };

    const dbHealth = await timedProbe(async () => {
      await prisma.$queryRawUnsafe("SELECT 1");
      const [sources, articles, runs] = await Promise.all([
        prisma.source.count(),
        prisma.article.count(),
        prisma.pipelineRun.count(),
      ]);
      return { sources, articles, runs };
    });
    addCheck({
      id: "database.prisma",
      category: "storage",
      status: dbHealth.ok ? "ok" : "fail",
      latencyMs: dbHealth.latencyMs,
      configured: true,
      message: dbHealth.ok ? "Prisma/SQLite reachable" : "Database probe failed",
      details: dbHealth.ok ? dbHealth.data : { error: dbHealth.error },
    });

    const scheduler = schedulerStatus();
    addCheck({
      id: "scheduler.cron",
      category: "runtime",
      status: scheduler.running ? "ok" : "warn",
      configured: true,
      message: scheduler.running ? "Scheduler running" : "Scheduler not running",
      details: scheduler,
    });

    const newsletterPath = path.resolve(env.NEWSLETTER_NOSQL_PATH);
    const newsletterHealth = await timedProbe(async () => {
      const latest = newsletterStore().latestDocument();
      const stat = fs.statSync(newsletterPath);
      return {
        path: newsletterPath,
        sizeBytes: stat.size,
        latestDocumentId: latest?.id ?? null,
        latestUpdatedAt: latest?.updated_at ?? null,
      };
    });
    addCheck({
      id: "storage.newsletter_nosql",
      category: "storage",
      status: newsletterHealth.ok ? "ok" : "fail",
      configured: true,
      latencyMs: newsletterHealth.latencyMs,
      message: newsletterHealth.ok ? "Newsletter store readable" : "Newsletter store unavailable",
      details: newsletterHealth.ok ? newsletterHealth.data : { path: newsletterPath, error: newsletterHealth.error },
    });

    const sourceDistribution = await timedProbe(async () => {
      const sources = await prisma.source.findMany({
        select: { sourceType: true, enabled: true, lastFetchedAt: true, pollingMinutes: true, name: true },
        orderBy: { id: "asc" },
      });
      const byType: Record<string, { total: number; enabled: number }> = {};
      for (const source of sources) {
        const key = source.sourceType;
        if (!byType[key]) {
          byType[key] = { total: 0, enabled: 0 };
        }
        byType[key].total += 1;
        if (source.enabled) byType[key].enabled += 1;
      }
      return { total: sources.length, byType };
    });
    addCheck({
      id: "connectors.sources",
      category: "connectors",
      status: sourceDistribution.ok ? "ok" : "warn",
      configured: true,
      latencyMs: sourceDistribution.latencyMs,
      message: sourceDistribution.ok ? "Source connectors loaded from DB" : "Source connector overview unavailable",
      details: sourceDistribution.ok ? sourceDistribution.data : { error: sourceDistribution.error },
    });

    const latestRun = await timedProbe(async () => prisma.pipelineRun.findFirst({ orderBy: { startedAt: "desc" } }));
    addCheck({
      id: "pipeline.latest_run",
      category: "pipeline",
      status: latestRun.ok ? "ok" : "warn",
      configured: true,
      latencyMs: latestRun.latencyMs,
      message: latestRun.ok ? "Latest pipeline run resolved" : "Could not load latest pipeline run",
      details: latestRun.ok
        ? {
          runId: latestRun.data?.id ?? null,
          status: latestRun.data?.status ?? null,
          startedAt: latestRun.data?.startedAt ?? null,
          finishedAt: latestRun.data?.finishedAt ?? null,
        }
        : { error: latestRun.error },
    });

    const openAiConfigured = Boolean(env.OPENAI_API_KEY);
    if (openAiConfigured && probe) {
      const openAiProbe = await timedProbe(async () => {
        const response = await axios.get("https://api.openai.com/v1/models", {
          timeout: timeoutMs,
          headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
        });
        return { reachable: true, modelsCount: Array.isArray(response.data?.data) ? response.data.data.length : null };
      });
      addCheck({
        id: "llm.openai",
        category: "llm",
        status: openAiProbe.ok ? "ok" : env.LLM_PROVIDER === "openai" ? "fail" : "warn",
        configured: true,
        latencyMs: openAiProbe.latencyMs,
        message: openAiProbe.ok ? "OpenAI API reachable" : "OpenAI probe failed",
        details: openAiProbe.ok ? openAiProbe.data : { error: openAiProbe.error },
      });
    } else {
      addCheck({
        id: "llm.openai",
        category: "llm",
        status: openAiConfigured ? "skip" : "warn",
        configured: openAiConfigured,
        message: openAiConfigured ? "OpenAI configured; probe skipped" : "OpenAI API key not configured",
      });
    }

    const xaiConfigured = Boolean(env.XAI_API_KEY);
    if (xaiConfigured && probe) {
      const xaiProbe = await timedProbe(async () => {
        const response = await axios.get(`${env.XAI_BASE_URL.replace(/\/$/, "")}/models`, {
          timeout: timeoutMs,
          headers: { Authorization: `Bearer ${env.XAI_API_KEY}` },
        });
        return { reachable: true, modelsCount: Array.isArray(response.data?.data) ? response.data.data.length : null };
      });
      addCheck({
        id: "llm.xai",
        category: "llm",
        status: xaiProbe.ok ? "ok" : env.LLM_PROVIDER === "xai" ? "fail" : "warn",
        configured: true,
        latencyMs: xaiProbe.latencyMs,
        message: xaiProbe.ok ? "xAI API reachable" : "xAI probe failed",
        details: xaiProbe.ok ? xaiProbe.data : { baseUrl: env.XAI_BASE_URL, error: xaiProbe.error },
      });
    } else {
      addCheck({
        id: "llm.xai",
        category: "llm",
        status: xaiConfigured ? "skip" : "warn",
        configured: xaiConfigured,
        message: xaiConfigured ? "xAI configured; probe skipped" : "XAI_API_KEY not configured",
      });
    }

    const hfConfigured = Boolean(env.HUGGINGFACE_API_KEY);
    if (hfConfigured && probe) {
      const hfProbe = await timedProbe(async () => {
        const [whoami, modelInfo] = await Promise.all([
          axios.get("https://huggingface.co/api/whoami-v2", {
            timeout: timeoutMs,
            headers: { Authorization: `Bearer ${env.HUGGINGFACE_API_KEY}` },
          }),
          axios.get(`https://huggingface.co/api/models/${env.HUGGINGFACE_MODEL_ID}?expand=inferenceProviderMapping`, {
            timeout: timeoutMs,
          }),
        ]);
        const mapping = modelInfo.data?.inferenceProviderMapping || {};
        return {
          whoami: whoami.data?.name ?? null,
          modelId: env.HUGGINGFACE_MODEL_ID,
          providers: Object.keys(mapping),
        };
      });
      addCheck({
        id: "llm.huggingface",
        category: "llm",
        status: hfProbe.ok ? "ok" : env.LLM_PROVIDER === "huggingface" ? "fail" : "warn",
        configured: true,
        latencyMs: hfProbe.latencyMs,
        message: hfProbe.ok ? "Hugging Face reachable and token valid" : "Hugging Face probe failed",
        details: hfProbe.ok ? hfProbe.data : { modelId: env.HUGGINGFACE_MODEL_ID, error: hfProbe.error },
      });
    } else {
      addCheck({
        id: "llm.huggingface",
        category: "llm",
        status: hfConfigured ? "skip" : "warn",
        configured: hfConfigured,
        message: hfConfigured ? "Hugging Face configured; probe skipped" : "HUGGINGFACE_API_KEY not configured",
        details: { modelId: env.HUGGINGFACE_MODEL_ID },
      });
    }

    const ollamaConfigured = Boolean(env.OLLAMA_BASE_URL);
    if (ollamaConfigured && probe) {
      const ollamaProbe = await timedProbe(async () => {
        const response = await axios.get(`${env.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/tags`, { timeout: timeoutMs });
        return {
          reachable: true,
          modelsCount: Array.isArray(response.data?.models) ? response.data.models.length : null,
        };
      });
      addCheck({
        id: "llm.ollama",
        category: "llm",
        status: ollamaProbe.ok ? "ok" : env.LLM_PROVIDER === "ollama" ? "fail" : "warn",
        configured: true,
        latencyMs: ollamaProbe.latencyMs,
        message: ollamaProbe.ok ? "Ollama reachable" : "Ollama probe failed",
        details: ollamaProbe.ok ? ollamaProbe.data : { baseUrl: env.OLLAMA_BASE_URL, error: ollamaProbe.error },
      });
    } else {
      addCheck({
        id: "llm.ollama",
        category: "llm",
        status: "warn",
        configured: false,
        message: "OLLAMA_BASE_URL not configured",
      });
    }

    const xReadConfigured = Boolean(env.TWITTER_BEARER_TOKEN);
    if (xReadConfigured && probe) {
      const xReadProbe = await timedProbe(async () => {
        const response = await axios.get("https://api.twitter.com/2/users/me", {
          timeout: timeoutMs,
          headers: { Authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}` },
        });
        return {
          reachable: true,
          userId: response.data?.data?.id ?? null,
          username: response.data?.data?.username ?? null,
        };
      });
      addCheck({
        id: "integration.x.read",
        category: "integration",
        status: xReadProbe.ok ? "ok" : "warn",
        configured: true,
        latencyMs: xReadProbe.latencyMs,
        message: xReadProbe.ok ? "X read API reachable" : "X read probe failed",
        details: xReadProbe.ok ? xReadProbe.data : { error: xReadProbe.error },
      });
    } else {
      addCheck({
        id: "integration.x.read",
        category: "integration",
        status: xReadConfigured ? "skip" : "warn",
        configured: xReadConfigured,
        message: xReadConfigured ? "X read configured; probe skipped" : "TWITTER_BEARER_TOKEN not configured",
      });
    }

    const xPostConfigured = Boolean(
      env.TWITTER_API_KEY
      && env.TWITTER_API_SECRET
      && env.TWITTER_ACCESS_TOKEN
      && env.TWITTER_ACCESS_TOKEN_SECRET
      && env.TWITTER_BEARER_TOKEN,
    );
    addCheck({
      id: "integration.x.post",
      category: "integration",
      status: xPostConfigured ? "ok" : "warn",
      configured: xPostConfigured,
      message: xPostConfigured
        ? "X posting credentials configured"
        : "X posting credentials missing (API key/secret, access token/secret, bearer token)",
      details: { postHandle: env.TWITTER_POST_HANDLE || null },
    });

    const serperConfigured = Boolean(env.SERPER_API_KEY);
    addCheck({
      id: "integration.serper",
      category: "integration",
      status: serperConfigured ? "skip" : "warn",
      configured: serperConfigured,
      message: serperConfigured
        ? "Serper key configured; live probe intentionally skipped to avoid billable query"
        : "SERPER_API_KEY not configured",
      details: { endpoint: env.SERPER_ENDPOINT },
    });

    const providerStatus =
      checks.some((item) => item.status === "fail")
        ? "fail"
        : checks.some((item) => item.status === "warn")
          ? "warn"
          : "ok";

    reply.json({
      status: providerStatus,
      app: "Daily News Agent Node (Express)",
      utcTime: new Date().toISOString(),
      probeEnabled: probe,
      timeoutMs,
      activeLlmProvider: env.LLM_PROVIDER,
      durationMs: Date.now() - startedAt,
      summary: {
        total: checks.length,
        ok: checks.filter((item) => item.status === "ok").length,
        warn: checks.filter((item) => item.status === "warn").length,
        fail: checks.filter((item) => item.status === "fail").length,
        skip: checks.filter((item) => item.status === "skip").length,
      },
      checks,
    });
  });

  router.get("/system/config", (_, reply) => {
    reply.json(listConfig());
  });

  router.put("/system/config/:key", (request, reply) => {
    try {
      reply.json(updateConfig(request.params.key, String(request.body?.value ?? "")));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.get("/system/secrets", (_, reply) => {
    reply.json(listSecrets());
  });

  router.put("/system/secrets/:key", (request, reply) => {
    try {
      reply.json(setSecret(request.params.key, String(request.body?.value ?? "")));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.delete("/system/secrets/:key", (request, reply) => {
    try {
      reply.json(clearSecret(request.params.key));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.get("/sources", async (_, reply) => {
    const rows = await prisma.source.findMany({ orderBy: { id: "asc" } });
    reply.json(rows.map(parseSource));
  });

  router.get("/sources/health", async (request, reply) => {
    const window = Math.max(5, Math.min(Number(request.query.window ?? 50), 500));
    const sources = await prisma.source.findMany({ orderBy: { id: "asc" } });

    const output = [];
    for (const source of sources) {
      const logs = await prisma.pipelineLog.findMany({
        where: { sourceId: source.id, step: "ingestion" },
        orderBy: { ts: "desc" },
        take: window,
      });

      const successCount = logs.filter((item) => item.level === "info" && item.message.startsWith("Source ingested")).length;
      const skippedCount = logs.filter((item) => item.level === "info" && item.message.startsWith("Source skipped")).length;
      const warningCount = logs.filter((item) => item.level === "warning").length;
      const errors = logs.filter((item) => item.level === "error");
      const errorCount = errors.length;

      output.push({
        sourceId: source.id,
        sourceName: source.name,
        enabled: source.enabled,
        lastFetchedAt: source.lastFetchedAt,
        pollingMinutes: source.pollingMinutes,
        successCount,
        skippedCount,
        warningCount,
        errorCount,
        successRate: successCount + errorCount > 0 ? Number((successCount / (successCount + errorCount)).toFixed(4)) : null,
        lastError: errors[0]?.message ?? null,
      });
    }

    reply.json(output);
  });

  router.post("/sources", async (request, reply) => {
    const payload = request.body as any;
    const existing = await prisma.source.findUnique({ where: { name: payload.name } });
    if (existing) {
      return reply.status(409).json({ detail: "Source name already exists" });
    }

    const created = await prisma.source.create({
      data: {
        sourceType: payload.sourceType as SourceType,
        name: payload.name,
        enabled: Boolean(payload.enabled ?? true),
        pollingMinutes: Number(payload.pollingMinutes ?? 1440),
        tagsJson: stringifyJson(payload.tagsJson ?? []),
        configJson: stringifyJson(payload.configJson ?? {}),
        authJson: payload.authJson ? stringifyJson(payload.authJson) : null,
      },
    });
    reply.json(parseSource(created));
  });

  router.put("/sources/:sourceId", async (request, reply) => {
    const sourceId = Number(request.params.sourceId);
    const source = await prisma.source.findUnique({ where: { id: sourceId } });
    if (!source) {
      return reply.status(404).json({ detail: "Source not found" });
    }

    const payload = request.body as any;
    const updated = await prisma.source.update({
      where: { id: sourceId },
      data: {
        sourceType: payload.sourceType ?? source.sourceType,
        name: payload.name ?? source.name,
        enabled: payload.enabled ?? source.enabled,
        pollingMinutes: payload.pollingMinutes ?? source.pollingMinutes,
        tagsJson: payload.tagsJson ? stringifyJson(payload.tagsJson) : source.tagsJson,
        configJson: payload.configJson ? stringifyJson(payload.configJson) : source.configJson,
        authJson: payload.authJson !== undefined ? stringifyJson(payload.authJson) : source.authJson,
      },
    });
    reply.json(parseSource(updated));
  });

  router.post("/sources/:sourceId/toggle", async (request, reply) => {
    const sourceId = Number(request.params.sourceId);
    const source = await prisma.source.findUnique({ where: { id: sourceId } });
    if (!source) {
      return reply.status(404).json({ detail: "Source not found" });
    }

    const enabled = ["true", "1", "yes"].includes(String(request.query.enabled ?? "").toLowerCase());
    const updated = await prisma.source.update({ where: { id: sourceId }, data: { enabled } });
    reply.json(parseSource(updated));
  });

  router.delete("/sources/:sourceId", async (request, reply) => {
    const sourceId = Number(request.params.sourceId);
    const source = await prisma.source.findUnique({ where: { id: sourceId } });
    if (!source) {
      return reply.status(404).json({ detail: "Source not found" });
    }

    await prisma.source.delete({ where: { id: sourceId } });
    reply.json({ deleted: true, sourceId });
  });

  router.get("/articles/page", async (request, reply) => {
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 100), 500));
    const offset = Math.max(0, Number(request.query.offset ?? 0));

    const where: Prisma.ArticleWhereInput = {};
    if (request.query.topic) {
      where.topic = request.query.topic as Topic;
    }
    if (request.query.status) {
      where.status = request.query.status as ArticleStatus;
    }
    if (request.query.search) {
      where.OR = [
        { title: { contains: String(request.query.search) } },
        { url: { contains: String(request.query.search) } },
      ];
    }
    if (request.query.sourceId) {
      where.sourceId = Number(request.query.sourceId);
    }

    const [rows, total] = await Promise.all([
      prisma.article.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
      prisma.article.count({ where }),
    ]);

    reply.json({
      items: rows.map(parseArticle),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  });

  router.patch("/articles/:articleId/status", async (request, reply) => {
    const articleId = Number(request.params.articleId);
    const row = await prisma.article.findUnique({ where: { id: articleId } });
    if (!row) return reply.status(404).json({ detail: "Article not found" });

    const status = (request.body as any)?.status as ArticleStatus;
    const updated = await prisma.article.update({ where: { id: articleId }, data: { status } });
    reply.json(parseArticle(updated));
  });

  router.get("/clusters/:clusterId", async (request, reply) => {
    const clusterId = Number(request.params.clusterId);
    const cluster = await prisma.dedupCluster.findUnique({ where: { id: clusterId } });
    if (!cluster) return reply.status(404).json({ detail: "Cluster not found" });

    const articles = await prisma.article.findMany({ where: { clusterId }, orderBy: { id: "asc" }, select: { id: true } });
    reply.json({
      clusterId: cluster.id,
      primaryArticleId: cluster.primaryArticleId,
      articleIds: articles.map((item) => item.id),
    });
  });

  router.post("/pipeline/run", async (request, reply) => {
    const body = (request.body ?? {}) as { forcePost?: boolean; outputLanguage?: "en" | "tr" };
    const outcome = await runPipeline({
      trigger: RunTrigger.api,
      forcePost: Boolean(body.forcePost),
      outputLanguage: body.outputLanguage,
    });
    reply.json(outcome);
  });

  router.post("/pipeline/run/async", async (request, reply) => {
    const body = (request.body ?? {}) as { forcePost?: boolean; outputLanguage?: "en" | "tr" };
    const runId = crypto.randomUUID();
    runPipeline({
      trigger: RunTrigger.api,
      forcePost: Boolean(body.forcePost),
      outputLanguage: body.outputLanguage,
      runId,
    }).catch(() => null);

    reply.json({
      runId,
      status: "running",
      itemsIngested: 0,
      itemsNormalized: 0,
      duplicatesCount: 0,
      selectedCount: 0,
      errorsCount: 0,
      generatedPostId: null,
    });
  });

  router.get("/pipeline/runs/page", async (request, reply) => {
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 50), 200));
    const offset = Math.max(0, Number(request.query.offset ?? 0));

    const [rows, total] = await Promise.all([
      prisma.pipelineRun.findMany({ orderBy: { startedAt: "desc" }, take: limit, skip: offset }),
      prisma.pipelineRun.count(),
    ]);

    reply.json({
      items: rows.map((item) => ({ ...item, summaryJson: parseJson(item.summaryJson, {}) })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  });

  router.get("/pipeline/runs/:runId/logs/page", async (request, reply) => {
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 200), 2000));
    const offset = Math.max(0, Number(request.query.offset ?? 0));
    const where: Prisma.PipelineLogWhereInput = { runId: request.params.runId };
    if (request.query.level) where.level = String(request.query.level);

    const [rows, total] = await Promise.all([
      prisma.pipelineLog.findMany({ where, orderBy: { ts: "asc" }, take: limit, skip: offset }),
      prisma.pipelineLog.count({ where }),
    ]);

    reply.json({
      items: rows.map((row) => ({ ...row, payloadJson: parseJson(row.payloadJson, null) })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  });

  router.get("/system/logs/recent", async (request, reply) => {
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 200), 2000));
    const where: Prisma.PipelineLogWhereInput = {};
    if (request.query.level) where.level = String(request.query.level);
    const rows = await prisma.pipelineLog.findMany({ where, orderBy: { ts: "desc" }, take: limit });
    reply.json(rows.map((row) => ({ ...row, payloadJson: parseJson(row.payloadJson, null) })));
  });

  router.get("/system/metrics", async (request, reply) => {
    const days = Math.max(1, Math.min(Number(request.query.days ?? 14), 90));
    const cutoff = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);

    const [articles, runs, logs] = await Promise.all([
      prisma.article.findMany({ where: { createdAt: { gte: cutoff } }, select: { createdAt: true, topic: true, status: true } }),
      prisma.pipelineRun.findMany({ where: { startedAt: { gte: cutoff } }, select: { startedAt: true, status: true, summaryJson: true } }),
      prisma.pipelineLog.findMany({ where: { ts: { gte: cutoff } }, select: { level: true } }),
    ]);

    const byDay = new Map<string, { articles: number; success: number; failed: number }>();
    const topicDist = new Map<string, number>();
    const statusDist = new Map<string, number>();
    const levelDist = new Map<string, number>();

    for (let idx = 0; idx < days; idx += 1) {
      const day = new Date(cutoff.getTime() + idx * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      byDay.set(day, { articles: 0, success: 0, failed: 0 });
    }

    for (const article of articles) {
      const day = article.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(day);
      if (bucket) bucket.articles += 1;
      topicDist.set(article.topic, (topicDist.get(article.topic) ?? 0) + 1);
      statusDist.set(article.status, (statusDist.get(article.status) ?? 0) + 1);
    }

    let recoveredSteps = 0;
    let failedSteps = 0;
    let totalRetryAttempts = 0;

    for (const run of runs) {
      const day = run.startedAt.toISOString().slice(0, 10);
      const bucket = byDay.get(day);
      if (bucket) {
        if (run.status === RunStatus.success) bucket.success += 1;
        else bucket.failed += 1;
      }

      const summary = parseJson<any>(run.summaryJson, {});
      const recovery = summary.recovery || {};
      recoveredSteps += Number(recovery.recoveredSteps || 0);
      failedSteps += Number(recovery.failedSteps || 0);
      totalRetryAttempts += Number(recovery.totalRetryAttempts || 0);
    }

    for (const log of logs) {
      levelDist.set(log.level, (levelDist.get(log.level) ?? 0) + 1);
    }

    reply.json({
      days,
      articlesByDay: [...byDay.entries()].map(([label, value]) => ({ label, value: value.articles })),
      runsByDay: [...byDay.entries()].map(([label, value]) => ({ label, success: value.success, failed: value.failed })),
      topicDistribution: [...topicDist.entries()].map(([label, value]) => ({ label, value })),
      statusDistribution: [...statusDist.entries()].map(([label, value]) => ({ label, value })),
      logLevelDistribution: [...levelDist.entries()].map(([label, value]) => ({ label, value })),
      recovery: {
        recoveredSteps,
        failedSteps,
        totalRetryAttempts,
      },
    });
  });

  router.get("/system/recovery", async (request, reply) => {
    const days = Math.max(1, Math.min(Number(request.query.days ?? 14), 90));
    const cutoff = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
    const runs = await prisma.pipelineRun.findMany({ where: { startedAt: { gte: cutoff } }, select: { summaryJson: true } });

    let recoveredSteps = 0;
    let failedSteps = 0;
    let totalRetryAttempts = 0;
    const byStep = new Map<string, { recoveredCount: number; failedCount: number; retryAttempts: number }>();

    for (const run of runs) {
      const summary = parseJson<any>(run.summaryJson, {});
      const recovery = summary.recovery || {};
      recoveredSteps += Number(recovery.recoveredSteps || 0);
      failedSteps += Number(recovery.failedSteps || 0);
      totalRetryAttempts += Number(recovery.totalRetryAttempts || 0);

      const events = Array.isArray(recovery.events) ? recovery.events : [];
      for (const event of events) {
        const step = String(event.step || "unknown");
        const item = byStep.get(step) ?? { recoveredCount: 0, failedCount: 0, retryAttempts: 0 };
        const attempts = Number(event.attempts || 1);
        item.retryAttempts += Math.max(0, attempts - 1);
        if (event.status === "recovered") item.recoveredCount += 1;
        if (event.status === "failed") item.failedCount += 1;
        byStep.set(step, item);
      }
    }

    reply.json({
      days,
      recoveredSteps,
      failedSteps,
      totalRetryAttempts,
      byStep: [...byStep.entries()].map(([step, values]) => ({ step, ...values })),
    });
  });

  router.get("/posts/latest", async (_, reply) => {
    const post = await prisma.dailyPost.findFirst({ orderBy: { postDate: "desc" } });
    if (!post) return reply.json(null);

    const items = await prisma.dailyPostItem.findMany({ where: { postId: post.id }, orderBy: { position: "asc" } });
    reply.json({
      ...post,
      metadataJson: parseJson(post.metadataJson, {}),
      items,
    });
  });

  router.get("/posts/:postDate", async (request, reply) => {
    const post = await prisma.dailyPost.findUnique({ where: { postDate: request.params.postDate } });
    if (!post) return reply.status(404).json({ detail: "Post not found" });

    const items = await prisma.dailyPostItem.findMany({ where: { postId: post.id }, orderBy: { position: "asc" } });
    reply.json({
      ...post,
      metadataJson: parseJson(post.metadataJson, {}),
      items,
    });
  });

  router.get("/newsletter/documents/latest", (_, reply) => {
    reply.json(newsletterStore().latestDocument());
  });

  router.get("/newsletter/documents/page", (request, reply) => {
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 20), 200));
    const offset = Math.max(0, Number(request.query.offset ?? 0));
    const status = request.query.status ? String(request.query.status) : undefined;
    const { items, total } = newsletterStore().listDocuments(status, limit, offset);
    reply.json({ items, total, limit, offset, hasMore: offset + items.length < total });
  });

  router.get("/newsletter/documents/:documentId", (request, reply) => {
    const doc = newsletterStore().getDocument(request.params.documentId);
    if (!doc) return reply.status(404).json({ detail: "Newsletter document not found" });
    reply.json(doc);
  });

  router.get("/newsletter/documents/:documentId/versions", (request, reply) => {
    try {
      const limit = Math.max(1, Math.min(Number(request.query.limit ?? 20), 200));
      const offset = Math.max(0, Number(request.query.offset ?? 0));
      const { items, total } = newsletterStore().listVersions({
        documentId: request.params.documentId,
        collectionId: request.query.collectionId ? String(request.query.collectionId) : undefined,
        language: request.query.language ? String(request.query.language) : undefined,
        limit,
        offset,
      });
      reply.json({ items, total, limit, offset, hasMore: offset + items.length < total });
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.post("/newsletter/documents/:documentId/save-draft", (request, reply) => {
    try {
      const body = request.body as any;
      reply.json(newsletterStore().saveDraft({
        documentId: request.params.documentId,
        collectionId: body.collectionId,
        language: body.language,
        headline: body.headline,
        contentMarkdown: body.contentMarkdown,
        contentText: body.contentText,
        tone: body.tone,
        contextLevel: body.contextLevel,
        note: body.note,
      }));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.post("/newsletter/documents/:documentId/refine", async (request, reply) => {
    try {
      const body = request.body as any;
      reply.json(await newsletterStore().refineWithChatbot({
        documentId: request.params.documentId,
        collectionId: body.collectionId,
        sourceLanguage: body.sourceLanguage,
        targetLanguage: body.targetLanguage,
        tone: body.tone,
        contextLevel: body.contextLevel,
        userInstruction: body.userInstruction,
      }));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.post("/newsletter/documents/:documentId/authorize", (request, reply) => {
    try {
      const body = request.body as any;
      reply.json(
        newsletterStore().authorize(
          request.params.documentId,
          body?.note,
          body?.collectionId || body?.language
            ? {
              collectionId: body?.collectionId ? String(body.collectionId) : undefined,
              language: body?.language ? String(body.language) : undefined,
            }
            : undefined,
        ),
      );
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.post("/newsletter/documents/:documentId/post-to-x", async (request, reply) => {
    try {
      const body = request.body as any;
      reply.json(await newsletterStore().postDocumentToX({
        documentId: request.params.documentId,
        collectionId: body.collectionId,
        language: body.language,
        note: body.note,
      }));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.post("/newsletter/documents/:documentId/manual-posted", (request, reply) => {
    try {
      reply.json(newsletterStore().markManualPosted(request.params.documentId, (request.body as any)?.note));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.post("/newsletter/documents/:documentId/delete", (request, reply) => {
    try {
      reply.json(newsletterStore().markDeleted(request.params.documentId, (request.body as any)?.note));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.post("/newsletter/documents/:documentId/rollback", (request, reply) => {
    try {
      const body = request.body as any;
      reply.json(newsletterStore().rollbackToVersion({
        documentId: request.params.documentId,
        versionId: body.versionId,
        note: body.note,
      }));
    } catch (error) {
      sendError(reply, error);
    }
  });

  router.get("/stats", async (_, reply) => {
    const [sources, articles, runs, duplicates] = await Promise.all([
      prisma.source.count(),
      prisma.article.count(),
      prisma.pipelineRun.count(),
      prisma.article.count({ where: { status: ArticleStatus.duplicate } }),
    ]);
    reply.json({ sources, articles, runs, duplicates });
  });

  router.use((error: unknown, _request: Request, reply: Response, _next: () => void) => {
    sendError(reply, error);
  });

  return router;
}
