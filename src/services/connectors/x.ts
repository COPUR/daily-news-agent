import axios from "axios";
import { env } from "../../config/env.js";
import type { ConnectorResult } from "../../types/domain.js";

export async function fetchX(
  sourceConfig: Record<string, unknown>,
  sourceName: string,
): Promise<ConnectorResult> {
  const bearer = env.TWITTER_BEARER_TOKEN;
  const handle = String(sourceConfig.handle ?? "").trim().replace(/^@/, "");
  const limit = Number(sourceConfig.limit ?? 10);

  if (!handle) {
    return { records: [], warnings: [], errors: ["Missing X handle"] };
  }

  if (!bearer) {
    return { records: [], warnings: ["X connector disabled: TWITTER_BEARER_TOKEN not configured"], errors: [] };
  }

  try {
    const user = await axios.get("https://api.twitter.com/2/users/by/username/" + handle, {
      timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
      headers: { Authorization: `Bearer ${bearer}` },
    });

    const userId = user.data?.data?.id;
    if (!userId) {
      return { records: [], warnings: [], errors: ["Could not resolve X user id"] };
    }

    const tweets = await axios.get(`https://api.twitter.com/2/users/${userId}/tweets`, {
      timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
      headers: { Authorization: `Bearer ${bearer}` },
      params: {
        max_results: Math.max(5, Math.min(limit, 100)),
        "tweet.fields": "created_at,author_id,public_metrics",
      },
    });

    const records = (tweets.data?.data ?? []).map((tweet: any) => ({
      externalId: tweet.id,
      title: String(tweet.text ?? "").slice(0, 140),
      url: `https://x.com/${handle}/status/${tweet.id}`,
      publishedAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
      author: handle,
      summary: tweet.text,
      payload: {
        sourceName,
        likes: tweet.public_metrics?.like_count,
        reposts: tweet.public_metrics?.retweet_count,
      },
    }));

    return {
      records,
      warnings: [],
      errors: [],
    };
  } catch (error) {
    return { records: [], warnings: [], errors: [`X fetch failed for ${sourceName}: ${String(error)}`] };
  }
}
