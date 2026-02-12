import { PrismaClient, SourceType } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const defaults = [
    {
      sourceType: SourceType.rss,
      name: "Electrek RSS",
      enabled: true,
      pollingMinutes: 180,
      tagsJson: JSON.stringify(["EV", "Battery"]),
      configJson: JSON.stringify({ url: "https://electrek.co/feed/" }),
      authJson: null,
    },
    {
      sourceType: SourceType.rss,
      name: "InsideEVs RSS",
      enabled: true,
      pollingMinutes: 180,
      tagsJson: JSON.stringify(["EV", "SDV"]),
      configJson: JSON.stringify({ url: "https://insideevs.com/rss/" }),
      authJson: null,
    },
    {
      sourceType: SourceType.scrape,
      name: "Batteries News",
      enabled: false,
      pollingMinutes: 360,
      tagsJson: JSON.stringify(["Battery"]),
      configJson: JSON.stringify({
        listUrls: ["https://www.batteriesnews.com/"],
        articleLinkSelector: "a[href*='/news/']",
      }),
      authJson: null,
    },
    {
      sourceType: SourceType.grok,
      name: "Grok EV Search",
      enabled: false,
      pollingMinutes: 240,
      tagsJson: JSON.stringify(["AV", "Vehicle Software", "BMS", "Battery", "SDV", "EV"]),
      configJson: JSON.stringify({
        query: "electric vehicle OR software-defined vehicle OR battery manufacturing",
        limit: 10,
      }),
      authJson: null,
    },
  ];

  for (const source of defaults) {
    await prisma.source.upsert({
      where: { name: source.name },
      update: source,
      create: source,
    });
  }

  // eslint-disable-next-line no-console
  console.log("Seed complete");
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
