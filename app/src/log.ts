type Level = "debug" | "info" | "warn" | "error";

export function log(level: Level, message: string, meta?: unknown): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
  };
  if (meta !== undefined) line.meta = meta;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}
