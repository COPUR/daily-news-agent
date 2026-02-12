import Parser from "rss-parser";
import axios from "axios";
import * as cheerio from "cheerio";
import { env } from "../../config/env.js";
import type { ConnectorResult } from "../../types/domain.js";

const parser = new Parser({
  timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
  headers: {
    "User-Agent": env.USER_AGENT,
  },
});

function sanitizeXmlForParser(xml: string): string {
  return xml
    .replace(/^\uFEFF/, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&(?!(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);)/g, "&amp;");
}

function looksLikeHtml(payload: string, contentType?: string): boolean {
  if ((contentType ?? "").toLowerCase().includes("text/html")) return true;
  const probe = payload.slice(0, 512).toLowerCase();
  return probe.includes("<!doctype html") || probe.includes("<html");
}

function discoverFeedCandidates(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const discovered = new Set<string>();
  const addCandidate = (href?: string) => {
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl).toString();
      discovered.add(resolved);
    } catch {
      // Ignore malformed candidate links
    }
  };

  $("link[rel='alternate'][type*='rss'], link[rel='alternate'][type*='atom']").each((_, element) => {
    addCandidate($(element).attr("href"));
  });

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    if (/(^|\/)(rss|feed)(\/|$)|\.xml($|\?)/i.test(href)) {
      addCandidate(href);
    }
  });

  const rank = (candidate: string): number => {
    if (candidate.includes("/rss/articles/all/")) return 100;
    if (candidate.includes("/rss/news/all/")) return 95;
    if (candidate.includes("/rss/articles/")) return 90;
    if (candidate.includes("/rss/")) return 80;
    if (candidate.includes("/feed")) return 70;
    return 10;
  };

  return [...discovered]
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 8);
}

function toRecords(feed: Awaited<ReturnType<typeof parser.parseURL>>, sourceName: string) {
  return (feed.items ?? [])
    .map((entry) => ({
      externalId: entry.id ?? entry.link,
      title: entry.title ?? "Untitled",
      url: entry.link ?? "",
      publishedAt: entry.isoDate ? new Date(entry.isoDate) : undefined,
      author: entry.creator ?? entry.author,
      summary: entry.contentSnippet ?? entry.content,
      payload: { sourceName },
    }))
    .filter((item) => item.url.length > 0);
}

export async function fetchRss(
  sourceConfig: Record<string, unknown>,
  sourceName: string,
): Promise<ConnectorResult> {
  const url = String(sourceConfig.url ?? "").trim();
  if (!url) {
    return { records: [], warnings: [], errors: ["Missing RSS URL"] };
  }

  try {
    const feed = await parser.parseURL(url);
    return { records: toRecords(feed, sourceName), warnings: [], errors: [] };
  } catch (error) {
    const warning = `RSS parseURL failed for ${sourceName}, trying sanitized fallback: ${String(error)}`;
    try {
      const response = await axios.get<string>(url, {
        timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
        responseType: "text",
        headers: {
          "User-Agent": env.USER_AGENT,
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
      });
      const payload = response.data ?? "";
      const contentTypeHeader = Array.isArray(response.headers["content-type"])
        ? response.headers["content-type"][0]
        : response.headers["content-type"];

      // Fallback #1: sanitize potentially broken XML and parse as feed.
      try {
        const sanitizedXml = sanitizeXmlForParser(payload);
        const feed = await parser.parseString(sanitizedXml);
        return { records: toRecords(feed, sourceName), warnings: [warning], errors: [] };
      } catch (sanitizeError) {
        // Fallback #2: if endpoint is an HTML feed directory, discover real feed URLs.
        if (!looksLikeHtml(payload, contentTypeHeader)) {
          throw sanitizeError;
        }

        const candidates = discoverFeedCandidates(payload, url);
        for (const candidateUrl of candidates) {
          try {
            const feed = await parser.parseURL(candidateUrl);
            return {
              records: toRecords(feed, sourceName),
              warnings: [...[warning, `RSS fallback used discovered feed URL: ${candidateUrl}`]],
              errors: [],
            };
          } catch {
            // Try next candidate
          }
        }
        throw sanitizeError;
      }
    } catch (fallbackError) {
      return {
        records: [],
        warnings: [warning],
        errors: [`RSS fetch failed for ${sourceName}: ${String(fallbackError)}`],
      };
    }
  }
}
