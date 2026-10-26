import type { Page } from "playwright-core";
import { acceptConsent } from "./consent";
import { LIMITS } from "./limits";
import type { ConsentMode } from "./types";
import { channelVideosUrl } from "./url";

export async function resolveChannelVideos(
  page: Page,
  channelUrl: string,
  maxVideos: number = LIMITS.maxChannelVideos,
  consentMode: ConsentMode = "reject"
): Promise<string[]> {
  await page.goto(channelVideosUrl(channelUrl), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await acceptConsent(page, consentMode);
  await page.waitForTimeout(2500);

  const ids = await page.evaluate((max: number) => {
    const out: string[] = [];
    const seen = new Set<string>();

    const links = Array.from(
      document.querySelectorAll('a#video-title, a[href*="/watch?v="]')
    );

    for (const a of links) {
      try {
        const href = (a as HTMLAnchorElement).href;
        const url = new URL(href, location.href);
        const v = url.searchParams.get("v");

        if (v && !seen.has(v)) {
          seen.add(v);
          out.push(v);
        }

        if (out.length >= max) break;
      } catch {}
    }

    if (out.length === 0) {
      try {
        const data = (window as any).ytInitialData;
        const json = JSON.stringify(data ?? {});
        const rx = /"videoId":"([\w-]{11})"/g;
        let m: RegExpExecArray | null;

        while ((m = rx.exec(json)) && out.length < max) {
          const v = m[1];

          if (!seen.has(v)) {
            seen.add(v);
            out.push(v);
          }
        }
      } catch {}
    }

    return out;
  }, maxVideos);

  return ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
}
