import { config as loadEnv } from "dotenv";
import path from "node:path";
import { z } from "zod";

loadEnv({ path: path.resolve(process.cwd(), ".env") });

const schema = z.object({
  APP_NAME: z.string().default("Daily News Agent (Node)"),
  APP_HOST: z.string().default("0.0.0.0"),
  APP_PORT: z.coerce.number().default(8000),
  DATABASE_URL: z.string().default("file:./data/ev_news_node.db"),
  LOG_LEVEL: z.string().default("info"),

  USER_AGENT: z.string().default("DailyNewsAgentNode/1.0 (+local-first)"),
  REQUEST_TIMEOUT_SECONDS: z.coerce.number().default(25),
  REQUEST_RATE_LIMIT_SECONDS: z.coerce.number().default(1.5),

  DAILY_POST_HOUR_UTC: z.coerce.number().default(0),
  DAILY_POST_MINUTE_UTC: z.coerce.number().default(5),
  DAILY_ITEMS_MIN: z.coerce.number().default(3),
  DAILY_ITEMS_MAX: z.coerce.number().default(7),
  DAILY_ITEMS_DEFAULT: z.coerce.number().default(5),

  LLM_PROVIDER: z.enum(["none", "openai", "ollama", "huggingface", "xai"]).default("none"),
  DAILY_POST_LANGUAGE: z.enum(["en", "tr"]).default("en"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),
  HUGGINGFACE_API_KEY: z.string().optional(),
  HUGGINGFACE_MODEL_ID: z.string().default("ytu-ce-cosmos/Turkish-Llama-8b-Instruct-v0.1"),
  XAI_API_KEY: z.string().optional(),
  XAI_BASE_URL: z.string().default("https://api.x.ai/v1"),
  XAI_MODEL: z.string().default("grok-4-0709"),

  TWITTER_BEARER_TOKEN: z.string().optional(),
  TWITTER_API_KEY: z.string().optional(),
  TWITTER_API_SECRET: z.string().optional(),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  TWITTER_ACCESS_TOKEN_SECRET: z.string().optional(),
  TWITTER_POST_HANDLE: z.string().optional(),

  SERPER_API_KEY: z.string().optional(),
  SERPER_ENDPOINT: z.string().default("https://google.serper.dev/search"),

  NEWSLETTER_NOSQL_PATH: z.string().default("./.runtime/newsletter_documents.json"),
  SUPPORTED_SCRAPE_LANGUAGES_CSV: z
    .string()
    .default("en,tr,zh,ru,uk,fr,de,es,it,pt,nl,pl,sv,no,fi,da,cs,ro,hu,el,bg,sr,hr,sk,sl,et,lv,lt"),
});

const parsed = schema.parse(process.env);

export const env = {
  ...parsed,
  DAILY_ITEMS: Math.max(parsed.DAILY_ITEMS_MIN, Math.min(parsed.DAILY_ITEMS_DEFAULT, parsed.DAILY_ITEMS_MAX)),
  SUPPORTED_SCRAPE_LANGUAGES: parsed.SUPPORTED_SCRAPE_LANGUAGES_CSV.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
};
