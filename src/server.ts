import http from "node:http";
import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createApiRouter } from "./routes/api.js";
import { prisma } from "./db/client.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";

const app = express();
app.disable("x-powered-by");
app.use((_request, reply, next) => {
  reply.setHeader("X-Content-Type-Options", "nosniff");
  reply.setHeader("X-Frame-Options", "DENY");
  reply.setHeader("Referrer-Policy", "no-referrer");
  reply.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(createApiRouter());

let server: http.Server | null = null;

function listenAsync() {
  return new Promise<void>((resolve, reject) => {
    const instance = app.listen(env.APP_PORT, env.APP_HOST, () => {
      server = instance;
      resolve();
    });
    instance.on("error", reject);
  });
}

async function bootstrap() {
  try {
    await prisma.$connect();
    startScheduler();

    await listenAsync();
    logger.info({ host: env.APP_HOST, port: env.APP_PORT }, "server_started");
  } catch (error) {
    logger.error({ error: String(error) }, "server_failed");
    process.exit(1);
  }
}

async function shutdown() {
  stopScheduler();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    server = null;
  }
  await prisma.$disconnect();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

await bootstrap();
