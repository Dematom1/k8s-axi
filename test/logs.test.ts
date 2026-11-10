import { test, expect } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules } from "./lab.js";
import { LOG_LIMIT_BYTES } from "../src/registry.js";

type LogsOutput = {
  logs: string[];
  "byte-limited": boolean;
  "omitted-lines": number | null;
  "more-lines": boolean;
  shown: string[];
  help?: string[];
};
const logsOutput = (result: ReturnType<typeof cli>) =>
  result.data as LogsOutput;
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
      expect(calls.at(-1).args).toContain("--tail=51");
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
test.each([100, 1000])(
  "applies --tail %i locally to all fetched logs",
  (tail) => {
    const pod = {
      metadata: { name: "p" },
      spec: { containers: [{ name: "c" }] },
    };
    const output = `${Array.from({ length: tail + 1 }, (_, i) => String(2999 - tail + i)).join("\n")}\n`;
    const l = lab([
      { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
      { prefix: ["logs"], stdout: output },
      ...targetRules(),
    ]);
    try {
      const p = cli(
        ["pods", "logs", "p", "-c", "c", "--tail", String(tail)],
        l.env,
      );
      expect(p.status).toBe(0);
      const data = logsOutput(p);
      expect(data.logs).toHaveLength(tail);
      expect(data.logs.at(-1)).toBe("2999");
      expect(data["omitted-lines"]).toBeNull();
      expect(data["more-lines"]).toBe(true);
      expect(l.calls().find((call) => call.args[0] === "logs")?.args).toContain(
        `--tail=${tail + 1}`,
      );
    } finally {
      l.clean();
    }
  },
);

test("reports the exact newest tail, omitted count, and shown range", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    { prefix: ["logs"], stdout: "older\nnewer..1\nnewer-2\n" },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p", "-c", "c", "--tail", "2"], l.env);
    expect(p.status).toBe(0);
    const data = logsOutput(p);
    expect(data.logs).toEqual(["newer..1", "newer-2"]);
    expect(data["omitted-lines"]).toBeNull();
    expect(data["more-lines"]).toBe(true);
    expect(data.shown).toEqual(["newer..1", "newer-2"]);
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
    const data = logsOutput(p);
    expect(data.logs).toEqual(["foo", ""]);
    expect(data["omitted-lines"]).toBe(0);
    expect(data["more-lines"]).toBe(false);
  } finally {
    l.clean();
  }
});

test("tail continuation increases the bound and preserves options", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    {
      prefix: ["logs"],
      stdout: `${Array.from({ length: 51 }, (_, i) => `line ${i}`).join("\n")}\n`,
    },
    ...targetRules(),
  ]);
  try {
    const p = cli(
      [
        "pods",
        "logs",
        "p",
        "-n",
        "sandbox",
        "--context",
        "ctx:/@",
        "-c",
        "c",
        "--tail",
        "50",
        "--since",
        "15m",
        "--previous",
      ],
      l.env,
    );
    expect(p.status).toBe(0);
    const data = logsOutput(p);
    expect(data.help?.[0]).toBe(
      "Run `k8s-axi pods logs 'p' -n 'sandbox' --context 'ctx:/@' -c 'c' --tail 100 --since '15m' --previous` for more logs within the --since window",
    );
  } finally {
    l.clean();
  }
});

test("character-preview hint keeps request options and --full semantics", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    {
      prefix: ["logs"],
      stdout: `${Array.from({ length: 100 }, (_, i) => `${i}:${"x".repeat(100)}`).join("\n")}\n`,
    },
    ...targetRules(),
  ]);
  try {
    const p = cli(
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
        "100",
        "--since",
        "15m",
        "--previous",
      ],
      l.env,
    );
    expect(p.status, p.stderr).toBe(0);
    const data = logsOutput(p);
    expect(data.logs.length).toBeLessThan(100);
    expect(data["omitted-lines"]).toBe(100 - data.logs.length);
    expect(data["more-lines"]).toBe(false);
    expect(data.help?.[0]).toContain(
      "k8s-axi pods logs 'p' -n 'sandbox' --context 'default' -c 'c' --tail 100 --since '15m' --previous --full",
    );
    expect(data.help?.[0]).toContain("does not show lines beyond --tail");
  } finally {
    l.clean();
  }
});

test("counts source lines hidden when redaction collapses a preview", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const pem =
    "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----";
  const output = `${pem}\n${Array.from({ length: 80 }, (_, i) => `${i}:${"x".repeat(100)}`).join("\n")}\n`;
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    { prefix: ["logs"], stdout: output },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p", "-c", "c", "--tail", "100"], l.env);
    expect(p.status).toBe(0);
    const data = logsOutput(p);
    expect(data.logs).not.toContain("[REDACTED PEM]");
    expect(data["more-lines"]).toBe(false);
    expect(data["omitted-lines"]).toBe(83 - data.logs.length);
  } finally {
    l.clean();
  }
});

test("--full does not fetch older lines than the requested tail", () => {
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
    const p = cli(
      ["pods", "logs", "p", "-c", "c", "--tail", "2", "--full"],
      l.env,
    );
    expect(p.status).toBe(0);
    const data = logsOutput(p);
    expect(data.logs).toEqual(["newer-1", "newer-2"]);
    expect(data["omitted-lines"]).toBeNull();
    expect(data["more-lines"]).toBe(true);
    expect(data.help?.[0]).toContain("--tail 4 --full");
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
      stdout: `${Array.from({ length: 101 }, (_, i) => `line ${i}`).join("\n")}\n`,
    },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p"], l.env);
    expect(p.status).toBe(0);
    expect(logsOutput(p).help?.[0]).toContain("-c 'a' --tail 200");
  } finally {
    l.clean();
  }
});

test("a full maximum tail explains the since filter", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    {
      prefix: ["logs"],
      stdout: `${Array.from({ length: 1001 }, (_, i) => String(i)).join("\n")}\n`,
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
    expect(logsOutput(p).help).toEqual([
      "The current CLI cannot page farther back: --tail is capped at 1000. Use --since to narrow the time window and inspect a different range (currently --since '15m').",
    ]);
  } finally {
    l.clean();
  }
});
test("byte-capped logs omit an incomplete final record", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const output = `older\nnewest\npartial${"x".repeat(LOG_LIMIT_BYTES - 20)}`;
  expect(Buffer.byteLength(output)).toBe(LOG_LIMIT_BYTES);
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    { prefix: ["logs"], stdout: output },
    ...targetRules(),
  ]);
  try {
    const p = cli(
      ["pods", "logs", "p", "-c", "c", "--tail", "2", "--since", "15m"],
      l.env,
    );
    expect(p.status).toBe(0);
    const data = logsOutput(p);
    expect(data.logs).toEqual(["older", "newest"]);
    expect(data["byte-limited"]).toBe(true);
    expect(data["more-lines"]).toBe(true);
    expect(data.help?.[0]).toContain("--tail 1 --since '15m'");
    expect(data.help?.[0]).toContain("narrow the --since window");
    expect(data.help?.[0]).not.toContain("--tail 4");
  } finally {
    l.clean();
  }
});

test("uses raw line count for availability when redaction collapses PEM lines", () => {
  const pod = {
    metadata: { name: "p" },
    spec: { containers: [{ name: "c" }] },
  };
  const l = lab([
    { prefix: ["get", "pod"], stdout: JSON.stringify(pod) },
    {
      prefix: ["logs"],
      stdout:
        "-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----\n",
    },
    ...targetRules(),
  ]);
  try {
    const p = cli(["pods", "logs", "p", "-c", "c", "--tail", "2"], l.env);
    expect(p.status).toBe(0);
    const data = logsOutput(p);
    expect(data.logs).toEqual(["[REDACTED PEM]"]);
    expect(data["more-lines"]).toBe(true);
    expect(data["omitted-lines"]).toBeNull();
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
