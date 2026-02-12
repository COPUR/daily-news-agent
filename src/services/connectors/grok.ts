import axios from "axios";
import { env } from "../../config/env.js";
import type { ConnectorResult } from "../../types/domain.js";

interface GrokItem {
  title: string;
  url: string;
  summary?: string;
  published_at?: string;
}

export async function fetchGrok(
  sourceConfig: Record<string, unknown>,
  sourceName: string,
): Promise<ConnectorResult> {
  if (!env.XAI_API_KEY) {
    return {
      records: [],
      warnings: ["Grok connector disabled: XAI_API_KEY not configured"],
      errors: [],
    };
  }

  const query = String(sourceConfig.query ?? "EV SDV battery news").trim();
  const limit = Number(sourceConfig.limit ?? 10);

  const prompt = `Return latest EV/SDV/Battery news links as strict JSON array. Fields: title,url,summary,published_at. Query: ${query}. Limit: ${Math.max(1, Math.min(limit, 15))}`;

  try {
    const response = await axios.post(
      `${env.XAI_BASE_URL.replace(/\/$/, "")}/chat/completions`,
      {
        model: env.XAI_MODEL,
        temperature: 0.1,
        messages: [{ role: "user", content: prompt }],
      },
      {
        timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
        headers: {
          Authorization: `Bearer ${env.XAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    const content = response.data?.choices?.[0]?.message?.content ?? "[]";
    const start = String(content).indexOf("[");
    const end = String(content).lastIndexOf("]");
    const raw = start >= 0 && end > start ? String(content).slice(start, end + 1) : "[]";

    const parsed = JSON.parse(raw) as GrokItem[];
    const records = parsed
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .filter((item) => item.url)
      .map((item) => ({
        externalId: item.url,
        title: item.title || item.url,
        url: item.url,
        summary: item.summary,
        publishedAt: item.published_at ? new Date(item.published_at) : new Date(),
        payload: { sourceName, query },
      }));

    return { records, warnings: [], errors: [] };
  } catch (error) {
    return {
      records: [],
      warnings: [],
      errors: [`Grok fetch failed for ${sourceName}: ${String(error)}`],
    };
  }
}
