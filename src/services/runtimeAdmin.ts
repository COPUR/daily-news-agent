import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

type ConfigSpec = {
  key: string;
  type: "string" | "int" | "float" | "bool";
  description: string;
  choices?: string[];
};

const CONFIG_SPECS: ConfigSpec[] = [
  { key: "LOG_LEVEL", type: "string", description: "Application log level", choices: ["debug", "info", "warn", "error"] },
  { key: "REQUEST_TIMEOUT_SECONDS", type: "int", description: "HTTP request timeout seconds" },
  { key: "REQUEST_RATE_LIMIT_SECONDS", type: "float", description: "Polite request delay seconds" },
  { key: "DAILY_POST_HOUR_UTC", type: "int", description: "Daily schedule hour UTC" },
  { key: "DAILY_POST_MINUTE_UTC", type: "int", description: "Daily schedule minute UTC" },
  { key: "DAILY_POST_LANGUAGE", type: "string", description: "Output language", choices: ["en", "tr"] },
  { key: "LLM_PROVIDER", type: "string", description: "Provider", choices: ["none", "openai", "ollama", "huggingface", "xai"] },
  { key: "OPENAI_MODEL", type: "string", description: "OpenAI model" },
  { key: "OLLAMA_BASE_URL", type: "string", description: "Ollama URL" },
  { key: "OLLAMA_MODEL", type: "string", description: "Ollama model" },
  { key: "HUGGINGFACE_MODEL_ID", type: "string", description: "Hugging Face model id" },
  { key: "XAI_MODEL", type: "string", description: "xAI model" },
  { key: "TWITTER_POST_HANDLE", type: "string", description: "X handle for post URLs" },
  { key: "SERPER_ENDPOINT", type: "string", description: "Serper endpoint" },
  { key: "NEWSLETTER_NOSQL_PATH", type: "string", description: "Newsletter NoSQL file path" },
  { key: "SUPPORTED_SCRAPE_LANGUAGES_CSV", type: "string", description: "Supported scrape languages" },
];

const SECRET_KEYS = [
  "OPENAI_API_KEY",
  "HUGGINGFACE_API_KEY",
  "TWITTER_BEARER_TOKEN",
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_TOKEN_SECRET",
  "SERPER_API_KEY",
  "XAI_API_KEY",
] as const;

function envPath() {
  return path.resolve(process.cwd(), ".env");
}

function ensureEnvFile() {
  const file = envPath();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "", "utf-8");
  }
  return file;
}

function loadEnvFileMap(): Map<string, string> {
  const content = fs.readFileSync(ensureEnvFile(), "utf-8");
  const map = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    map.set(key, value);
  }
  return map;
}

function persistEnvMap(map: Map<string, string>) {
  const lines = [...map.entries()].map(([key, value]) => `${key}=${value}`);
  fs.writeFileSync(ensureEnvFile(), lines.join("\n") + "\n", "utf-8");
}

function coerce(spec: ConfigSpec, raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("value cannot be empty");
  }
  if (spec.choices && !spec.choices.includes(value)) {
    throw new Error(`value must be one of: ${spec.choices.join(", ")}`);
  }
  if (spec.type === "int") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) throw new Error("invalid integer value");
    return String(parsed);
  }
  if (spec.type === "float") {
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed)) throw new Error("invalid float value");
    return String(parsed);
  }
  if (spec.type === "bool") {
    if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return "true";
    if (["false", "0", "no", "off"].includes(value.toLowerCase())) return "false";
    throw new Error("invalid boolean value");
  }
  return value;
}

function currentValue(key: string, map: Map<string, string>) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return String(process.env[key] ?? "");
  }
  if (map.has(key)) {
    return String(map.get(key) ?? "");
  }
  return String((env as Record<string, unknown>)[key] ?? "");
}

function mask(value?: string | null) {
  if (!value) return null;
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export function listConfig() {
  const map = loadEnvFileMap();
  return CONFIG_SPECS.map((spec) => ({
    key: spec.key,
    value: currentValue(spec.key, map),
    valueType: spec.type,
    description: spec.description,
    choices: spec.choices ?? null,
  }));
}

export function updateConfig(key: string, value: string) {
  const spec = CONFIG_SPECS.find((item) => item.key === key);
  if (!spec) throw new Error(`unsupported config key: ${key}`);

  const normalized = coerce(spec, value);
  const map = loadEnvFileMap();
  map.set(key, normalized);
  persistEnvMap(map);
  process.env[key] = normalized;

  return {
    key,
    value: normalized,
    valueType: spec.type,
    description: spec.description,
    choices: spec.choices ?? null,
  };
}

export function listSecrets() {
  const map = loadEnvFileMap();
  return SECRET_KEYS.map((key) => {
    const value = process.env[key] || map.get(key) || "";
    return {
      key,
      configured: Boolean(value),
      maskedPreview: mask(value),
    };
  });
}

export function setSecret(key: string, value: string) {
  if (!SECRET_KEYS.includes(key as (typeof SECRET_KEYS)[number])) throw new Error(`unsupported secret key: ${key}`);
  if (!value.trim()) throw new Error("secret value cannot be empty");

  const map = loadEnvFileMap();
  map.set(key, value.trim());
  persistEnvMap(map);
  process.env[key] = value.trim();

  return { key, configured: true, maskedPreview: mask(value.trim()) };
}

export function clearSecret(key: string) {
  if (!SECRET_KEYS.includes(key as (typeof SECRET_KEYS)[number])) throw new Error(`unsupported secret key: ${key}`);

  const map = loadEnvFileMap();
  map.delete(key);
  persistEnvMap(map);
  delete process.env[key];

  return { key, configured: false, maskedPreview: null };
}
