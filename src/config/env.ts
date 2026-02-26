import { config as loadEnv } from "dotenv";
import path from "node:path";
import { z } from "zod";

loadEnv({ path: path.resolve(process.cwd(), ".env") });

function parseBooleanFlag(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

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

  KEYCLOAK_ENABLED: z.string().default("false"),
  KEYCLOAK_BASE_URL: z.string().default("http://localhost:8080"),
  KEYCLOAK_REALM: z.string().default("master"),
  KEYCLOAK_CLIENT_ID: z.string().default("daily-news-agent"),
  KEYCLOAK_AUDIENCE: z.string().optional(),
  KEYCLOAK_SCOPE: z.string().default("openid profile email"),
  KEYCLOAK_ISSUER_URL: z.string().optional(),
  KEYCLOAK_CLOCK_SKEW_SECONDS: z.coerce.number().default(30),
  KEYCLOAK_JWKS_CACHE_SECONDS: z.coerce.number().default(300),
  KEYCLOAK_ADMIN_ROLES_CSV: z.string().default("admin,super-admin"),
  KEYCLOAK_OPERATOR_ROLES_CSV: z.string().default("operator,admin,super-admin"),
  KEYCLOAK_EDITOR_ROLES_CSV: z.string().default("editor,operator,admin,super-admin"),
  KEYCLOAK_ANALYST_ROLES_CSV: z.string().default("viewer,analyst,editor,operator,admin,super-admin"),

  INTERNAL_AUTH_ENABLED: z.string().default("false"),
  INTERNAL_AUTH_USERNAME: z.string().default("internal-service"),
  INTERNAL_AUTH_PASSWORD: z.string().optional(),
  INTERNAL_AUTH_PASSWORD_HASH: z.string().optional(),
  INTERNAL_AUTH_JWT_SECRET: z.string().optional(),
  INTERNAL_AUTH_ISSUER: z.string().default("daily-news-agent.internal"),
  INTERNAL_AUTH_AUDIENCE: z.string().default("daily-news-agent.business"),
  INTERNAL_AUTH_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  INTERNAL_AUTH_ALLOWED_CLOCK_SKEW_SECONDS: z.coerce.number().default(30),
  INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(60),
  INTERNAL_AUTH_RATE_LIMIT_MAX_ATTEMPTS: z.coerce.number().default(5),

  NEWSLETTER_NOSQL_PATH: z.string().default("./.runtime/newsletter_documents.json"),
  SUPPORTED_SCRAPE_LANGUAGES_CSV: z
    .string()
    .default("en,tr,zh,ru,uk,fr,de,es,it,pt,nl,pl,sv,no,fi,da,cs,ro,hu,el,bg,sr,hr,sk,sl,et,lv,lt"),
});

const parsed = schema.parse(process.env);

export const env = {
  ...parsed,
  KEYCLOAK_ENABLED: parseBooleanFlag(parsed.KEYCLOAK_ENABLED, false),
  KEYCLOAK_CLOCK_SKEW_SECONDS: Math.max(0, Math.min(parsed.KEYCLOAK_CLOCK_SKEW_SECONDS, 300)),
  KEYCLOAK_JWKS_CACHE_SECONDS: Math.max(30, Math.min(parsed.KEYCLOAK_JWKS_CACHE_SECONDS, 24 * 60 * 60)),
  INTERNAL_AUTH_ENABLED: parseBooleanFlag(parsed.INTERNAL_AUTH_ENABLED, false),
  INTERNAL_AUTH_TOKEN_TTL_SECONDS: Math.max(60, Math.min(parsed.INTERNAL_AUTH_TOKEN_TTL_SECONDS, 24 * 60 * 60)),
  INTERNAL_AUTH_ALLOWED_CLOCK_SKEW_SECONDS: Math.max(0, Math.min(parsed.INTERNAL_AUTH_ALLOWED_CLOCK_SKEW_SECONDS, 300)),
  INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS: Math.max(5, Math.min(parsed.INTERNAL_AUTH_RATE_LIMIT_WINDOW_SECONDS, 60 * 60)),
  INTERNAL_AUTH_RATE_LIMIT_MAX_ATTEMPTS: Math.max(1, Math.min(parsed.INTERNAL_AUTH_RATE_LIMIT_MAX_ATTEMPTS, 200)),
  DAILY_ITEMS: Math.max(parsed.DAILY_ITEMS_MIN, Math.min(parsed.DAILY_ITEMS_DEFAULT, parsed.DAILY_ITEMS_MAX)),
  SUPPORTED_SCRAPE_LANGUAGES: parsed.SUPPORTED_SCRAPE_LANGUAGES_CSV.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
};
