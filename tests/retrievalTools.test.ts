import { describe, expect, it } from "vitest";
import { extractReadableTextFromHtml, extractUrlsFromHtml, normalizeDomainInput } from "../src/services/retrievalTools.js";

describe("retrieval tools", () => {
  it("normalizes plain domains with https", () => {
    expect(normalizeDomainInput("example.com")).toBe("https://example.com/");
    expect(normalizeDomainInput("https://example.com/path")).toBe("https://example.com/path");
    expect(normalizeDomainInput("")).toBeNull();
  });

  it("extracts normalized absolute links, filters invalid, and deduplicates", () => {
    const html = `
      <html><body>
        <a href="/news/a">Article A</a>
        <a href="https://example.com/news/b?utm_source=x">Article B</a>
        <a href="mailto:test@example.com">Mail</a>
        <a href="javascript:void(0)">JS</a>
        <a href="/news/a">Article A Duplicate</a>
      </body></html>
    `;

    const links = extractUrlsFromHtml({
      html,
      baseUrl: "https://example.com",
      selectors: ["a[href]"],
      sameDomainOnly: true,
    });

    expect(links.length).toBe(2);
    expect(links[0]?.href).toBe("https://example.com/news/a");
    expect(links[1]?.href).toBe("https://example.com/news/b");
  });

  it("filters sponsored links with deny patterns for clean news crawling", () => {
    const html = `
      <html><body>
        <a href="/news/ev-battery-breakthrough">EV battery breakthrough</a>
        <a href="/sponsored/buy-ev-now">Sponsored: Buy EV now</a>
        <a href="/ads/promo-charge">Ad promo</a>
      </body></html>
    `;

    const links = extractUrlsFromHtml({
      html,
      baseUrl: "https://example.com",
      selectors: ["a[href]"],
      sameDomainOnly: true,
      denyPatterns: ["/sponsored", "/ads"],
    });

    expect(links.length).toBe(1);
    expect(links[0]?.href).toBe("https://example.com/news/ev-battery-breakthrough");
  });

  it("extracts readable article text instead of ad chrome", () => {
    const html = `
      <html lang="en">
      <head><title>Test EV News</title></head>
      <body>
        <header>Navigation</header>
        <aside class="ad-banner">ADVERTISEMENT Buy now and subscribe today.</aside>
        <article>
          <h1>Battery plant expansion reaches 20 GWh</h1>
          <p>Automaker announced a new battery facility with 20 GWh annual capacity in Europe.</p>
          <p>The project includes BMS software upgrades and faster charging architecture.</p>
        </article>
        <footer>Sponsored links and promotions</footer>
      </body>
      </html>
    `;

    const result = extractReadableTextFromHtml(html, "https://example.com/news/ev");
    expect(result.text).toContain("battery facility with 20 GWh");
    expect(result.text?.toLowerCase()).not.toContain("advertisement buy now");
  });
});
