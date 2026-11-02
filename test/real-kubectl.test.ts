import { test, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { fakeAPI } from "./fake-apiserver/server.js";
const hasKubectl =
  spawnSync("kubectl", ["version", "--client", "-o", "json"]).status === 0;
test("required real binary available", () => {
  if (process.env.K8S_AXI_REQUIRE_REAL_KUBECTL === "1")
    expect(hasKubectl).toBe(true);
});
export async function asyncCli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ stdout: string; stderr: string; status: number | null }>(
    (r, j) => {
      const p = spawn(
        process.execPath,
        [
          resolve(
            process.env.K8S_AXI_TEST_PACKAGE ?? ".",
            "dist/bin/k8s-axi.js",
          ),
          ...args,
        ],
        { env: { ...process.env, ...env } },
      );
      let stdout = "",
        stderr = "";
      p.stdout.on("data", (b) => (stdout += String(b)));
      p.stderr.on("data", (b) => (stderr += String(b)));
      p.on("error", j);
      p.on("close", (status) => {
        decode(stdout, { strict: true });
        r({ stdout, stderr, status });
      });
    },
  );
}
test.skipIf(!hasKubectl)(
  "real template projection, GET-only, kuberc isolation and continue failures",
  async () => {
    const api = await fakeAPI();
    const env = { HOME: api.dir, KUBECONFIG: api.kubeconfig };
    try {
      for (const args of [
        ["secrets"],
        ["secrets", "-A"],
        ["secrets", "view", "first"],
      ]) {
        const a = await asyncCli(args, env),
          b = await asyncCli([...args, "--full"], env);
        expect(a.status, a.stdout).toBe(0);
        expect(b.status, b.stdout).toBe(0);
        expect(a.stdout).toBe(b.stdout);
        expect(a.stdout + a.stderr + b.stdout + b.stderr).not.toContain(
          "CANARY",
        );
        if (args.includes("view")) expect(a.stdout).toContain("tls.crt");
        else {
          expect(a.stdout).toContain("2 of 2 total");
          expect(a.stdout).toContain("first");
          expect(a.stdout).toContain("second");
        }
      }
      expect(
        (await asyncCli(["secrets", "view", "absent"], env)).stdout,
      ).toContain("NOT_FOUND");
      expect(api.calls.every((c) => c.method === "GET")).toBe(true);
      expect(api.calls.every((c) => !c.path.includes("canary"))).toBe(true);
      expect(api.calls.some((c) => c.path.includes("continue=next"))).toBe(
        true,
      );
      api.expire();
      const p = await asyncCli(["secrets", "-A"], env);
      expect(p.status).toBe(1);
      expect(p.stdout).not.toContain("first");
    } finally {
      await api.close();
    }
  },
  30000,
);
