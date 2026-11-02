export function elapsed(created: string, now = Date.now()): number {
  const t = Date.parse(created);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0;
}
export function age(created: string, now = Date.now()): string {
  if (!created || !Number.isFinite(Date.parse(created))) return "unknown";
  const seconds = elapsed(created, now);
  for (const [unit, size] of [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ] as const)
    if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`;
  return "0s";
}
