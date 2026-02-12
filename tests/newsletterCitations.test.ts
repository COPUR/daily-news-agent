import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NewsletterDocumentError, NewsletterStore } from "../src/services/newsletterStore.js";

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newsletter-citation-"));
  const file = path.join(dir, "documents.json");
  return {
    store: new NewsletterStore(file),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const selectedNews = [
  {
    article_id: 101,
    citation_id: "A1",
    title: "Tesla Semi charging details",
    url: "https://insideevs.com/news/tesla-semi",
    summary: "Charging details revealed.",
    topic: "SDV",
    language: "en",
    published_at: "2026-02-12T00:00:00.000Z",
  },
  {
    article_id: 102,
    citation_id: "A2",
    title: "BYD charging update",
    url: "https://insideevs.com/news/byd-atto",
    summary: "Charging speed increased.",
    topic: "BATTERY",
    language: "en",
    published_at: "2026-02-12T00:10:00.000Z",
  },
];

const citationCatalog = [
  { citation_id: "A1", article_id: 101, title: "Tesla Semi charging details", url: "https://insideevs.com/news/tesla-semi" },
  { citation_id: "A2", article_id: 102, title: "BYD charging update", url: "https://insideevs.com/news/byd-atto" },
];

describe("newsletter citation validation", () => {
  it("authorizes when all source citations are referenced", () => {
    const { store, cleanup } = createStore();
    try {
      const doc = store.upsertPipelineDraft({
        runId: "run-1",
        postDate: "2026-02-12",
        dailyPostId: 5001,
        outputLanguage: "en",
        headline: "Daily EV Briefing",
        contentMarkdown: "# Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        contentText: "Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        selectedNews,
        citationCatalog,
      });

      const authorized = store.authorize(doc.id);
      expect(authorized.status).toBe("authorized");
    } finally {
      cleanup();
    }
  });

  it("blocks authorize when any required citation is missing", () => {
    const { store, cleanup } = createStore();
    try {
      const doc = store.upsertPipelineDraft({
        runId: "run-2",
        postDate: "2026-02-13",
        dailyPostId: 5002,
        outputLanguage: "en",
        headline: "Daily EV Briefing",
        contentMarkdown: "# Daily EV Briefing\n- [A1] Tesla update",
        contentText: "Daily EV Briefing\n- [A1] Tesla update",
        selectedNews,
        citationCatalog,
      });

      expect(() => store.authorize(doc.id)).toThrow(NewsletterDocumentError);
    } finally {
      cleanup();
    }
  });
});
