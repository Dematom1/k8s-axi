import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { decode } from "@toon-format/toon";
export function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const p = spawnSync(
    process.execPath,
    [
      resolve(process.env.K8S_AXI_TEST_PACKAGE ?? ".", "dist/bin/k8s-axi.js"),
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: "", ...env },
      timeout: 10000,
    },
  );
  if (p.error) throw p.error;
  const data = args.some((x) => ["--version", "-v", "-V"].includes(x))
    ? p.stdout.trim()
    : decode(p.stdout, { strict: true });
  return { ...p, data };
}
