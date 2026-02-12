import { ArticleStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { computeSimhash, cosineSimilarity, hammingDistance, localEmbedding, titleSimilarity } from "../utils/text.js";

export type Candidate = {
  id: number;
  normalizedUrl: string;
  title: string;
  content: string;
  publishedAt: Date | null;
  simhash: bigint;
  embedding: number[];
};

export type Cluster = {
  primaryId: number;
  members: number[];
  reasons: string[];
};

export type DedupThresholds = {
  titleSimilarity: number;
  simhashDistance: number;
  embeddingSimilarity: number;
};

export const DEFAULT_DEDUP_THRESHOLDS: DedupThresholds = {
  titleSimilarity: 0.88,
  simhashDistance: 8,
  embeddingSimilarity: 0.82,
};

export function clusterCandidates(
  candidates: Candidate[],
  thresholds: DedupThresholds = DEFAULT_DEDUP_THRESHOLDS,
): Cluster[] {
  const byId = new Map<number, Candidate>(candidates.map((candidate) => [candidate.id, candidate]));
  const clusters: Cluster[] = [];

  for (const candidate of candidates) {
    let matched: Cluster | undefined;
    for (const cluster of clusters) {
      const primary = byId.get(cluster.primaryId);
      if (!primary) {
        continue;
      }
      const reasons: string[] = [];

      if (candidate.normalizedUrl === primary.normalizedUrl) {
        reasons.push("url");
      }
      if (titleSimilarity(candidate.title, primary.title) >= thresholds.titleSimilarity) {
        reasons.push("title");
      }
      if (hammingDistance(candidate.simhash, primary.simhash) <= thresholds.simhashDistance) {
        reasons.push("simhash");
      }
      if (cosineSimilarity(candidate.embedding, primary.embedding) >= thresholds.embeddingSimilarity) {
        reasons.push("embedding");
      }

      if (reasons.length > 0) {
        matched = cluster;
        matched.members.push(candidate.id);
        matched.reasons.push(...reasons);
        break;
      }
    }

    if (!matched) {
      clusters.push({ primaryId: candidate.id, members: [candidate.id], reasons: ["single"] });
    }
  }

  return clusters;
}

export async function deduplicateRecent(days = 3): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const articles = await prisma.article.findMany({
    where: {
      createdAt: { gte: cutoff },
      status: { not: ArticleStatus.ignored },
    },
    orderBy: [{ publishedAt: "asc" }, { id: "asc" }],
  });

  if (!articles.length) {
    return 0;
  }

  for (const article of articles) {
    await prisma.article.update({
      where: { id: article.id },
      data: {
        clusterId: null,
        status: article.status === ArticleStatus.ignored ? ArticleStatus.ignored : ArticleStatus.new,
      },
    });
  }

  const candidates: Candidate[] = articles.map((article) => {
    const content = article.fullText || article.summary || article.title;
    return {
      id: article.id,
      normalizedUrl: article.normalizedUrl,
      title: article.title,
      content,
      publishedAt: article.publishedAt,
      simhash: computeSimhash(content),
      embedding: localEmbedding(content),
    };
  });

  const clusters = clusterCandidates(candidates);

  await prisma.dedupCluster.deleteMany({ where: { createdAt: { gte: cutoff } } });

  let duplicates = 0;

  for (const cluster of clusters) {
    const clusterRow = await prisma.dedupCluster.create({
      data: {
        primaryArticleId: cluster.primaryId,
        methodSummary: [...new Set(cluster.reasons)].join(", "),
      },
    });

    for (const memberId of cluster.members) {
      const candidate = candidates.find((item) => item.id === memberId);
      if (!candidate) {
        continue;
      }

      const status = memberId === cluster.primaryId ? ArticleStatus.new : ArticleStatus.duplicate;
      if (status === ArticleStatus.duplicate) {
        duplicates += 1;
      }

      await prisma.article.update({
        where: { id: memberId },
        data: {
          clusterId: clusterRow.id,
          status,
          simhashValue: candidate.simhash.toString(16).padStart(16, "0"),
          contentFingerprint: candidate.simhash.toString(),
          embedding: Buffer.from(Float32Array.from(candidate.embedding).buffer),
        },
      });
    }
  }

  return duplicates;
}
