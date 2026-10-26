type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = String(process.env.TB_LOG_LEVEL ?? "info").toLowerCase();
  return ORDER[env as Level] ?? ORDER.info;
}

function format(extra: unknown): string {
  if (extra === undefined) return "";

  if (extra instanceof Error) {
    return ` | ${extra.stack ?? extra.message}`;
  }

  if (typeof extra === "string") return ` | ${extra}`;

  try {
    return ` | ${JSON.stringify(extra)}`;
  } catch {
    return ` | ${String(extra)}`;
  }
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold()) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${format(extra)}\n`;

  if (level === "warn" || level === "error") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};
