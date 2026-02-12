import { ArticleStatus, Topic, type Article } from "@prisma/client";
import { parseJson } from "../utils/json.js";

const ENTITY_PRIORITY: Array<[string, RegExp, number]> = [
  ["Tesla", /\btesla\b/i, 30],
  ["Hypercars", /\bhypercars?\b/i, 27],
  ["NVIDIA", /\bnvidia\b/i, 24],
  ["Openpilot", /\bopen\s?pilot\b/i, 21],
  ["BYD", /\bbyd\b/i, 18],
];

const TOPIC_PRIORITY = new Map<Topic, number>([
  [Topic.AV, 15],
  [Topic.VEHICLE_SOFTWARE, 13],
  [Topic.BMS, 11],
  [Topic.BATTERY, 9],
  [Topic.SDV, 7],
  [Topic.EV, 5],
  [Topic.OTHER, 3],
]);

function articleText(article: Article): string {
  const facts = parseJson<Record<string, unknown>>(article.extractedFactsJson, {});
  const entities = parseJson<Record<string, unknown>>(article.entitiesJson, {});
  return [
    article.title,
    article.summary ?? "",
    article.fullText ?? "",
    JSON.stringify(facts),
    JSON.stringify(entities),
  ]
    .join(" ")
    .toLowerCase();
}

function priorityScore(article: Article): number {
  const text = articleText(article);
  for (const [, pattern, score] of ENTITY_PRIORITY) {
    if (pattern.test(text)) {
      return score;
    }
  }
  return TOPIC_PRIORITY.get(article.topic) ?? 3;
}

function recencyScore(publishedAt: Date | null): number {
  if (!publishedAt) {
    return 0.2;
  }
  const ageHours = Math.max(0, (Date.now() - publishedAt.getTime()) / 3_600_000);
  return 1 / (1 + ageHours / 12);
}

function factsRichness(article: Article): number {
  const facts = parseJson<{ numbers?: unknown[]; who?: unknown[] }>(article.extractedFactsJson, {});
  const numbers = Array.isArray(facts.numbers) ? facts.numbers.length : 0;
  const who = Array.isArray(facts.who) ? facts.who.length : 0;
  return Math.min(1, numbers * 0.1 + who * 0.08);
}

export function scoreArticle(article: Article, clusterSize: number): number {
  const priority = priorityScore(article);
  const recency = recencyScore(article.publishedAt);
  const facts = factsRichness(article);
  const impact = Math.min(1, Math.log1p(Math.max(1, clusterSize)) / 1.2);

  let score = priority + recency * 0.5 + facts * 0.3 + impact * 0.2;
  if (article.status === ArticleStatus.ignored) {
    score -= 1;
  }
  return Number(score.toFixed(6));
}

export function selectTopArticles(
  articles: Article[],
  clusterSizes: Map<number, number>,
  minItems: number,
  maxItems: number,
  desiredItems: number,
): Article[] {
  const horizon = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const eligible = articles.filter((article) => {
    if (article.status !== ArticleStatus.new && article.status !== ArticleStatus.selected) {
      return false;
    }
    if (article.publishedAt && article.publishedAt < horizon) {
      return false;
    }
    return true;
  });

  eligible.sort((a, b) => {
    const scoreA = scoreArticle(a, clusterSizes.get(a.id) ?? 1);
    const scoreB = scoreArticle(b, clusterSizes.get(b.id) ?? 1);
    return scoreB - scoreA;
  });

  const cap = Math.max(minItems, Math.min(desiredItems, maxItems));
  return eligible.slice(0, cap);
}
