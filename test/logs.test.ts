import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
for (const annotation of [undefined, "a"])
  test(`container selection ${annotation}`, () => {
    const pod = {
      metadata: {
        name: "p",
        annotations: { "kubectl.kubernetes.io/default-container": annotation },
      },
      spec: { containers: [{ name: "a" }, { name: "b" }] },
    };
    const l = lab([
      { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
      {
        prefix: ["logs"],
        stdout: "password=CANARY\nDB_PASS=CANARY\nnormal log\n",
      },
      ...targetRules(),
    ]);
    try {
      const p = cli(["pods", "logs", "p"], l.env);
      expect(p.status).toBe(annotation ? 0 : 2);
      if (annotation) {
        expect(p.stdout).not.toContain("CANARY");
        expect(p.stdout).toContain("best effort");
        expect(p.stdout).toContain("redacted: 2");
      } else expect(p.stdout).toContain("a, b");
      expect(
        cli(
          [
            "pods",
            "logs",
            "p",
            "-c",
            "b",
            "--tail",
            "50",
            "--since",
            "15m",
            "--previous",
          ],
          l.env,
        ).status,
      ).toBe(0);
      const calls = l.calls().filter((c) => c.args[0] === "logs");
      expect(calls.at(-1).args).toContain("--limit-bytes=1048576");
      expect(calls.at(-1).args).toContain("--since=900s");
      expect(calls.at(-1).args).toContain("--previous");
      expect(cli(["pods", "logs", "p", "--follow"], l.env).status).toBe(2);
      expect(cli(["pods", "logs", "p", "--tail", "5000"], l.env).status).toBe(
        2,
      );
    } finally {
      l.clean();
    }
  });
for (const missing of ["namespace", "pod"])
  test(`missing ${missing} logs`, () => {
    const l = lab([
      {
        prefix: ["get", missing],
        stderr: "Error from server (NotFound)",
        code: 1,
      },
      ...targetRules(),
    ]);
    try {
      const p = cli(["pods", "logs", "missing"], l.env);
      expect(p.status).toBe(1);
      expect(p.stdout).toContain(
        missing === "namespace" ? "NAMESPACE_NOT_FOUND" : "NOT_FOUND",
      );
    } finally {
      l.clean();
    }
  });
