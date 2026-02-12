import { prisma } from "../db/client.js";
import { runPipeline } from "../services/pipeline.js";

async function main() {
  await prisma.$connect();
  const outcome = await runPipeline({ forcePost: false });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(outcome, null, 2));
  await prisma.$disconnect();
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
