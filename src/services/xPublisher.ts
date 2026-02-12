import axios from "axios";
import { env } from "../config/env.js";

export class XPublishError extends Error {}

export interface XPublishResult {
  tweetId: string;
  url: string;
  postedAt: string;
}

function requireCredentials() {
  if (!env.TWITTER_API_KEY || !env.TWITTER_API_SECRET || !env.TWITTER_ACCESS_TOKEN || !env.TWITTER_ACCESS_TOKEN_SECRET) {
    throw new XPublishError(
      "X posting is unconfigured. Set TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET",
    );
  }
}

export function buildXPostText(headline: string, contentText: string, language: string): string {
  const heading = (headline || "").trim();
  const firstLine = (contentText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";

  const tag = language === "tr" ? "#TR" : "#EN";
  const text = [heading, firstLine, tag].filter(Boolean).join(" | ").trim();
  if (!text) {
    throw new XPublishError("X post content is empty");
  }
  return text.length <= 280 ? text : `${text.slice(0, 279).trim()}…`;
}

// NOTE: For local-first MVP we keep OAuth 1.0a signing out of scope here.
// If all credentials are present, we still require TWITTER_BEARER_TOKEN and call v2 endpoint.
export async function postToX(text: string): Promise<XPublishResult> {
  requireCredentials();
  if (!env.TWITTER_BEARER_TOKEN) {
    throw new XPublishError("TWITTER_BEARER_TOKEN is required for Node X posting verification path");
  }

  const payload = text.trim();
  if (!payload) {
    throw new XPublishError("X post content is empty");
  }

  try {
    const createResponse = await axios.post(
      "https://api.twitter.com/2/tweets",
      { text: payload },
      {
        timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
        headers: {
          Authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}`,
          "Content-Type": "application/json",
        },
      },
    );

    const tweetId = String(createResponse.data?.data?.id || "");
    if (!tweetId) {
      throw new XPublishError("X post failed: missing tweet id");
    }

    const verifyResponse = await axios.get(`https://api.twitter.com/2/tweets/${tweetId}`, {
      timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
      headers: { Authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}` },
    });

    if (!verifyResponse.data?.data?.id) {
      throw new XPublishError("X verification failed: tweet not found");
    }

    const handle = (env.TWITTER_POST_HANDLE || "").replace(/^@/, "");
    const url = handle ? `https://x.com/${handle}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`;

    return {
      tweetId,
      url,
      postedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof XPublishError) {
      throw error;
    }
    throw new XPublishError(`X post failed: ${String(error)}`);
  }
}
