const TRACKING_PREFIXES = ["utm_", "fbclid", "gclid", "mc_cid", "mc_eid"];

export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl.trim());
    for (const [key] of [...url.searchParams]) {
      const lower = key.toLowerCase();
      if (TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        url.searchParams.delete(key);
      }
    }

    url.hash = "";
    const host = url.hostname.toLowerCase();
    url.hostname = host.startsWith("www.") ? host.slice(4) : host;

    if (url.pathname.endsWith("/") && url.pathname !== "/") {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function canonicalDomain(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
