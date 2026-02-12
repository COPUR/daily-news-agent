import axios from "axios";
import OpenAI from "openai";
import { env } from "../config/env.js";
import type { CitationReference, JsonRecord } from "../types/domain.js";
import { runHuggingFacePrompt } from "./huggingface.js";

export interface RefineSourceArticle {
  citation_id: string;
  title: string;
  url: string;
  summary?: string;
}

export interface RefineNewsletterArgs {
  sourceLanguage: string;
  targetLanguage: string;
  tone: string;
  contextLevel: string;
  userInstruction?: string | null;
  sourceHeadline: string;
  sourceMarkdown: string;
  sourceText: string;
  citationCatalog: CitationReference[];
  sourceArticles?: RefineSourceArticle[];
}

export interface RefineNewsletterResult {
  headline: string;
  contentMarkdown: string;
  contentText: string;
  provider: string;
  promptSnapshot: JsonRecord;
}

export class NewsletterRefineError extends Error {}

function normalizeCitationId(raw?: string | null, index = 0): string {
  const candidate = String(raw || "").trim().toUpperCase();
  if (/^A\d+$/.test(candidate)) {
    return candidate;
  }
  return `A${index + 1}`;
}

function extractCitationIds(content: string): string[] {
  const matches = String(content || "").toUpperCase().match(/\[(A\d+)\]/g) ?? [];
  return [...new Set(matches.map((match) => match.replace(/[\[\]]/g, "")))];
}

export function ensureCitationCoverageForRefine(
  markdownInput: string,
  textInput: string,
  catalogInput: CitationReference[],
  language: string,
): { markdown: string; text: string } {
  const markdown = String(markdownInput || "").trim();
  const text = String(textInput || "").trim();
  const lang = String(language || "en").trim().toLowerCase();
  const catalog = (catalogInput || [])
    .map((item, index) => ({
      citation_id: normalizeCitationId(item.citation_id, index),
      article_id: Number(item.article_id || 0),
      url: String(item.url || ""),
      title: String(item.title || ""),
    }))
    .filter((item) => item.url);

  if (!catalog.length) {
    return { markdown, text };
  }

  const referenced = new Set([
    ...extractCitationIds(markdown),
    ...extractCitationIds(text),
  ]);
  const missing = catalog.filter((item) => !referenced.has(item.citation_id));
  if (!missing.length) {
    return { markdown, text };
  }

  const markdownHeading = lang === "tr" ? "## Kaynak Eslestirme" : "## Source Mapping";
  const textHeading = lang === "tr" ? "Kaynak Eslestirme" : "Source Mapping";
  const markdownLines = missing.map((item) => `- [${item.citation_id}] [${item.title}](${item.url})`);
  const textLines = missing.map((item) => `- [${item.citation_id}] ${item.title} (${item.url})`);

  return {
    markdown: `${markdown}\n\n${markdownHeading}\n${markdownLines.join("\n")}`,
    text: `${text}\n\n${textHeading}\n${textLines.join("\n")}`,
  };
}

function cleanJsonText(value: string): string {
  return value
    .replaceAll("```json", "")
    .replaceAll("```JSON", "")
    .replaceAll("```", "")
    .trim();
}

function asStringRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readRefinePayload(value: unknown): { headline: string; content_markdown: string; content_text: string } | null {
  const record = asStringRecord(value);
  if (!record) {
    return null;
  }

  const headline = record.headline;
  const contentMarkdown = record.content_markdown;
  const contentText = record.content_text;
  if (typeof headline !== "string" || typeof contentMarkdown !== "string" || typeof contentText !== "string") {
    return null;
  }

  const normalizedHeadline = headline.trim();
  const normalizedMarkdown = contentMarkdown.trim();
  const normalizedText = contentText.trim();
  if (!normalizedHeadline || !normalizedMarkdown || !normalizedText) {
    return null;
  }

  return {
    headline: normalizedHeadline,
    content_markdown: normalizedMarkdown,
    content_text: normalizedText,
  };
}

export function parseRefineModelJson(rawContent: string): { headline: string; content_markdown: string; content_text: string } | null {
  const cleaned = cleanJsonText(String(rawContent || ""));
  if (!cleaned) {
    return null;
  }

  try {
    const direct = JSON.parse(cleaned);
    const normalized = readRefinePayload(direct);
    if (normalized) {
      return normalized;
    }
  } catch {
    // continue with partial parsing
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }

  try {
    const sliced = JSON.parse(cleaned.slice(start, end + 1));
    return readRefinePayload(sliced);
  } catch {
    return null;
  }
}

function sourceArticlesBlock(args: RefineNewsletterArgs): string {
  const entries = (args.sourceArticles || [])
    .map((item, index) => {
      const citationId = normalizeCitationId(item.citation_id, index);
      return [
        `citation=[${citationId}]`,
        `title=${item.title}`,
        `url=${item.url}`,
        `summary=${String(item.summary || "")}`,
      ].join("\n");
    })
    .join("\n\n");

  if (entries) {
    return entries;
  }

  return args.citationCatalog
    .map((item, index) => {
      const citationId = normalizeCitationId(item.citation_id, index);
      return [
        `citation=[${citationId}]`,
        `title=${item.title}`,
        `url=${item.url}`,
      ].join("\n");
    })
    .join("\n\n");
}

export function buildRefinePrompt(args: RefineNewsletterArgs): string {
  const targetLanguage = String(args.targetLanguage || "en").trim().toLowerCase();
  const languageLabel = targetLanguage === "tr" ? "Turkish (Turkiye Turkcesi)" : "English";
  const userInstruction = String(args.userInstruction || "").trim();
  const tone = String(args.tone || "neutral").trim().toLowerCase();
  const contextLevel = String(args.contextLevel || "standard").trim().toLowerCase();

  const citations = args.citationCatalog
    .map((item, index) => {
      const citationId = normalizeCitationId(item.citation_id, index);
      return `- [${citationId}] ${item.title} -> ${item.url}`;
    })
    .join("\n");

  const extraInstruction = userInstruction ? `User instruction:\n${userInstruction}` : "User instruction:\nNone";

  return [
    "You are an EV newsroom editor.",
    `Rewrite/translate the newsletter into ${languageLabel}.`,
    "Output ONLY strict JSON with keys: headline, content_markdown, content_text.",
    "Do not include markdown code fences.",
    "Rules:",
    "- Preserve citation tokens exactly: [A1], [A2], ...",
    "- Keep source links unchanged and associated with the right citation token.",
    "- Do not add facts that are not in the source draft or source articles.",
    "- If uncertain about a fact, say 'reported' and keep citation.",
    "- Keep final output concise and readable for a daily EV audience.",
    `Tone: ${tone}`,
    `Context level: ${contextLevel}`,
    extraInstruction,
    "Citation catalog:",
    citations,
    "Source articles:",
    sourceArticlesBlock(args),
    "Source draft headline:",
    args.sourceHeadline || "",
    "Source draft markdown:",
    args.sourceMarkdown || "",
    "Source draft text:",
    args.sourceText || "",
  ].join("\n\n");
}

function getProviderPromptSnapshot(provider: string, prompt: string, args: RefineNewsletterArgs): JsonRecord {
  return {
    provider,
    source_language: String(args.sourceLanguage || "").toLowerCase(),
    target_language: String(args.targetLanguage || "").toLowerCase(),
    tone: String(args.tone || "neutral"),
    context_level: String(args.contextLevel || "standard"),
    model:
      provider === "openai"
        ? env.OPENAI_MODEL
        : provider === "ollama"
          ? env.OLLAMA_MODEL
          : provider === "huggingface"
            ? env.HUGGINGFACE_MODEL_ID
            : provider === "xai"
              ? env.XAI_MODEL
              : "none",
    prompt,
  };
}

async function callHuggingFace(prompt: string): Promise<string> {
  if (!env.HUGGINGFACE_API_KEY) {
    throw new NewsletterRefineError("HUGGINGFACE_API_KEY is missing; set it in .env or Config & Secrets");
  }

  try {
    return await runHuggingFacePrompt({
      apiKey: env.HUGGINGFACE_API_KEY,
      modelId: env.HUGGINGFACE_MODEL_ID,
      prompt,
      timeoutMs: env.REQUEST_TIMEOUT_SECONDS * 1000,
      maxTokens: 1400,
      temperature: 0.2,
    });
  } catch (error) {
    throw new NewsletterRefineError(`Hugging Face request failed: ${String(error instanceof Error ? error.message : error)}`);
  }
}

async function callOpenAICompatible(args: { provider: "openai" | "xai"; prompt: string }): Promise<string> {
  if (args.provider === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new NewsletterRefineError("OPENAI_API_KEY is missing; set it in .env or Config & Secrets");
    }
    const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.2,
      messages: [{ role: "user", content: args.prompt }],
    });
    return String(response.choices[0]?.message?.content || "");
  }

  if (!env.XAI_API_KEY) {
    throw new NewsletterRefineError("XAI_API_KEY is missing; set it in .env or Config & Secrets");
  }
  const client = new OpenAI({ apiKey: env.XAI_API_KEY, baseURL: env.XAI_BASE_URL });
  const response = await client.chat.completions.create({
    model: env.XAI_MODEL,
    temperature: 0.2,
    messages: [{ role: "user", content: args.prompt }],
  });
  return String(response.choices[0]?.message?.content || "");
}

async function callOllama(prompt: string): Promise<string> {
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

  return String(response.data?.response || "");
}

export async function refineNewsletterVariant(args: RefineNewsletterArgs): Promise<RefineNewsletterResult> {
  const provider = env.LLM_PROVIDER;
  if (provider === "none") {
    throw new NewsletterRefineError(
      "LLM_PROVIDER is 'none'; set LLM_PROVIDER=huggingface and configure HUGGINGFACE_API_KEY for Turkish refinement",
    );
  }

  const prompt = buildRefinePrompt(args);

  const runProvider = async (activePrompt: string) => {
    if (provider === "openai" || provider === "xai") {
      return callOpenAICompatible({ provider, prompt: activePrompt });
    }
    if (provider === "ollama") {
      return callOllama(activePrompt);
    }
    if (provider === "huggingface") {
      return callHuggingFace(activePrompt);
    }
    throw new NewsletterRefineError(`Unsupported LLM provider: ${provider}`);
  };

  let rawContent = await runProvider(prompt);
  let parsed = parseRefineModelJson(rawContent);
  if (!parsed) {
    const retryPrompt = [
      prompt,
      "Important correction:",
      "Return ONLY valid JSON object with exact keys headline, content_markdown, content_text.",
      "Do not add explanations, code fences, or extra keys.",
    ].join("\n\n");

    rawContent = await runProvider(retryPrompt);
    parsed = parseRefineModelJson(rawContent);
  }

  if (!parsed) {
    throw new NewsletterRefineError(
      `Refine model did not return valid JSON content (provider=${provider}). Ensure the selected model supports instruction-following.`,
    );
  }

  const covered = ensureCitationCoverageForRefine(
    parsed.content_markdown,
    parsed.content_text,
    args.citationCatalog,
    args.targetLanguage,
  );

  return {
    headline: parsed.headline,
    contentMarkdown: covered.markdown,
    contentText: covered.text,
    provider,
    promptSnapshot: getProviderPromptSnapshot(provider, prompt, args),
  };
}
