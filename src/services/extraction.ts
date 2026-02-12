import { canonicalDomain } from "../utils/url.js";
import { Topic } from "@prisma/client";
import { textRetrievalTool } from "./retrievalTools.js";

const NUMBER_PATTERN = /\b(\d+(?:\.\d+)?)\s*(kwh|gwh|mwh|km|miles|usd|\$|eur|cny|tl|units|vehicles|percent|%)\b/gi;

const TOPIC_RULES: Array<{ topic: Topic; keywords: string[] }> = [
  { topic: Topic.AV, keywords: ["autonomous", "self-driving", "robotaxi", "driverless", "otonom"] },
  { topic: Topic.VEHICLE_SOFTWARE, keywords: ["vehicle software", "automotive software", "ota", "middleware"] },
  { topic: Topic.BMS, keywords: ["bms", "battery management", "batarya yönetim"] },
  { topic: Topic.BATTERY, keywords: ["battery", "batarya", "cell", "cathode", "anode", "lfp", "nmc"] },
  { topic: Topic.SDV, keywords: ["software-defined vehicle", "sdv", "yazılım tanımlı araç"] },
  { topic: Topic.EV, keywords: ["electric vehicle", "ev", "charging", "şarj"] },
];

const COMPANY_HINTS = [
  "Tesla",
  "BYD",
  "NVIDIA",
  "Openpilot",
  "CATL",
  "Ford",
  "GM",
  "Volkswagen",
  "Hyundai",
  "Rivian",
  "NIO",
  "XPeng",
  "Togg",
  "Panasonic",
  "LG Energy Solution",
  "Samsung SDI",
];

export async function extractFullTextFromUrl(url: string): Promise<{
  text: string | null;
  language: string | null;
  blocked: boolean;
  blockedReason: string | null;
  finalUrl: string;
}> {
  const retrieved = await textRetrievalTool({ query: url });
  return {
    text: retrieved.response,
    language: retrieved.language,
    blocked: retrieved.blocked,
    blockedReason: retrieved.blockedReason,
    finalUrl: retrieved.url,
  };
}

export function classifyTopic(title: string, summary?: string | null, fullText?: string | null): Topic {
  const haystack = [title, summary || "", fullText || ""].join(" ").toLowerCase();
  for (const rule of TOPIC_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      return rule.topic;
    }
  }
  return Topic.OTHER;
}

export function extractFacts(title: string, summary: string | null | undefined, fullText: string | null | undefined, url: string) {
  const content = [title, summary || "", fullText || ""].join(" ");
  const numbers = [...content.matchAll(NUMBER_PATTERN)].slice(0, 20).map((match) => ({
    value: match[1],
    unit: match[2],
  }));
  const companies = COMPANY_HINTS.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(content)).slice(0, 12);

  const sentence = content.split(/(?<=[.!?])\s+/).find((item) => item.trim().length > 40) || title;

  return {
    who: companies,
    what: sentence.trim().slice(0, 320),
    when: null,
    where: canonicalDomain(url),
    numbers,
    captured_at: new Date().toISOString(),
  };
}
