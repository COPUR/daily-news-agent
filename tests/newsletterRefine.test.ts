import { describe, expect, it } from "vitest";
import {
  buildRefinePrompt,
  ensureCitationCoverageForRefine,
  parseRefineModelJson,
} from "../src/services/newsletterRefine.js";

describe("newsletter refine helpers", () => {
  it("parses JSON payload wrapped in markdown fences", () => {
    const payload = [
      "```json",
      "{\"headline\":\"Gunluk EV Bulteni\",\"content_markdown\":\"# Gunluk EV Bulteni\\n- [A1] Haber\",\"content_text\":\"Gunluk EV Bulteni\\n- [A1] Haber\"}",
      "```",
    ].join("\n");

    const parsed = parseRefineModelJson(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.headline).toBe("Gunluk EV Bulteni");
    expect(parsed?.content_markdown).toContain("[A1]");
  });

  it("appends missing citations to preserve deterministic traceability", () => {
    const covered = ensureCitationCoverageForRefine(
      "# Daily EV Briefing\n- [A1] Tesla update",
      "Daily EV Briefing\n- [A1] Tesla update",
      [
        { citation_id: "A1", article_id: 1, title: "Tesla update", url: "https://example.com/tesla" },
        { citation_id: "A2", article_id: 2, title: "BYD update", url: "https://example.com/byd" },
      ],
      "tr",
    );

    expect(covered.markdown).toContain("## Kaynak Eslestirme");
    expect(covered.markdown).toContain("[A2]");
    expect(covered.text).toContain("[A2]");
  });

  it("builds a Turkish refinement prompt with citation catalog", () => {
    const prompt = buildRefinePrompt({
      sourceLanguage: "en",
      targetLanguage: "tr",
      tone: "playful",
      contextLevel: "turkish,standard,automotive,ev",
      userInstruction: "Kisa ve net yaz",
      sourceHeadline: "Daily EV Briefing",
      sourceMarkdown: "# Daily EV Briefing\n- [A1] Item",
      sourceText: "Daily EV Briefing\n- [A1] Item",
      citationCatalog: [{ citation_id: "A1", article_id: 1, title: "Item", url: "https://example.com/item" }],
      sourceArticles: [{ citation_id: "A1", title: "Item", url: "https://example.com/item", summary: "summary" }],
    });

    expect(prompt).toContain("Turkish (Turkiye Turkcesi)");
    expect(prompt).toContain("[A1]");
    expect(prompt).toContain("Kisa ve net yaz");
  });
});
