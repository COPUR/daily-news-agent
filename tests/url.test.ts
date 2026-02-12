import { describe, expect, it } from "vitest";
import { canonicalDomain, normalizeUrl } from "../src/utils/url.js";

describe("URL normalization", () => {
  it("removes tracking params, hash, and www host prefix", () => {
    const input = "https://www.example.com/news/ev-update/?utm_source=x&gclid=123&a=1#details";
    const output = normalizeUrl(input);
    expect(output).toBe("https://example.com/news/ev-update?a=1");
  });

  it("returns trimmed value for invalid url", () => {
    expect(normalizeUrl(" not-a-url ")).toBe("not-a-url");
  });

  it("canonicalizes domain", () => {
    expect(canonicalDomain("https://www.BYD.com/news")).toBe("byd.com");
  });
});
