export function redactText(input: string): { text: string; count: number } {
  let count = 0;
  const replace = (
    pattern: RegExp,
    value: string | ((...args: string[]) => string),
  ) => {
    input = input.replace(pattern, (...args: string[]) => {
      count++;
      return typeof value === "string" ? value : value(...args);
    });
  };
  replace(
    /-----BEGIN [^-\n]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-\n]+-----/g,
    "[REDACTED PEM]",
  );
  replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]");
  replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]+)\b/g,
    "[REDACTED]",
  );
  replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, (_m, p = "") => p + "[REDACTED]");
  replace(
    /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,
    (_m, p = "") => p + "[REDACTED]@",
  );
  // Match both JSON and escaped JSON without decoding attacker-controlled text.
  replace(
    /((?:[\\]*["'])?(?:[A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)|[A-Za-z0-9_]+_(?:PASS|PWD|KEY))(?:[\\]*["'])?\s*[:=]\s*)(?:[\\]*["'][^\r\n]*?(?=[\\]*["'](?:\s*[,}\r\n]|$))[\\]*["']|[^\s,;}]+)/gi,
    (_m, p = "") => p + "[REDACTED]",
  );
  replace(/\b[A-Za-z0-9+/]{32,}={1,2}(?![A-Za-z0-9+/=])/g, "[REDACTED BASE64]");
  return { text: input, count };
}
