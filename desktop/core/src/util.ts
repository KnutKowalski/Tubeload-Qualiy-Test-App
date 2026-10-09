import type { QualityLabel } from "./types";

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };

    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const rand = (min: number, max: number) =>
  Math.random() * (max - min) + min;

export const randInt = (min: number, max: number) =>
  Math.floor(rand(min, max + 1));

export const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), max);

export function pickWeighted<T>(items: [T, number][]): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let r = Math.random() * total;

  for (const [value, weight] of items) {
    r -= weight;
    if (r <= 0) return value;
  }

  return items[items.length - 1][0];
}

export const QUALITY_CODE: Record<QualityLabel, string> = {
  auto: "default",
  "144p": "tiny",
  "240p": "small",
  "360p": "medium",
  "480p": "large",
  "720p": "hd720",
  "1080p": "hd1080",
  "1440p": "hd1440",
  "2160p": "hd2160",
};

export function qualityToCode(label: QualityLabel): string {
  return QUALITY_CODE[label] ?? "default";
}
