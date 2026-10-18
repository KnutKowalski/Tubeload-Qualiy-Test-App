import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Roher HTTP-Request (erlaubt beliebige Host-/Origin-Header, anders als fetch). */
export function request(
  port: number,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          })
        );
      }
    );

    req.on("error", reject);

    if (opts.body !== undefined) req.write(opts.body);

    req.end();
  });
}

function chromeCandidates(): string[] {
  const out: string[] = [];

  if (process.env.TB_CHROME_PATH) out.push(process.env.TB_CHROME_PATH);

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;

  if (root && fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      if (d.startsWith("chromium-")) {
        out.push(path.join(root, d, "chrome-linux", "chrome"));
      }
    }
  }

  return out.filter((p) => fs.existsSync(p));
}

/** Startet einen Chromium für die E2E-Tests. Gibt null zurück, wenn keiner verfügbar ist. */
export async function launchTestBrowser(): Promise<Browser | null> {
  const args = ["--autoplay-policy=no-user-gesture-required", "--mute-audio"];

  // Als root (z. B. in Containern) startet Chromium nur ohne Sandbox.
  if (process.getuid?.() === 0) args.push("--no-sandbox");

  for (const executablePath of chromeCandidates()) {
    try {
      return await chromium.launch({ executablePath, headless: true, args });
    } catch {
      // nächster Kandidat
    }
  }

  try {
    return await chromium.launch({ channel: "chrome", headless: true, args });
  } catch {
    return null;
  }
}
