import type { Page } from "playwright-core";
import { acceptConsent } from "./consent";
import type { ConsentMode } from "./types";

export async function resolveChannelVideos(
  page: Page,
  channelUrl: string,
  maxVideos = 25,
  consentMode: ConsentMode = "reject"
): Promise<string[]> {
  const base = channelUrl.replace(/\/$/, "");
  const videosUrl = base.endsWith("/videos") ? base : `${base}/videos`;

  await page.goto(videosUrl, {
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
