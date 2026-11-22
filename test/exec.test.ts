import { expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execPolicy } from "../src/actions/exec-policy.js";
import { ScrubSet, scrubSources } from "../src/actions/scrub.js";
import {
  argvForAction,
  assertSafeAction,
  type Action,
} from "../src/actions/registry.js";
import { parseArgs, validateNamespace } from "../src/args.js";
import { object, type Obj } from "../src/kubectl.js";
import { redactText } from "../src/redact.js";
import { resolveTarget } from "../src/target.js";
import { deadline } from "../src/registry.js";
import { summarizeTranscript } from "../src/sessionlog.js";
import { cli } from "./helpers.js";
import { lab, targetRules, type Rule } from "./lab.js";

const C1 = "neutral-MuchSafer42!";
const C5 = "dsn-neutral-9348";
const C6 = "mounted-neutral-5678";
const C3 = "literal-neutral-3344";
const spec = {
  containers: [
    {
      name: "app",
      env: [
        {
          name: "DB_PASSWORD",
          valueFrom: { secretKeyRef: { name: "db-creds", key: "password" } },
        },
        { name: "API_KEY", value: C3 },
      ],
      envFrom: [{ secretRef: { name: "app-dsn" } }],
      volumeMounts: [
        { name: "conn", mountPath: "/etc/app-conn" },
        { name: "projected", mountPath: "/projected" },
        { name: "csi", mountPath: "/csi" },
      ],
    },
  ],
  volumes: [
    { name: "conn", secret: { secretName: "app-conn" } },
    {
      name: "projected",
      projected: {
        sources: [
          { secret: { name: "app-dsn" } },
          { serviceAccountToken: { path: "token" } },
        ],
      },
    },
    { name: "csi", csi: { driver: "secret-driver" } },
  ],
};
const pod = {
  kind: "Pod",
  metadata: { name: "web-1", creationTimestamp: "2026-01-01" },
  spec,
  status: { conditions: [{ type: "Ready", status: "True" }] },
};
const flags = ["-n", "sandbox", "--context", "default"];
function fixture(extra: Rule[] = [], valueSpec: Obj = spec) {
  return lab([
    ...extra,
    ...targetRules(),
    {
      prefix: ["get", "pod"],
      stdout: JSON.stringify({ ...pod, spec: valueSpec }),
    },
    {
      prefix: ["get", "deployment.apps"],
      stdout: JSON.stringify({
        spec: { selector: { matchLabels: { app: "web" } } },
      }),
    },
    {
      prefix: ["get", "pods"],
      stdout: JSON.stringify({
        items: [
          {
            ...pod,
            metadata: { name: "web-old", creationTimestamp: "2025-01-01" },
          },
          pod,
        ],
      }),
    },
    { prefix: ["auth", "can-i"], stdout: "yes\n" },
    ...[
      ["db-creds", C1],
      ["app-dsn", C5],
      ["app-conn", C6],
    ].map(([name = "", value = ""]) => ({
      prefix: ["get", "secret", name],
      stdout: JSON.stringify({
        kind: "Secret",
        data: { neutral: Buffer.from(value).toString("base64") },
      }),
    })),
    { prefix: ["exec"], stdout: "ok\n" },
  ]);
}
function calls(l: ReturnType<typeof lab>): string[][] {
  return readFileSync(l.env.K8S_AXI_CALLS, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const record: { args: string[] } = JSON.parse(line);
      return record.args;
    });
}
function records(l: ReturnType<typeof lab>) {
  const file = join(l.env.HOME, ".local/state/k8s-axi/audit.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

const refused = [
  ["env"],
  ["printenv", "DB_PASSWORD"],
  ["/usr/bin/printenv"],
  ["set"],
  ["export"],
  ["declare"],
  ["typeset"],
  ["compgen"],
  ["envsubst"],
  ["busybox", "env"],
  ["toybox", "printenv"],
  ["timeout", "5", "printenv"],
  ["timeout", "-k", "1", "5", "env"],
  ["nice", "-n", "5", "env"],
  ["nohup", "env"],
  ["stdbuf", "-oL", "env"],
  ["ionice", "-c", "3", "env"],
  ["sh", "-c", "echo $DB_PASSWORD"],
  ["/bin/bash", "-c", "exit 7"],
  ["python3", "-c", "..."],
  ["node", "-e", "..."],
  ["sed", "e"],
  ["awk", "BEGIN{...}"],
  ["xargs", "env"],
  ["sudo", "ls"],
  ["nsenter", "ls"],
  ["gdb"],
  ["find", "/app", "-exec", "env", ";"],
  ["find", "/app", "-execdir", "env", ";"],
  ["find", "/app", "-ok", "env", ";"],
  ["find", "/app", "-fprint0", "/tmp/x"],
  ["find", "/app", "-delete"],
  ["cat", "/proc/1/environ"],
  ["cat", "/proc/self/../1/environ"],
  ["cat", "/proc/1/root/etc/x"],
  ["cat", "/var/run/secrets/kubernetes.io/serviceaccount/token"],
  ["cat", "/run/secrets/x"],
  ["cat", "/etc/app-conn/conn"],
  ["cat", "--file=/projected/token"],
  ["curl", "@/csi/secret"],
  ["cat", "../secret"],
  ["grep", "-r", "x", "/"],
  ["tar", "c", "/etc"],
  ["find", "/"],
  ["cpio", "/etc"],
  ["zip", "/etc"],
  ["rsync", "/etc"],
  ["cat", "/etc/app-conn/../app-conn/conn"],
  ["timeout", "--unknown", "5", "ls"],
];
for (const argv of refused)
  test(`policy refuses ${argv.join(" ")}`, () =>
    expect(execPolicy(argv, spec, "app").ok).toBe(false));
for (const argv of [
  ["ls", "/"],
  ["cat", "/app/config"],
  ["echo", "$DB_PASSWORD"],
  ["cat", "/proc/meminfo"],
  ["cat", "/proc/net/tcp"],
  ["grep", "-r", "x", "/app"],
  ["busybox", "ls", "/"],
  ["timeout", "5", "ls"],
  ["nice", "-n", "10", "ls"],
  ["stdbuf", "--output=L", "ls"],
  ["/scripts/leak-env"],
])
  test(`policy allows ${argv.join(" ")}`, () =>
    expect(execPolicy(argv, spec, "app").ok).toBe(true));
for (const argv of [
  [],
  Array(65).fill("x"),
  ["echo", "x".repeat(4097)],
  ["echo", "\0"],
])
  test(`policy bounds shape ${argv.length}`, () =>
    expect(execPolicy(argv, spec, "app").ok).toBe(false));

test("ScrubSet hides raw, encoded and aligned values without serializable state", () => {
  const value = "nEutr@l /value?xyz";
  const bytes = Buffer.from(value);
  const set = new ScrubSet([bytes]);
  const forms = [
    value,
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("base64").replace(/=+$/, ""),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    encodeURIComponent(value),
  ];
  for (const prefix of ["", "a", "ab"])
    for (const encoding of ["base64", "base64url"] as const)
      forms.push(Buffer.from(prefix + value + "extra").toString(encoding));
  for (const form of forms) {
    expect(set.scrub(form).count, form).toBeGreaterThan(0);
    expect(set.scrub(form).text).toContain("[REDACTED SECRET VALUE]");
  }
  expect(JSON.stringify(set)).toBe("{}");
  expect(Object.keys(set)).toEqual([]);
  expect(set.scrub("ordinary output")).toEqual({
    text: "ordinary output",
    count: 0,
  });
  expect(new ScrubSet([Buffer.from("abc")]).scrub("abc").count).toBe(0);
  const check = (s: string) => expect(s).not.toContain(value);
  expect(() => check(value)).toThrow();
  check(set.scrub(value).text);
  expect(
    new ScrubSet([Buffer.from("REDACTED"), Buffer.from("SECRET")]).scrub(
      "REDACTED SECRET",
    ).count,
  ).toBe(2);
});
test("scrub sources deduplicate optional references and select only credential literals", () => {
  expect(scrubSources(spec, "app").secrets).toEqual([
    { name: "db-creds", optional: false },
    { name: "app-dsn", optional: false },
    { name: "app-conn", optional: false },
  ]);
  expect(scrubSources(spec, "app").literals).toEqual([
    { name: "API_KEY", value: C3 },
  ]);
  expect(redactText("eyJabcdefghijk.abcdefghijkl.abcdefghijkl").text).toBe(
    "[REDACTED JWT]",
  );
});
test("overlapping and encoded short values do not expose suffixes or rewrite markers", () => {
  expect(
    new ScrubSet([Buffer.from("abcdef"), Buffer.from("bcdefghi")]).scrub(
      "abcdefghi",
    ),
  ).toEqual({ text: "[REDACTED SECRET VALUE]", count: 1 });
  expect(
    new ScrubSet([Buffer.from("abc")]).scrub("%61%62%63 abc 616263"),
  ).toEqual({ text: "[REDACTED SECRET VALUE] abc 616263", count: 1 });
  const binary = Buffer.from([255, 254, 253, 252, 251, 250]);
  for (const encoding of ["base64", "base64url"] as const)
    expect(
      new ScrubSet([binary]).scrub(binary.toString(encoding)).count,
    ).toBeGreaterThan(0);
});
test("exec session summaries ignore remote --context operands and retain only command counts", async () => {
  const l = fixture();
  const transcript = join(l.dir, "transcript");
  const rows = [
    `k8s-axi exec web-1 -- echo --context ${C1}`,
    `k8s-axi exec web-1 -- echo --context=${C1}`,
    "k8s-axi exec web-1 --context default -- ls",
  ];
  writeFileSync(
    transcript,
    rows
      .map((command) =>
        JSON.stringify({
          message: { content: [{ type: "tool_use", input: { command } }] },
        }),
      )
      .join("\n"),
  );
  try {
    const summary = await summarizeTranscript(transcript);
    expect(summary).toEqual({ commands: { exec: 3 }, context: "default" });
    expect(JSON.stringify(summary)).not.toContain(C1);
  } finally {
    l.clean();
  }
});
test("exec parser owns -- only before remote argv; remote help and flags are literal", () => {
  const parsed = parseArgs("exec", [
    "web-1",
    ...flags,
    "--execute",
    "--",
    "ls",
    "--help",
    "-t",
  ]);
  expect(parsed.help).toBe(false);
  expect(parsed.remoteArgv).toEqual(["ls", "--help", "-t"]);
  expect(parsed.execute).toBe(true);
  expect(parsed.timeout).toBe(30);
});

for (const command of [
  ["printenv", "DB_PASSWORD"],
  ["env"],
  ["busybox", "env"],
  ["timeout", "5", "printenv"],
  ["sh", "-c", `echo ${C1}`],
  ["python3", "-c", C1],
  ["cat", "/proc/1/environ"],
  ["cat", "/etc/app-conn/conn"],
  ["grep", "-r", "CANARY", "/"],
  ["tar", "c", "/etc"],
])
  test(`E1-E3: ${command[0]} refusal never executes or persists argv values`, () => {
    const l = fixture();
    try {
      const result = cli(
        ["exec", "deployment/web", ...flags, "--execute", "--", ...command],
        l.env,
      );
      expect(result.status, result.stdout).toBe(1);
      expect(object(result.data).code).toBe("SECRET_EXPOSURE");
      expect(result.stdout + result.stderr + records(l)).not.toContain(C1);
      expect(calls(l).some((argv) => argv[0] === "exec")).toBe(false);
      expect(records(l)).toContain('"phase":"refused"');
      expect(records(l)).not.toContain('"argv":');
    } finally {
      l.clean();
    }
  });

test("E4-E7: image-side scripts scrub both streams, command echo, help and audit before truncation", () => {
  const payload = [
    C1,
    C5,
    C6,
    C3,
    Buffer.from(C1).toString("base64"),
    "eyJabcdefghijk.abcdefghijkl.abcdefghijkl",
  ].join("\n");
  const l = fixture([
    { prefix: ["exec"], stdout: payload + "\nx".repeat(4100), stderr: payload },
  ]);
  try {
    for (const full of [[], ["--full"]]) {
      const result = cli(
        [
          "exec",
          "web-1",
          ...flags,
          "--execute",
          ...full,
          "--",
          "/scripts/leak-env",
          C1,
        ],
        l.env,
      );
      expect(result.status, result.stdout).toBe(0);
      expect(object(result.data).scrubbed).toBeGreaterThanOrEqual(10);
      expect(object(result.data).redacted).toBeGreaterThanOrEqual(2);
      const all = result.stdout + result.stderr + records(l);
      for (const value of [C1, C3, C5, C6, Buffer.from(C1).toString("base64")])
        expect(all).not.toContain(value);
      expect(all).toContain("[REDACTED SECRET VALUE]");
      expect(object(result.data).truncated).toBe(!full.length);
    }
    expect(records(l)).toContain('"phase":"start"');
    expect(records(l)).toContain('"outcome":"ok"');
  } finally {
    l.clean();
  }
});

test("E8: missing Secret read permission fails closed in preview and execute", () => {
  const l = fixture([
    {
      prefix: ["get", "secret", "db-creds"],
      code: 1,
      stderr: `Error from server (Forbidden): ${C1}`,
    },
  ]);
  try {
    for (const execute of [[], ["--execute"]]) {
      const result = cli(
        ["exec", "web-1", ...flags, ...execute, "--", "ls", "/"],
        l.env,
      );
      expect(result.status).toBe(1);
      expect(object(result.data).code).toBe("SCRUB_UNAVAILABLE");
      expect(result.stdout).toContain("db-creds");
      expect(result.stdout).toContain("get secrets");
      expect(result.stdout + records(l)).not.toContain(C1);
    }
    expect(calls(l).some((argv) => argv[0] === "exec")).toBe(false);
  } finally {
    l.clean();
  }
});
test("E9: denied permission is truthful in preview and execute", () => {
  const l = fixture([{ prefix: ["auth", "can-i"], code: 1, stdout: "no\n" }]);
  try {
    for (const execute of [[], ["--execute"]]) {
      const result = cli(
        ["exec", "web-1", ...flags, ...execute, "--", "ls"],
        l.env,
      );
      expect(result.status).toBe(1);
      expect(object(result.data).code).toBe("FORBIDDEN");
      expect(result.stdout).toContain("create pods/exec in sandbox");
      expect(result.stdout).toContain("denied");
    }
    expect(calls(l).some((argv) => argv[0] === "exec")).toBe(false);
    expect(records(l)).toContain('"phase":"refused"');
  } finally {
    l.clean();
  }
});
test("E10: nonzero remote exit shows safe output and separate exit code", () => {
  const l = fixture([
    {
      prefix: ["exec"],
      code: 7,
      stdout: C1,
      stderr: "command terminated with exit code 7\n",
    },
  ]);
  try {
    const result = cli(
      ["exec", "web-1", ...flags, "--execute", "--", "/scripts/exit7"],
      l.env,
    );
    expect(result.status).toBe(1);
    expect(object(result.data)).toMatchObject({
      code: "REMOTE_EXIT_NONZERO",
      remote_exit: 7,
      scrubbed: 1,
    });
    expect(records(l)).toContain('"outcome":"remote_nonzero"');
    expect(result.stdout).not.toContain(C1);
  } finally {
    l.clean();
  }
});
test("E11: local deadline kills the process group, never claims remote cleanup", () => {
  const l = fixture([{ prefix: ["exec"], mode: "grandchild-ignore-term" }], {
    containers: [{ name: "app" }],
  });
  try {
    const result = cli(
      [
        "exec",
        "web-1",
        ...flags,
        "--execute",
        "--timeout",
        "1",
        "--",
        "sleep",
        "600",
      ],
      l.env,
    );
    expect(result.status).toBe(1);
    expect(object(result.data).code).toBe("TIMEOUT");
    expect(object(result.data).remote_process).toContain(
      "may still be running in web-1/app",
    );
    expect(() =>
      process.kill(Number(readFileSync(l.env.K8S_AXI_PID, "utf8")), 0),
    ).toThrow();
    expect(records(l)).toContain('"outcome":"timeout"');
  } finally {
    l.clean();
  }
}, 10_000);
test("E12: read-only state directory prevents execution, not preview", () => {
  const l = fixture();
  const dir = join(l.env.HOME, ".local/state/k8s-axi");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o555);
  try {
    expect(cli(["exec", "web-1", ...flags, "--", "ls"], l.env).status).toBe(0);
    const result = cli(
      ["exec", "web-1", ...flags, "--execute", "--", "ls"],
      l.env,
    );
    expect(result.status).toBe(1);
    expect(object(result.data).code).toBe("AUDIT_UNAVAILABLE");
    expect(calls(l).some((argv) => argv[0] === "exec")).toBe(false);
  } finally {
    chmodSync(dir, 0o700);
    l.clean();
  }
});
test("E13: preview echoes newest Ready pod and container and never runs exec or writes audit", () => {
  const l = fixture();
  try {
    const result = cli(
      ["exec", "deployment/web", ...flags, "--", "ls", "/"],
      l.env,
    );
    expect(result.status, result.stdout).toBe(0);
    expect(object(object(result.data).target)).toMatchObject({
      context: "default",
      server: "https://cluster.invalid",
      namespace: "sandbox",
      pod: "web-1",
      from: "deployment/web",
      container: "app",
    });
    expect(calls(l).some((argv) => argv[0] === "exec")).toBe(false);
    expect(records(l)).toBe("");
  } finally {
    l.clean();
  }
});
test("E14: missing objects and container fail before exec", () => {
  for (const name of ["web-1", "deployment/nope"]) {
    const l = fixture([
      {
        prefix: [
          "get",
          name.startsWith("deployment/") ? "deployment.apps" : "pod",
        ],
        code: 1,
        stderr: "Error from server (NotFound): missing",
      },
    ]);
    try {
      const result = cli(["exec", name, ...flags, "--", "ls"], l.env);
      expect(result.status).toBe(1);
      expect(object(result.data).code).toBe("NOT_FOUND");
      expect(result.stdout).toContain(name);
    } finally {
      l.clean();
    }
  }
  const l = fixture();
  try {
    const result = cli(
      ["exec", "web-1", ...flags, "-c", "missing", "--", "ls"],
      l.env,
    );
    expect(result.status).toBe(1);
    expect(object(result.data).code).toBe("NOT_FOUND");
    expect(result.stdout).toContain("containers: app");
    expect(calls(l).some((argv) => argv[0] === "exec")).toBe(false);
  } finally {
    l.clean();
  }
});
test("E15-E16: usage errors never call kubectl and help stays local", () => {
  const l = fixture();
  try {
    for (const args of [
      ["web-1", "--execute", "--", "ls"],
      ["web-1", "--context", "default", "--execute", "--", "ls"],
      ["web-1", "-A", "--", "ls"],
      ...["-i", "-t", "--stdin", "--tty"].map((f) => ["web-1", f, "--", "ls"]),
      ["web-1"],
      ["web-1", "--"],
      ["web-1", "--timeout", "301", "--", "ls"],
    ]) {
      const result = cli(["exec", ...args], l.env);
      expect(result.status, result.stdout).toBe(2);
      expect(object(result.data).code).toBe("VALIDATION_ERROR");
    }
    const help = cli(["exec", "--typo", "--help"], l.env);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--execute");
    expect(calls(l)).toEqual([]);
  } finally {
    l.clean();
  }
});
test("kubectl failure uses only its last error line and suppresses upstream output", () => {
  const l = fixture([
    {
      prefix: ["exec"],
      code: 1,
      stdout: C1,
      stderr: `remote says (Forbidden) ${C1}\nerror: connection refused\n`,
    },
  ]);
  try {
    const result = cli(
      ["exec", "web-1", ...flags, "--execute", "--", "ls"],
      l.env,
    );
    expect(result.status).toBe(1);
    expect(object(result.data).code).toBe("SERVER_UNREACHABLE");
    expect(result.stdout).not.toContain(C1);
    expect(object(result.data).stdout).toBe("");
    expect(object(result.data).stderr).toBe("");
  } finally {
    l.clean();
  }
});
test("optional missing Secret is skipped; malformed Secret fails closed", () => {
  const valueSpec = {
    containers: [
      {
        name: "app",
        envFrom: [{ secretRef: { name: "optional", optional: true } }],
      },
    ],
    volumes: [],
  };
  for (const [code, stdout, stderr, expected] of [
    [1, "", "Error from server (NotFound): absent", 0],
    [0, '{"kind":"Secret","data":{"key":"!invalid"}}', "", 1],
  ] as const) {
    const l = fixture(
      [{ prefix: ["get", "secret"], code, stdout, stderr }],
      valueSpec,
    );
    try {
      const result = cli(["exec", "web-1", ...flags, "--", "ls"], l.env);
      expect(result.status, result.stdout).toBe(expected);
      if (expected) expect(object(result.data).code).toBe("SCRUB_UNAVAILABLE");
    } finally {
      l.clean();
    }
  }
});
test("actions accept only their exact typed argv, with Secret reads isolated from generic reads", async () => {
  const l = fixture();
  const before = { ...process.env };
  Object.assign(process.env, l.env);
  try {
    const target = {
      ...(await resolveTarget(undefined, deadline())),
      defaultNamespace: validateNamespace("sandbox"),
    };
    for (const action of [
      { kind: "exec", target: "web-1", container: "app", command: ["ls"] },
      { kind: "secret-values", name: "db-creds" },
      { kind: "can-i", resource: "pods/exec" },
    ] satisfies Action[]) {
      const argv = argvForAction(action, target);
      expect(() => assertSafeAction(action, target, argv)).not.toThrow();
      for (const extra of [
        "--token=x",
        "--raw=/",
        "-i",
        "--as=root",
        "-f",
        "--kubeconfig=x",
        "--context=other",
      ])
        expect(() =>
          assertSafeAction(action, target, [...argv, extra]),
        ).toThrow();
      for (let i = 0; i < argv.length; i++)
        expect(() =>
          assertSafeAction(
            action,
            target,
            argv.filter((_, j) => j !== i),
          ),
        ).toThrow();
    }
    expect(readdirSync(l.env.HOME)).toEqual([]);
  } finally {
    process.env = before;
    l.clean();
  }
});

for (const mode of ["require-audit", "audit-end-fail"])
  test(`audit before effect and completion failure: ${mode}`, () => {
    const l = fixture([{ prefix: ["exec"], mode }]);
    try {
      const result = cli(
        ["exec", "web-1", ...flags, "--execute", "--", "ls"],
        l.env,
      );
      expect(result.status, result.stdout).toBe(
        mode === "require-audit" ? 0 : 1,
      );
      if (mode === "audit-end-fail") {
        expect(object(result.data).code).toBe("AUDIT_INCOMPLETE");
        expect(result.stdout).toContain("the action ran; do not retry");
        expect(object(result.data).stdout).toBe("action ran");
      } else expect(object(result.data).stdout).toBe("audit precedes effect");
      expect(records(l)).toContain('"phase":"start"');
    } finally {
      chmodSync(join(l.env.XDG_STATE_HOME, "k8s-axi"), 0o700);
      l.clean();
    }
  });
for (const size of [700_000, 1_100_000])
  test(`per-stream capture cap ${size}`, () => {
    const l = fixture([
      { prefix: ["exec"], stdout: "x".repeat(size), stderr: "y".repeat(size) },
    ]);
    try {
      const result = cli(
        ["exec", "web-1", ...flags, "--execute", "--", "ls"],
        l.env,
      );
      expect(result.status, result.stdout).toBe(size > 1024 * 1024 ? 1 : 0);
      expect(object(result.data).truncated).toBe(true);
      if (size > 1024 * 1024) {
        expect(object(result.data).code).toBe("OUTPUT_TOO_LARGE");
        expect(object(result.data).stdout).toBe("");
        expect(object(result.data).stderr).toBe("");
      }
    } finally {
      l.clean();
    }
  });
