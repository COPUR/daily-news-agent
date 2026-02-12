import axios from "axios";
import { prisma } from "../db/client.js";
import { env } from "../config/env.js";
import { classifyTopic, extractFacts, extractFullTextFromUrl } from "./extraction.js";
import { stringifyJson } from "../utils/json.js";

export async function enrichArticle(articleId: number): Promise<void> {
  const article = await prisma.article.findUnique({ where: { id: articleId } });
  if (!article) {
    return;
  }

  let fullText = article.fullText;
  let language = article.language;
  let retrievalBlocked = false;
  let retrievalBlockedReason: string | null = null;
  let resolvedUrl = article.url;

  if (!fullText) {
    const extracted = await extractFullTextFromUrl(article.url);
    fullText = extracted.text;
    if (extracted.language) {
      language = extracted.language;
    }
    retrievalBlocked = extracted.blocked;
    retrievalBlockedReason = extracted.blockedReason;
    resolvedUrl = extracted.finalUrl || article.url;
  }

  const topic = classifyTopic(article.title, article.summary, fullText);
  const facts = extractFacts(article.title, article.summary, fullText, article.url);
  const factsWithRetrieval = {
    ...facts,
    retrieval: {
      blocked: retrievalBlocked,
      reason: retrievalBlockedReason,
      resolved_url: resolvedUrl,
      fetched_at: new Date().toISOString(),
    },
  };

  await prisma.article.update({
    where: { id: article.id },
    data: {
      fullText,
      language,
      topic,
      extractedFactsJson: stringifyJson(factsWithRetrieval),
      entitiesJson: stringifyJson({ companies: facts.who || [] }),
    },
  });

  if (env.SERPER_API_KEY) {
    await upsertRelatedLinks(article.id, article.title);
  }
}

async function upsertRelatedLinks(articleId: number, query: string): Promise<void> {
  try {
    const response = await axios.post(
      env.SERPER_ENDPOINT,
      { q: query, num: 5 },
      {
        timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": env.SERPER_API_KEY,
          "User-Agent": env.USER_AGENT,
        },
      },
    );

    const items = (response.data?.organic ?? []).slice(0, 5);

    await prisma.relatedLink.deleteMany({ where: { articleId } });
    for (const item of items) {
      await prisma.relatedLink.create({
        data: {
          articleId,
          url: String(item.link ?? ""),
          title: item.title ? String(item.title) : null,
          snippet: item.snippet ? String(item.snippet) : null,
          sourceEngine: "serper",
        },
      });
    }
  } catch {
    // Optional enrichment. Ignore failures.
  }
}
