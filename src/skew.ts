import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { kubectl, parseJSON, object, text } from "./kubectl.js";
import type { Target, Deadline } from "./registry.js";
export function skewWarning(
  client: string,
  server: string,
): string | undefined {
  const a = Number.parseInt(client),
    b = Number.parseInt(server);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 1
    ? `kubectl/server minor skew exceeds one: 1.${client} vs 1.${server}`
    : undefined;
}
export async function versionWarning(
  t: Target,
  d: Deadline,
): Promise<string | undefined> {
  const dir = join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "k8s-axi",
    ),
    file = join(
      dir,
      createHash("sha256")
        .update(t.context + t.server)
        .digest("hex") + ".json",
    );
  try {
    let server: string | undefined;
    try {
      const cache = object(JSON.parse(await readFile(file, "utf8")));
      if (typeof cache.at === "number" && Date.now() - cache.at < 43200000)
        server = text(cache.minor) || undefined;
    } catch {
      /* Advisory cache miss. */
    }
    const client = object(
      object(
        parseJSON(
          await kubectl({ op: "local", query: "client-version" }, undefined, d),
        ),
      ).clientVersion,
    );
    if (!server) {
      const raw = object(
        parseJSON(await kubectl({ op: "server-version" }, t, d)),
      );
      server = text(object(raw.serverVersion).minor);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(
          file,
          JSON.stringify({ at: Date.now(), minor: server }),
          { mode: 0o600 },
        );
      } catch {
        /* Advisory caching must not fail reads. */
      }
    }
    return skewWarning(text(client.minor), server);
  } catch {
    return "client/server version check unavailable";
  }
}
