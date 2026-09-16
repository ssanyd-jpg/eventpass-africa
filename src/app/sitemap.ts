import type { MetadataRoute } from "next";
import { getPublishedEventSlugs } from "@/lib/marketplace";

const SITE_URL = process.env.NEXTAUTH_URL ?? "https://chaap.africa";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const events = await getPublishedEventSlugs();

  return [
    { url: SITE_URL, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/events`, changeFrequency: "hourly", priority: 0.9 },
    ...events.map((event) => ({
      url: `${SITE_URL}/events/${event.slug}`,
      lastModified: event.updatedAt,
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
  ];
}
