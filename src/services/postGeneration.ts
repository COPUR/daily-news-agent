import axios from "axios";
import OpenAI from "openai";
import type { Article } from "@prisma/client";
import { env } from "../config/env.js";
import type { CitationReference, DailyPostGenerated } from "../types/domain.js";
import { parseJson } from "../utils/json.js";
import { runHuggingFacePrompt } from "./huggingface.js";

function buildCitationCatalog(articles: Article[]): CitationReference[] {
  return articles.map((article, idx) => ({
    citation_id: `A${idx + 1}`,
    article_id: article.id,
    url: article.url,
    title: article.title,
  }));
}

function extractCitationIds(content: string): string[] {
  const matches = String(content || "").toUpperCase().match(/\[(A\d+)\]/g) ?? [];
  const normalized = matches.map((match) => match.replace(/[\[\]]/g, ""));
  return [...new Set(normalized)];
}

function ensureCitationCoverage(
  markdownInput: string,
  textInput: string,
  catalog: CitationReference[],
  language: "en" | "tr",
): { markdown: string; text: string } {
  const markdown = String(markdownInput || "").trim();
  const text = String(textInput || "").trim();

  const referenced = new Set([
    ...extractCitationIds(markdown),
    ...extractCitationIds(text),
  ]);
  const missing = catalog.filter((item) => !referenced.has(item.citation_id));

  if (!missing.length) {
    return { markdown, text };
  }

  const markdownHeading = language === "tr" ? "## Kaynak Eslestirme" : "## Source Mapping";
  const markdownLines = missing.map((item) => `- [${item.citation_id}] [${item.title}](${item.url})`);
  const textHeading = "Source Mapping";
  const textLines = missing.map((item) => `- [${item.citation_id}] ${item.title} (${item.url})`);

  return {
    markdown: `${markdown}\n\n${markdownHeading}\n${markdownLines.join("\n")}`,
    text: `${text}\n\n${textHeading}\n${textLines.join("\n")}`,
  };
}

function buildPrompt(articles: Article[], catalog: CitationReference[], language: "en" | "tr"): string {
  const storyLines = articles
    .map((article, idx) => {
      const facts = parseJson<Record<string, unknown>>(article.extractedFactsJson, {});
      const citation = catalog[idx];
      return [
        `${idx + 1}. citation=[${citation.citation_id}]`,
        `title=${article.title}`,
        `url=${article.url}`,
        `summary=${article.summary ?? ""}`,
        `facts=${JSON.stringify(facts)}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `Create ONE daily EV newsletter post in ${language}.`,
    "Focus: AV, Vehicle Software, BMS, Battery, SDV, EV.",
    "Output strict JSON object with keys: headline, content_markdown, content_text.",
    "Rules: concise, factual, cite source URLs and keep deterministic citation tokens [A1], [A2], ... exactly, no hallucinations.",
    "Every bullet/insight must include at least one citation token.",
    "Stories:",
    storyLines,
  ].join("\n");
}

function fallbackPost(articles: Article[], catalog: CitationReference[], language: "en" | "tr"): DailyPostGenerated {
  const headline = language === "tr" ? "Gunluk EV Bulteni" : "Daily EV Briefing";
  const bullets = catalog
    .slice(0, 7)
    .map((citation) => `- [${citation.citation_id}] ${citation.title} ([source](${citation.url}))`);
  const markdown = `# ${headline}\n\n${bullets.join("\n")}\n\n${language === "tr" ? "EV/SDV/Batarya icin onemi: stratejik teknoloji ve tedarik etkisi." : "Why it matters for EV/SDV/Battery: strategic impact across technology and supply chain."}`;
  const text = markdown.replace(/\[source\]\((.*?)\)/g, "$1");
  const covered = ensureCitationCoverage(markdown, text, catalog, language);

  return {
    headline,
    markdown: covered.markdown,
    text: covered.text,
    provider: "rule-based",
    promptSnapshot: { language, mode: "fallback", citation_catalog: catalog },
    citationCatalog: catalog,
  };
}

function parseModelJson(content: string): { headline: string; content_markdown: string; content_text: string } | null {
  const raw = String(content ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed.headline || !parsed.content_markdown || !parsed.content_text) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function generateDailyPost(articles: Article[], language: "en" | "tr"): Promise<DailyPostGenerated> {
  const catalog = buildCitationCatalog(articles);
  if (!articles.length) {
    return fallbackPost([], [], language);
  }

  const prompt = buildPrompt(articles, catalog, language);

  try {
    if (env.LLM_PROVIDER === "openai" && env.OPENAI_API_KEY) {
      const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const response = await client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      });
      const parsed = parseModelJson(response.choices[0]?.message?.content ?? "");
      if (parsed) {
        const covered = ensureCitationCoverage(parsed.content_markdown, parsed.content_text, catalog, language);
        return {
          headline: parsed.headline,
          markdown: covered.markdown,
          text: covered.text,
          provider: "openai",
          promptSnapshot: { language, prompt, citation_catalog: catalog },
          citationCatalog: catalog,
        };
      }
    }

    if (env.LLM_PROVIDER === "xai" && env.XAI_API_KEY) {
      const client = new OpenAI({ apiKey: env.XAI_API_KEY, baseURL: env.XAI_BASE_URL });
      const response = await client.chat.completions.create({
        model: env.XAI_MODEL,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      });
      const parsed = parseModelJson(response.choices[0]?.message?.content ?? "");
      if (parsed) {
        const covered = ensureCitationCoverage(parsed.content_markdown, parsed.content_text, catalog, language);
        return {
          headline: parsed.headline,
          markdown: covered.markdown,
          text: covered.text,
          provider: "xai",
          promptSnapshot: { language, prompt, citation_catalog: catalog },
          citationCatalog: catalog,
        };
      }
    }

    if (env.LLM_PROVIDER === "ollama") {
      const response = await axios.post(
        `${env.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/generate`,
        {
          model: env.OLLAMA_MODEL,
          prompt,
          stream: false,
          format: "json",
        },
        { timeout: env.REQUEST_TIMEOUT_SECONDS * 1000 },
      );
      const parsed = parseModelJson(String(response.data?.response ?? ""));
      if (parsed) {
        const covered = ensureCitationCoverage(parsed.content_markdown, parsed.content_text, catalog, language);
        return {
          headline: parsed.headline,
          markdown: covered.markdown,
          text: covered.text,
          provider: "ollama",
          promptSnapshot: { language, prompt, citation_catalog: catalog },
          citationCatalog: catalog,
        };
      }
    }

    if (env.LLM_PROVIDER === "huggingface") {
      if (!env.HUGGINGFACE_API_KEY) {
        throw new Error("HUGGINGFACE_API_KEY is missing");
      }
      const raw = await runHuggingFacePrompt({
        apiKey: env.HUGGINGFACE_API_KEY,
        modelId: env.HUGGINGFACE_MODEL_ID,
        prompt,
        timeoutMs: env.REQUEST_TIMEOUT_SECONDS * 1000,
        maxTokens: 1400,
        temperature: 0.2,
      });

      const parsed = parseModelJson(raw);
      if (parsed) {
        const covered = ensureCitationCoverage(parsed.content_markdown, parsed.content_text, catalog, language);
        return {
          headline: parsed.headline,
          markdown: covered.markdown,
          text: covered.text,
          provider: "huggingface",
          promptSnapshot: { language, prompt, citation_catalog: catalog, model: env.HUGGINGFACE_MODEL_ID },
          citationCatalog: catalog,
        };
      }
    }
  } catch {
    // fallback
  }

  return fallbackPost(articles, catalog, language);
}
