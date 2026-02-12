import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/newsletterRefine.js", () => ({
  refineNewsletterVariant: vi.fn(),
}));

vi.mock("../src/services/xPublisher.js", () => {
  class MockXPublishError extends Error {}
  return {
    buildXPostText: (headline: string, contentText: string, language: string) =>
      `${headline} | ${(contentText || "").split(/\r?\n/).find((line) => line.trim()) || ""} | #${language.toUpperCase()}`,
    postToX: vi.fn(),
    XPublishError: MockXPublishError,
  };
});

import { NewsletterDocumentError, NewsletterStore } from "../src/services/newsletterStore.js";
import { refineNewsletterVariant } from "../src/services/newsletterRefine.js";
import { postToX, XPublishError } from "../src/services/xPublisher.js";

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "newsletter-regression-"));
  const file = path.join(dir, "documents.json");
  return {
    store: new NewsletterStore(file),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const selectedNews = [
  {
    article_id: 201,
    citation_id: "A1",
    title: "Tesla battery update",
    url: "https://insideevs.com/news/tesla-battery-update",
    summary: "Battery roadmap update from Tesla.",
    topic: "BATTERY",
    language: "en",
    published_at: "2026-02-12T00:00:00.000Z",
  },
  {
    article_id: 202,
    citation_id: "A2",
    title: "BYD software stack",
    url: "https://insideevs.com/news/byd-software-stack",
    summary: "Vehicle software and charging updates.",
    topic: "VEHICLE_SOFTWARE",
    language: "en",
    published_at: "2026-02-12T00:10:00.000Z",
  },
];

const citationCatalog = [
  { citation_id: "A1", article_id: 201, title: "Tesla battery update", url: "https://insideevs.com/news/tesla-battery-update" },
  { citation_id: "A2", article_id: 202, title: "BYD software stack", url: "https://insideevs.com/news/byd-software-stack" },
];

function getVariant(doc: any, collectionId: string, language: string) {
  const collection = doc.newsletter.news_collections.find((item: any) => item.collection_id === collectionId);
  return collection.language_variants.find((item: any) => String(item.language || "").toLowerCase() === language);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("newsletter workflow regression", () => {
  it("persists draft collection with source details and preauth output status", () => {
    const { store, cleanup } = createStore();
    try {
      const doc = store.upsertPipelineDraft({
        runId: "run-reg-1",
        postDate: "2026-02-12",
        dailyPostId: 6001,
        outputLanguage: "en",
        headline: "Daily EV Briefing",
        contentMarkdown: "# Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        contentText: "Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        selectedNews,
        citationCatalog,
      });

      const collectionId = "collection-2026-02-12";
      const variant = getVariant(doc, collectionId, "en");
      expect(doc.status).toBe("draft");
      expect(variant.post_status).toBe("preauth");
      expect(variant.citation_validation.valid).toBe(true);
      expect(doc.newsletter.news_collections[0].news).toHaveLength(2);
      expect(doc.newsletter.news_collections[0].news[0].title).toContain("Tesla");
    } finally {
      cleanup();
    }
  });

  it("creates Turkish draft variant through chatbot refine with preauth status", async () => {
    vi.mocked(refineNewsletterVariant).mockResolvedValue({
      headline: "Gunluk EV Bulteni",
      contentMarkdown: "# Gunluk EV Bulteni\n- [A1] Tesla guncellemesi\n- [A2] BYD yazilim guncellemesi",
      contentText: "Gunluk EV Bulteni\n- [A1] Tesla guncellemesi\n- [A2] BYD yazilim guncellemesi",
      provider: "huggingface",
      promptSnapshot: { provider: "huggingface" },
    });

    const { store, cleanup } = createStore();
    try {
      const doc = store.upsertPipelineDraft({
        runId: "run-reg-2",
        postDate: "2026-02-12",
        dailyPostId: 6002,
        outputLanguage: "en",
        headline: "Daily EV Briefing",
        contentMarkdown: "# Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        contentText: "Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        selectedNews,
        citationCatalog,
      });

      const refined = await store.refineWithChatbot({
        documentId: doc.id,
        collectionId: "collection-2026-02-12",
        sourceLanguage: "en",
        targetLanguage: "tr",
        tone: "playful",
        contextLevel: "turkish,standard,automotive,ev",
        userInstruction: "Kisa ve net yaz",
      });

      const trVariant = getVariant(refined, "collection-2026-02-12", "tr");
      expect(trVariant).toBeTruthy();
      expect(trVariant.post_status).toBe("preauth");
      expect(trVariant.headline).toContain("Gunluk");
      expect(refined.status).toBe("draft");
      expect(vi.mocked(refineNewsletterVariant)).toHaveBeenCalledOnce();
    } finally {
      cleanup();
    }
  });

  it("requires per-language authorization and keeps authorized draft on X publish error", async () => {
    vi.mocked(refineNewsletterVariant).mockResolvedValue({
      headline: "Gunluk EV Bulteni",
      contentMarkdown: "# Gunluk EV Bulteni\n- [A1] Tesla guncellemesi\n- [A2] BYD yazilim guncellemesi",
      contentText: "Gunluk EV Bulteni\n- [A1] Tesla guncellemesi\n- [A2] BYD yazilim guncellemesi",
      provider: "huggingface",
      promptSnapshot: { provider: "huggingface" },
    });

    const { store, cleanup } = createStore();
    try {
      const doc = store.upsertPipelineDraft({
        runId: "run-reg-3",
        postDate: "2026-02-12",
        dailyPostId: 6003,
        outputLanguage: "en",
        headline: "Daily EV Briefing",
        contentMarkdown: "# Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        contentText: "Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        selectedNews,
        citationCatalog,
      });

      await store.refineWithChatbot({
        documentId: doc.id,
        collectionId: "collection-2026-02-12",
        sourceLanguage: "en",
        targetLanguage: "tr",
        tone: "neutral",
        contextLevel: "standard",
      });

      // Approve only EN first; TR remains preauth.
      store.authorize(doc.id, "approve en", { collectionId: "collection-2026-02-12", language: "en" });

      await expect(
        store.postDocumentToX({
          documentId: doc.id,
          collectionId: "collection-2026-02-12",
          language: "tr",
        }),
      ).rejects.toThrow(NewsletterDocumentError);

      store.authorize(doc.id, "approve tr", { collectionId: "collection-2026-02-12", language: "tr" });
      vi.mocked(postToX).mockRejectedValue(new XPublishError("x api unavailable"));

      await expect(
        store.postDocumentToX({
          documentId: doc.id,
          collectionId: "collection-2026-02-12",
          language: "tr",
        }),
      ).rejects.toThrow("x api unavailable");

      const updated = store.getDocument(doc.id)!;
      const trVariant = getVariant(updated, "collection-2026-02-12", "tr");
      expect(updated.status).toBe("authorized");
      expect(trVariant.post_status).toBe("authorized");
      expect(updated.x_publish.posted).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("marks posted when authorized language is published to X", async () => {
    vi.mocked(postToX).mockResolvedValue({
      tweetId: "tweet-123",
      url: "https://x.com/test/status/tweet-123",
      postedAt: "2026-02-12T09:00:00.000Z",
    });

    const { store, cleanup } = createStore();
    try {
      const doc = store.upsertPipelineDraft({
        runId: "run-reg-4",
        postDate: "2026-02-12",
        dailyPostId: 6004,
        outputLanguage: "en",
        headline: "Daily EV Briefing",
        contentMarkdown: "# Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        contentText: "Daily EV Briefing\n- [A1] Tesla update\n- [A2] BYD update",
        selectedNews,
        citationCatalog,
      });

      store.authorize(doc.id, "approve en", { collectionId: "collection-2026-02-12", language: "en" });

      const posted = await store.postDocumentToX({
        documentId: doc.id,
        collectionId: "collection-2026-02-12",
        language: "en",
      });

      const enVariant = getVariant(posted, "collection-2026-02-12", "en");
      expect(posted.status).toBe("posted");
      expect(enVariant.post_status).toBe("posted");
      expect(posted.x_publish.posted).toBe(true);
      expect(posted.x_publish.tweet_id).toBe("tweet-123");
    } finally {
      cleanup();
    }
  });
});
