import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { decode } from "@toon-format/toon";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { cli } from "./helpers.js";
import { lab, targetRules, type Rule } from "./lab.js";
import { object } from "../src/kubectl.js";
import { sameChild } from "../src/actions/port-forward.js";

const labs: ReturnType<typeof lab>[] = [];
function setup(extra: Rule[] = []) {
  const l = lab([
    ...extra,
    ...targetRules(),
    { prefix: ["get", "pod"], stdout: '{"metadata":{"name":"echo"}}' },
    { prefix: ["auth", "can-i"], stdout: "yes\n" },
    { prefix: ["port-forward"], mode: "port-forward" },
  ]);
  labs.push(l);
  const env = { ...l.env, XDG_STATE_HOME: join(realpathSync(l.dir), "state") };
  const run = (...args: string[]) => cli(["port-forward", ...args], env);
  const state = join(env.XDG_STATE_HOME, "k8s-axi"),
    sessions = join(state, "sessions");
  const records = () => {
    try {
      return readdirSync(sessions).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
  };
  const read = (id: string) =>
    object(JSON.parse(readFileSync(join(sessions, `${id}.json`), "utf8")));
  const audit = () =>
    readFileSync(join(state, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => object(JSON.parse(line)));
  return { l, env, run, state, sessions, records, read, audit };
}
const flags = ["-n", "sandbox", "--context", "default"];
function started(s: ReturnType<typeof setup>, ...extra: string[]) {
  const r = s.run("echo", ":8080", ...flags, "--execute", ...extra);
  expect(r.status, r.stdout).toBe(0);
  const v = object(r.data);
  if (typeof v.session !== "string" || typeof v.local !== "string")
    throw new Error("missing session");
  return { id: v.session, local: v.local, record: s.read(v.session) };
}
afterEach(() => {
  for (const l of labs.splice(0)) {
    cli(["port-forward", "stop", "--all"], {
      ...l.env,
      XDG_STATE_HOME: join(realpathSync(l.dir), "state"),
    });
    l.clean();
  }
});
test("preview resolves and echoes target without a forwarding call or session", () => {
  const s = setup();
  const r = s.run("echo", "8080", ...flags);
  expect(r.status).toBe(0);
  expect(r.data).toMatchObject({
    target: {
      context: "default",
      namespace: "sandbox",
      pod: "echo",
      ports: [":8080"],
    },
    mode: "preview - nothing ran",
    ttl: "15m",
  });
  expect(s.records()).toEqual([]);
  expect(readFileSync(join(s.l.dir, "calls"), "utf8")).not.toContain(
    '"port-forward"',
  );
});
test.each([
  ["--ttl", "5s"],
  ["--ttl", "61m"],
  ["--address", "0.0.0.0"],
  ["--execute"],
  ["--execute", "--context", "default"],
  ["--execute", "-n", "sandbox"],
  ["--all"],
  ["--ttl=10s", "--ttl=20s"],
])("validates before calls: %j", (...bad) => {
  const s = setup();
  expect(s.run("echo", ":8080", ...bad).status).toBe(2);
  expect(readFileSync(join(s.l.dir, "calls"), "utf8")).toBe("");
});
test("deployment preview selects newest Ready pod and service forwarding resolves targetPort", () => {
  const pods = [
    {
      metadata: { name: "old", creationTimestamp: "2026-01-01" },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
      },
    },
    {
      metadata: { name: "new", creationTimestamp: "2026-02-01" },
      spec: {
        containers: [{ ports: [{ name: "http", containerPort: 8080 }] }],
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
      },
    },
    {
      metadata: { name: "pending", creationTimestamp: "2026-03-01" },
      status: { phase: "Pending" },
    },
  ];
  const s = setup([
    {
      prefix: ["get", "deployment.apps"],
      stdout: JSON.stringify({
        spec: { selector: { matchLabels: { app: "echo" } } },
      }),
    },
    {
      prefix: ["get", "service"],
      stdout: JSON.stringify({
        spec: {
          selector: { app: "echo" },
          ports: [{ port: 80, targetPort: "http" }],
        },
      }),
    },
    { prefix: ["get", "pods"], stdout: JSON.stringify({ items: pods }) },
  ]);
  expect(s.run("deployment/echo", ":8080", ...flags).data).toMatchObject({
    target: { pod: "new", from: "deployment/echo" },
  });
  const service = s.run("service/echo", ":80", ...flags, "--execute");
  expect(service.status, service.stdout).toBe(0);
  expect(service.data).toMatchObject({
    target: { pod: "new", from: "service/echo" },
  });
  expect(readFileSync(join(s.l.dir, "calls"), "utf8")).toContain(
    '["port-forward","new",":8080"',
  );
});
test.each(["80:8080", "65536:8080", ":0", ":65536", "8080:8080:8081"])(
  "rejects mapping %s",
  (mapping) => {
    expect(setup().run("echo", mapping).status).toBe(2);
  },
);
test("help wins over invalid flags; local subcommand flags are strict", () => {
  const s = setup();
  expect(s.run("--bad", "--help").status).toBe(0);
  expect(s.run("list", "--ttl", "15m").status).toBe(2);
  expect(s.run("stop", "--all", "id").status).toBe(2);
  expect(readFileSync(join(s.l.dir, "calls"), "utf8")).toBe("");
});
test("denied preview and execution are truthful; execution audits refusal without sessions", () => {
  const s = setup([{ prefix: ["auth", "can-i"], stdout: "no\n", code: 1 }]);
  for (const execute of [[], ["--execute"]]) {
    const r = s.run("echo", ":8080", ...flags, ...execute);
    expect(r.status).toBe(1);
    expect(r.data).toMatchObject({ code: "FORBIDDEN", permission: "denied" });
  }
  expect(s.records()).toEqual([]);
  expect(s.audit()).toMatchObject([{ phase: "refused", code: "FORBIDDEN" }]);
});
test("owned session serves traffic, lists, stops and has private records and audit", async () => {
  const s = setup(),
    r = started(s);
  expect(await (await fetch(`http://${r.local}`)).text()).toBe(
    "k8s-axi-echo\n",
  );
  expect(statSync(join(s.sessions, `${r.id}.json`)).mode & 0o777).toBe(0o600);
  expect(statSync(s.sessions).mode & 0o777).toBe(0o700);
  expect(s.run("list").data).toMatchObject({
    count: 1,
    sessions: [{ id: r.id }],
  });
  expect(s.run("stop", r.id).status).toBe(0);
  await expect(fetch(`http://${r.local}`)).rejects.toThrow();
  expect(s.records()).toEqual([]);
  expect(s.audit()).toMatchObject([
    { phase: "start", id: r.id },
    { phase: "end", id: r.id, outcome: "stopped" },
  ]);
  expect(s.run("stop", r.id).data).toMatchObject({ code: "SESSION_NOT_FOUND" });
});
test("10s TTL closes the listener and audits expiry without another CLI invocation", async () => {
  const s = setup(),
    r = started(s, "--ttl", "10s");
  await sleep(12000);
  await expect(fetch(`http://${r.local}`)).rejects.toThrow();
  expect(s.records()).toEqual([]);
  expect(s.audit().at(-1)).toMatchObject({ outcome: "expired" });
}, 18000);
test("sixth live session is refused", () => {
  const s = setup();
  for (let i = 0; i < 5; i++) started(s);
  const r = s.run("echo", ":8080", ...flags, "--execute");
  expect(r.status).toBe(1);
  expect(r.data).toMatchObject({ code: "SESSION_LIMIT" });
  expect(s.records()).toHaveLength(5);
}, 60000);
test("occupied local port is classified and startup is cleaned up", async () => {
  const s = setup(),
    server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const r = s.run("echo", `${address.port}:8080`, ...flags, "--execute");
    expect(r.status).toBe(1);
    expect(r.data).toMatchObject({ code: "PORT_IN_USE" });
    expect(s.records()).toEqual([]);
  } finally {
    server.close();
  }
});
test("read-only state refuses execution before spawning; preview still works", () => {
  const s = setup();
  mkdirSync(s.state, { recursive: true });
  chmodSync(s.state, 0o555);
  try {
    expect(s.run("echo", ":8080", ...flags, "--execute").data).toMatchObject({
      code: "AUDIT_UNAVAILABLE",
    });
    expect(s.run("echo", ":8080", ...flags).status).toBe(0);
    expect(s.records()).toEqual([]);
  } finally {
    chmodSync(s.state, 0o700);
  }
});
test("a live supervisor with the wrong token is dropped without signalling", async () => {
  const s = setup(),
    r = started(s);
  r.record.token = randomUUID();
  writeFileSync(join(s.sessions, `${r.id}.json`), JSON.stringify(r.record));
  try {
    expect(s.run("list").data).toMatchObject({ count: 0 });
    expect(await (await fetch(`http://${r.local}`)).text()).toBe(
      "k8s-axi-echo\n",
    );
    expect(s.audit().at(-1)).toMatchObject({ outcome: "dropped" });
  } finally {
    if (typeof r.record.pgid === "number")
      process.kill(-r.record.pgid, "SIGKILL");
  }
});
test("SessionEnd stops only the payload cwd, even with an empty transcript", () => {
  const s = setup(),
    x = join(s.l.dir, "x"),
    y = join(s.l.dir, "y"),
    transcript = join(s.l.dir, "transcript");
  mkdirSync(x);
  mkdirSync(y);
  writeFileSync(transcript, "");
  const binary = resolve("dist/bin/k8s-axi.js");
  const runAt = (cwd: string, args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [binary, ...args], {
      cwd,
      input,
      env: { ...process.env, ...s.env },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(r.error).toBeUndefined();
    expect(r.status, r.stdout).toBe(0);
    return object(decode(r.stdout));
  };
  const first = runAt(x, [
    "port-forward",
    "echo",
    ":8080",
    ...flags,
    "--execute",
  ]);
  const second = runAt(y, [
    "port-forward",
    "echo",
    ":8080",
    ...flags,
    "--execute",
  ]);
  runAt(
    y,
    ["context", "end"],
    JSON.stringify({ cwd: x, transcript_path: transcript }),
  );
  expect(s.run("list").data).toMatchObject({
    count: 1,
    sessions: [{ id: second.session }],
  });
  expect(s.audit()).toContainEqual(
    expect.objectContaining({ id: first.session, outcome: "stopped" }),
  );
});
test("orphan ownership requires pid, pgid, start time and exact argv", () => {
  const identity = {
    pid: 100,
    pgid: 90,
    started: "Sun Nov 22 12:00:00 2026",
    argv: "kubectl port-forward echo :8080",
  };
  expect(sameChild(identity, identity)).toBe(true);
  for (const other of [
    undefined,
    { ...identity, pid: 101 },
    { ...identity, pgid: 91 },
    { ...identity, started: "different" },
    { ...identity, argv: `${identity.argv} extra` },
  ])
    expect(sameChild(identity, other)).toBe(false);
});
test.each(["match", "pid", "pgid", "started", "argv", "unreadable"])(
  "dead-supervisor reaper: %s",
  async (field) => {
    const s = setup(),
      r = started(s),
      child = object(r.record.child);
    if (
      typeof r.record.supervisor_pid !== "number" ||
      typeof child.pid !== "number"
    )
      throw new Error("missing identity");
    const childPid = child.pid;
    process.kill(r.record.supervisor_pid, "SIGKILL");
    await sleep(150);
    if (field === "pid") child.pid = 99999999;
    if (field === "pgid") {
      child.pgid = 99999999;
      r.record.pgid = 99999999;
      r.record.supervisor_pid = 99999999;
    }
    if (field === "started") child.started = "different start";
    if (field === "argv") child.argv = "different argv";
    if (field === "unreadable") delete r.record.child;
    writeFileSync(join(s.sessions, `${r.id}.json`), JSON.stringify(r.record), {
      mode: 0o600,
    });
    try {
      expect(s.run("list").status).toBe(0);
      expect(s.records()).toEqual([]);
      expect(s.audit().at(-1)).toMatchObject({
        outcome: field === "match" ? "reaped" : "dropped",
      });
      if (field === "match")
        await expect(fetch(`http://${r.local}`)).rejects.toThrow();
      else
        expect(await (await fetch(`http://${r.local}`)).text()).toBe(
          "k8s-axi-echo\n",
        );
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
  },
);
