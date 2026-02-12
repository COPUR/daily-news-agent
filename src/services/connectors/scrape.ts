import axios from "axios";
import type { ConnectorResult } from "../../types/domain.js";
import { env } from "../../config/env.js";
import { urlRetrievalTool } from "../retrievalTools.js";

async function canFetch(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
    const response = await axios.get(robotsUrl, {
      timeout: env.REQUEST_TIMEOUT_SECONDS * 1000,
      headers: { "User-Agent": env.USER_AGENT },
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      return true;
    }

    const content = String(response.data ?? "");
    const lines = content.split(/\r?\n/);
    let wildcard = false;
    const disallowed: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith("user-agent:")) {
        wildcard = trimmed.split(":")[1]?.trim() === "*";
      }
      if (wildcard && trimmed.toLowerCase().startsWith("disallow:")) {
        const value = trimmed.split(":")[1]?.trim() ?? "";
        if (value) {
          disallowed.push(value);
        }
      }
    }

    return !disallowed.some((rule) => parsed.pathname.startsWith(rule));
  } catch {
    return true;
  }
}

export async function fetchScrape(
  sourceConfig: Record<string, unknown>,
  sourceName: string,
): Promise<ConnectorResult> {
  const listUrls = Array.isArray(sourceConfig.listUrls) ? sourceConfig.listUrls.map(String) : [];
  const selector = String(sourceConfig.articleLinkSelector ?? "").trim();
  const selectors = Array.isArray(sourceConfig.articleLinkSelectors)
    ? sourceConfig.articleLinkSelectors.map(String).map((value: string) => value.trim()).filter(Boolean)
    : selector
      ? [selector]
      : [];
  const allowPatterns = Array.isArray(sourceConfig.allowPatterns)
    ? sourceConfig.allowPatterns.map(String)
    : Array.isArray(sourceConfig.allowlist)
      ? sourceConfig.allowlist.map(String)
      : [];
  const denyPatterns = Array.isArray(sourceConfig.denyPatterns)
    ? sourceConfig.denyPatterns.map(String)
    : Array.isArray(sourceConfig.denylist)
      ? sourceConfig.denylist.map(String)
      : [];
  const sameDomainOnly = Boolean(sourceConfig.sameDomainOnly ?? false);
  const linkLimit = Math.max(1, Math.min(Number(sourceConfig.linkLimit ?? 25), 100));
  const jsRender = Boolean(sourceConfig.jsRender);
  const warnings: string[] = [];
  const errors: string[] = [];
  const records: ConnectorResult["records"] = [];

  if (!listUrls.length) {
    return { records: [], warnings: [], errors: ["Missing listUrls scrape config"] };
  }

  for (const listUrl of listUrls.slice(0, 3)) {
    if (!(await canFetch(listUrl))) {
      warnings.push(`robots_audit:list_disallowed:${listUrl}`);
      continue;
    }

    const extracted = await urlRetrievalTool({
      query: listUrl,
      selectors: selectors.length ? selectors : undefined,
      jsRender,
      sameDomainOnly,
      allowPatterns,
      denyPatterns,
      limit: linkLimit,
    });

    if (extracted.blocked) {
      warnings.push(`source_blocked:${listUrl}:${extracted.blockedReason ?? "unknown"}`);
    }

    if (!extracted.response.length) {
      errors.push(`Could not fetch list page: ${listUrl}`);
      continue;
    }

    for (const link of extracted.response) {
      const articleUrl = link.href;
      if (!(await canFetch(articleUrl))) {
        warnings.push(`robots_audit:article_disallowed:${articleUrl}`);
        continue;
      }

      records.push({
        externalId: articleUrl,
        title: (link.title || "").trim() || articleUrl,
        url: articleUrl,
        publishedAt: new Date(),
        summary: undefined,
        payload: { sourceName, listUrl },
      });
    }
  }

  return { records, warnings, errors };
}
