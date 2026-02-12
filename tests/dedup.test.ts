import { describe, expect, it } from "vitest";
import { clusterCandidates } from "../src/services/dedup.js";
import { computeSimhash, localEmbedding } from "../src/utils/text.js";

function candidate(id: number, title: string, normalizedUrl: string, content: string) {
  return {
    id,
    title,
    normalizedUrl,
    content,
    publishedAt: new Date("2026-02-11T00:00:00Z"),
    simhash: computeSimhash(content),
    embedding: localEmbedding(content),
  };
}

describe("Dedup clustering", () => {
  it("groups exact normalized URL matches into one cluster", () => {
    const candidates = [
      candidate(1, "Tesla expands battery line", "https://example.com/a", "tesla battery line expansion"),
      candidate(2, "Tesla battery line expansion", "https://example.com/a", "tesla battery line expansion details"),
      candidate(3, "Unrelated AV policy", "https://example.com/b", "new autonomous driving policy in eu"),
    ];

    const clusters = clusterCandidates(candidates);
    expect(clusters.length).toBe(2);
    const sizes = clusters.map((cluster) => cluster.members.length).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 2]);
  });

  it("does not over-merge unrelated stories", () => {
    const candidates = [
      candidate(1, "NVIDIA automotive chips", "https://a.com/1", "nvidia chips for automotive stack"),
      candidate(2, "Battery recycling policy", "https://b.com/2", "battery recycling policy and regulation"),
      candidate(3, "Openpilot feature update", "https://c.com/3", "openpilot release notes and lane assist"),
    ];

    const clusters = clusterCandidates(candidates);
    expect(clusters.length).toBe(3);
    expect(clusters.every((cluster) => cluster.members.length === 1)).toBe(true);
  });
});
