import axios from "axios";
import * as cheerio from "cheerio";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { env } from "../config/env.js";
import { canonicalDomain, normalizeUrl } from "../utils/url.js";

export interface RetrievedLink {
  href: string;
  title: string | null;
}

export interface WebsiteFetchResult {
  requestedUrl: string;
  finalUrl: string;
  html: string | null;
  statusCode: number | null;
  blocked: boolean;
  blockedReason: string | null;
}

const BLOCK_STATUS = new Set([401, 403, 429, 451, 503]);
const BLOCK_PATTERNS = [
  /access denied/i,
  /forbidden/i,
  /verify you are human/i,
  /captcha/i,
  /unusual traffic/i,
  /temporarily blocked/i,
  /automated requests/i,
  /cloudflare/i,
  /bot protection/i,
];

function looksBlocked(statusCode: number | null, html: string | null): { blocked: boolean; reason: string | null } {
  if (statusCode !== null && BLOCK_STATUS.has(statusCode)) {
    return { blocked: true, reason: `status:${statusCode}` };
  }

  if (!html) {
    return { blocked: false, reason: null };
  }

  const probe = html.slice(0, 40_000);
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(probe)) {
      return { blocked: true, reason: `pattern:${pattern.source}` };
    }
  }

  return { blocked: false, reason: null };
}

export function normalizeDomainInput(raw: string): string | null {
  const value = String(raw || "").trim();
  if (!value) {
    return null;
  }
  const enriched = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(enriched).toString();
  } catch {
    return null;
  }
}

function toAbsoluteUrl(rawHref: string, baseUrl: string): string | null {
  const href = String(rawHref || "").trim();
  if (!href) return null;
  if (href.startsWith("#")) return null;
  if (/^(javascript|mailto|tel|data):/i.test(href)) return null;

  try {
    if (href.startsWith("//")) {
      const protocol = new URL(baseUrl).protocol || "https:";
      return new URL(`${protocol}${href}`).toString();
    }
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export async function fetchWebsiteHtml(
  requestedUrl: string,
  options?: {
    jsRender?: boolean;
    timeoutMs?: number;
  },
): Promise<WebsiteFetchResult> {
  const normalized = normalizeDomainInput(requestedUrl);
  if (!normalized) {
    return {
      requestedUrl,
      finalUrl: requestedUrl,
      html: null,
      statusCode: null,
      blocked: false,
      blockedReason: "invalid_url",
    };
  }

  const timeoutMs = options?.timeoutMs ?? env.REQUEST_TIMEOUT_SECONDS * 1000;
  const jsRender = Boolean(options?.jsRender);

  if (jsRender) {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ userAgent: env.USER_AGENT });
        await page.goto(normalized, { waitUntil: "networkidle", timeout: timeoutMs });
        const html = await page.content();
        const finalUrl = page.url() || normalized;
        const blocked = looksBlocked(200, html);
        return {
          requestedUrl: normalized,
          finalUrl,
          html,
          statusCode: 200,
          blocked: blocked.blocked,
          blockedReason: blocked.reason,
        };
      } finally {
        await browser.close();
      }
    } catch {
      return {
        requestedUrl: normalized,
        finalUrl: normalized,
        html: null,
        statusCode: null,
        blocked: false,
        blockedReason: "js_render_failed",
      };
    }
  }

  try {
    const response = await axios.get(normalized, {
      timeout: timeoutMs,
      headers: { "User-Agent": env.USER_AGENT },
      maxRedirects: 5,
      validateStatus: () => true,
    });

    const html = typeof response.data === "string" ? response.data : String(response.data ?? "");
    const finalUrl = response.request?.res?.responseUrl || normalized;
    const blocked = looksBlocked(response.status, html);
    return {
      requestedUrl: normalized,
      finalUrl,
      html,
      statusCode: response.status,
      blocked: blocked.blocked,
      blockedReason: blocked.reason,
    };
  } catch {
    return {
      requestedUrl: normalized,
      finalUrl: normalized,
      html: null,
      statusCode: null,
      blocked: false,
      blockedReason: "fetch_failed",
    };
  }
}

export function extractUrlsFromHtml(args: {
  html: string;
  baseUrl: string;
  selectors?: string[];
  sameDomainOnly?: boolean;
  allowPatterns?: string[];
  denyPatterns?: string[];
  limit?: number;
}): RetrievedLink[] {
  const $ = cheerio.load(args.html);
  const selectors = args.selectors && args.selectors.length > 0 ? args.selectors : ["a[href]"];
  const allow = (args.allowPatterns ?? []).map((value) => value.toLowerCase());
  const deny = (args.denyPatterns ?? []).map((value) => value.toLowerCase());
  const limit = Math.max(1, Math.min(args.limit ?? 100, 1000));
  const baseDomain = canonicalDomain(args.baseUrl);

  const output: RetrievedLink[] = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    const nodes = $(selector).toArray();
    for (const node of nodes) {
      const hrefRaw = ($(node).attr("href") ?? "").trim();
      const title = ($(node).text() || "").trim() || null;
      const absolute = toAbsoluteUrl(hrefRaw, args.baseUrl);
      if (!absolute) continue;

      const normalized = normalizeUrl(absolute);
      const lowered = normalized.toLowerCase();
      if (deny.some((pattern) => lowered.includes(pattern))) continue;
      if (allow.length > 0 && !allow.some((pattern) => lowered.includes(pattern))) continue;
      if (args.sameDomainOnly && baseDomain && canonicalDomain(normalized) !== baseDomain) continue;
      if (seen.has(normalized)) continue;

      seen.add(normalized);
      output.push({ href: normalized, title });
      if (output.length >= limit) {
        return output;
      }
    }
  }

  return output;
}

export function extractReadableTextFromHtml(html: string, url: string): { text: string | null; language: string | null } {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    const text = article?.textContent?.trim() || dom.window.document.body?.textContent?.trim() || null;
    const language = (dom.window.document.documentElement.lang || "").trim() || null;
    return { text, language };
  } catch {
    return { text: null, language: null };
  }
}

export async function textRetrievalTool(args: {
  query: string;
  jsRender?: boolean;
}): Promise<{
  response: string | null;
  url: string;
  language: string | null;
  blocked: boolean;
  blockedReason: string | null;
}> {
  const fetched = await fetchWebsiteHtml(args.query, { jsRender: args.jsRender });
  if (!fetched.html) {
    return {
      response: null,
      url: fetched.finalUrl,
      language: null,
      blocked: fetched.blocked,
      blockedReason: fetched.blockedReason,
    };
  }

  const readable = extractReadableTextFromHtml(fetched.html, fetched.finalUrl);
  return {
    response: readable.text,
    url: fetched.finalUrl,
    language: readable.language,
    blocked: fetched.blocked,
    blockedReason: fetched.blockedReason,
  };
}

export async function urlRetrievalTool(args: {
  query: string;
  selectors?: string[];
  jsRender?: boolean;
  sameDomainOnly?: boolean;
  allowPatterns?: string[];
  denyPatterns?: string[];
  limit?: number;
}): Promise<{
  response: RetrievedLink[];
  url: string;
  blocked: boolean;
  blockedReason: string | null;
}> {
  const fetched = await fetchWebsiteHtml(args.query, { jsRender: args.jsRender });
  if (!fetched.html) {
    return {
      response: [],
      url: fetched.finalUrl,
      blocked: fetched.blocked,
      blockedReason: fetched.blockedReason,
    };
  }

  const links = extractUrlsFromHtml({
    html: fetched.html,
    baseUrl: fetched.finalUrl,
    selectors: args.selectors,
    sameDomainOnly: args.sameDomainOnly,
    allowPatterns: args.allowPatterns,
    denyPatterns: args.denyPatterns,
    limit: args.limit,
  });
  return {
    response: links,
    url: fetched.finalUrl,
    blocked: fetched.blocked,
    blockedReason: fetched.blockedReason,
  };
}
