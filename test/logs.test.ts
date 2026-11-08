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
        stdout:
          "password=CANARY\nDB_PASS=CANARY\nunable to retrieve container logs for fixture\nnormal log\n",
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
        expect(p.stdout).toContain(
          "unable to retrieve container logs for fixture",
        );
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
      const logs = cli(["pods", "logs", "p", "-c", "a"], l.env);
      expect(logs.stdout).toContain("normal log");
      expect(logs.stdout).not.toContain("help:");
      expect(cli(["pods", "logs", "p", "--follow"], l.env).status).toBe(2);
      expect(cli(["pods", "logs", "p", "--tail", "5000"], l.env).status).toBe(
        2,
      );
    } finally {
      l.clean();
    }
  });
test("reports the exact newest tail, omitted count, and shown range", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    { prefix: ["logs"], stdout: "older\nnewer-1\nnewer-2\n" },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p", "-c", "c", "--tail", "2"], l.env);
    expect(p.status).toBe(0);
    expect(p.data.logs).toEqual(["newer-1", "newer-2"]);
    expect(p.data["omitted-lines"]).toBe(1);
    expect(p.data.shown).toBe("newer-1..newer-2");
  } finally {
    l.clean();
  }
});

test("preserves a logged blank line but drops the final newline artifact", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    { prefix: ["logs"], stdout: "foo\n\n" },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p", "-c", "c"], l.env);
    expect(p.status).toBe(0);
    expect(p.data.logs).toEqual(["foo", ""]);
    expect(p.data["omitted-lines"]).toBe(0);
  } finally {
    l.clean();
  }
});

test("applies the output byte budget to multibyte lines", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const older = "é".repeat(4000);
  const newest = "界".repeat(3000);
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    { prefix: ["logs"], stdout: `${older}\n${older}\n${newest}\n` },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p", "-c", "c"], l.env);
    expect(p.status).toBe(0);
    expect(p.data.logs).toEqual([newest]);
    expect(p.data["omitted-lines"]).toBe(2);
  } finally {
    l.clean();
  }
});

test("keeps a newest whole line larger than the output budget", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const newest = `line ${"x".repeat(10_001)}`;
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    { prefix: ["logs"], stdout: `older line\n${newest}\n` },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p", "-c", "c"], l.env);
    expect(p.status).toBe(0);
    expect(p.data.logs).toEqual([newest]);
    expect(p.data["omitted-lines"]).toBe(1);
  } finally {
    l.clean();
  }
});

test("continuation hints retain an inferred container", () => {
  const pod = {
    metadata: {
      name: "p",
      annotations: { "kubectl.kubernetes.io/default-container": "a" },
    },
    spec: { containers: [{ name: "a" }, { name: "b" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    {
      prefix: ["logs"],
      stdout: `${Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")}\n`,
    },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p"], l.env);
    expect(p.status).toBe(0);
    expect(p.data.help[0]).toContain("-c a --tail 100");
  } finally {
    l.clean();
  }
});

test("a full tail gives a runnable continuation hint", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    {
      prefix: ["logs"],
      stdout: `${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")}\n`,
    },
    ...targetRules(),
  ]);
  try {
    const p = cli(
      [
        "pods",
        "logs",
        "p",
        "-c",
        "c",
        "--tail",
        "1000",
        "--since",
        "15m",
        "--previous",
      ],
      l.env,
    );
    expect(p.status).toBe(0);
    expect(p.data.help).toEqual([
      'Run `k8s-axi pods logs p -n sandbox --context "default" -c c --tail 1000 --since 900s --previous --full` for the newest logs',
    ]);
    const continued = cli(
      [
        "pods",
        "logs",
        "p",
        "-n",
        "sandbox",
        "--context",
        "default",
        "-c",
        "c",
        "--tail",
        "1000",
        "--since",
        "900s",
        "--previous",
        "--full",
      ],
      l.env,
    );
    expect(continued.status).toBe(0);
    const logCall = l.calls().filter((call) => call.args[0] === "logs").at(-1);
    expect(logCall.args).toContain("--tail=1000");
    expect(logCall.args).toContain("--since=900s");
    expect(logCall.args).toContain("--previous");
    expect(logCall.args).toContain("-c");
    expect(logCall.args).toContain("c");
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
