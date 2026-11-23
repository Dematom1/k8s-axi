import { spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { decode } from "@toon-format/toon";
import { expect, test } from "vitest";
import { object, objects, text } from "../../src/kubectl.js";

const live = process.env.K8S_AXI_LIVE === "1" ? test : test.skip;
live(
  "bounded owned port-forward sessions work against the leased kind cluster (F1-F12)",
  async () => {
    if (!process.env.K8S_AXI_LAB_LEASE || !process.env.KUBECONFIG)
      throw new Error("leased kind lab is required");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "k8s-axi-pf-live-")));
    const state = join(root, "state"),
      dir = join(state, "k8s-axi", "sessions");
    const binary = resolve(
      process.env.K8S_AXI_TEST_PACKAGE ?? ".",
      "dist/bin/k8s-axi.js",
    );
    const env = { ...process.env, XDG_STATE_HOME: state, KUBERC: "off" };
    const native = (...args: string[]) =>
      execFileSync("kubectl", args, { env, encoding: "utf8", timeout: 130000 });
    const context = native("config", "current-context").trim();
    const flags = ["-n", "fixtures", "--context", context];
    const outputs: string[] = [];
    function run(args: string[], status = 0, cwd = root, input?: string) {
      const r = spawnSync(process.execPath, [binary, ...args], {
        env,
        cwd,
        input,
        encoding: "utf8",
        timeout: 22000,
      });
      expect(r.error).toBeUndefined();
      expect(r.status, r.stdout + r.stderr).toBe(status);
      outputs.push(r.stdout, r.stderr);
      return object(decode(r.stdout));
    }
    const pf = (args: string[], status = 0) =>
      run(["port-forward", ...args], status);
    const records = () => {
      try {
        return readdirSync(dir).filter((n) => n.endsWith(".json"));
      } catch {
        return [];
      }
    };
    const read = (id: string) =>
      object(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")));
    const audit = () =>
      readFileSync(join(state, "k8s-axi", "audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => object(JSON.parse(line)));
    function start(ttl = "15m", cwd = root) {
      const value = run(
        [
          "port-forward",
          "deployment/echo",
          ":8080",
          ...flags,
          "--execute",
          "--ttl",
          ttl,
        ],
        0,
        cwd,
      );
      const id = text(value.session),
        local = text(value.local);
      expect(id).not.toBe("");
      expect(local).toMatch(/^127\.0\.0\.1:\d+$/);
      return { id, local, record: read(id) };
    }
    const body = async (local: string) =>
      (
        await fetch(`http://${local}`, { signal: AbortSignal.timeout(2000) })
      ).text();
    try {
      native(
        "wait",
        "-n",
        "fixtures",
        "--for=condition=Available",
        "deployment/echo",
        "--timeout=120s",
      );
      // F1, F4, F8, F12: no session or forwarding process is created by previews/refusals.
      expect(pf(["deployment/echo", ":8080", ...flags])).toMatchObject({
        mode: "preview - nothing ran",
        target: { context, namespace: "fixtures", from: "deployment/echo" },
      });
      expect(records()).toEqual([]);
      expect(
        pf(["deployment/echo", ":8080", ...flags, "--address", "0.0.0.0"], 2),
      ).toMatchObject({ code: "VALIDATION_ERROR" });
      for (const ttl of ["5s", "61m"])
        expect(
          pf(["deployment/echo", ":8080", ...flags, "--ttl", ttl], 2),
        ).toMatchObject({ code: "VALIDATION_ERROR" });
      for (const execute of [[], ["--execute"]])
        expect(
          pf(
            [
              "deployment/echo",
              ":8080",
              "-n",
              "fixtures",
              "--context",
              "limited",
              ...execute,
            ],
            1,
          ),
        ).toMatchObject({ permission: "denied", code: "FORBIDDEN" });
      expect(records()).toEqual([]);
      // F2, F3: reachable only over loopback; the supervisor expires without another CLI call.
      const expiring = start("10s");
      expect(await body(expiring.local)).toBe("k8s-axi-echo\n");
      expect(pf(["list"])).toMatchObject({
        count: 1,
        sessions: [{ id: expiring.id }],
      });
      const child = object(expiring.record.child);
      const sockets = execFileSync(
        "lsof",
        ["-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
        { encoding: "utf8" },
      );
      const addresses = sockets
        .split("\n")
        .filter((line) => line.startsWith("n"));
      expect(addresses.length).toBeGreaterThan(0);
      for (const line of addresses)
        expect(line).toMatch(/^n(?:127\.0\.0\.1|\[::1\]):\d+$/);
      const nonloopback = Object.values(networkInterfaces())
        .flat()
        .find((a) => a && !a.internal && a.family === "IPv4");
      if (!nonloopback)
        throw new Error("a non-loopback interface is required for F3");
      await expect(
        fetch(`http://${nonloopback.address}:${expiring.local.split(":")[1]}`, {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow();
      const remaining =
        Date.parse(text(expiring.record.expires_at)) - Date.now();
      if (remaining > 0) await sleep(remaining + 2000);
      await expect(body(expiring.local)).rejects.toThrow();
      expect(records()).toEqual([]);
      const processes = execFileSync("ps", ["-eo", "command="], {
        encoding: "utf8",
      });
      expect(processes).not.toContain(text(expiring.record.token));
      expect(audit()).toContainEqual(
        expect.objectContaining({ id: expiring.id, outcome: "expired" }),
      );
      // F5, F6: explicit stop and proven-orphan reaping close the listeners.
      const stopped = start();
      expect(pf(["stop", stopped.id])).toMatchObject({ stopped: 1 });
      await expect(body(stopped.local)).rejects.toThrow();
      expect(pf(["stop", stopped.id], 1)).toMatchObject({
        code: "SESSION_NOT_FOUND",
      });
      expect(audit()).toContainEqual(
        expect.objectContaining({ id: stopped.id, outcome: "stopped" }),
      );
      const orphan = start();
      if (typeof orphan.record.supervisor_pid !== "number")
        throw new Error("missing supervisor pid");
      process.kill(orphan.record.supervisor_pid, "SIGKILL");
      await sleep(200);
      expect(pf(["list"])).toMatchObject({ count: 0 });
      await expect(body(orphan.local)).rejects.toThrow();
      expect(audit()).toContainEqual(
        expect.objectContaining({ id: orphan.id, outcome: "reaped" }),
      );
      // F7: payload cwd owns sessions, not the cwd of the hook invocation.
      const x = join(root, "x"),
        y = join(root, "y"),
        transcript = join(root, "transcript");
      mkdirSync(x);
      mkdirSync(y);
      writeFileSync(transcript, "");
      const ownedX = start("15m", x),
        ownedY = start("15m", y);
      run(
        ["context", "end"],
        0,
        y,
        JSON.stringify({ cwd: x, transcript_path: transcript }),
      );
      await expect(body(ownedX.local)).rejects.toThrow();
      expect(await body(ownedY.local)).toBe("k8s-axi-echo\n");
      pf(["stop", "--all"]);
      // F9: the limit is shared across invocations and previews report the same refusal.
      for (let i = 0; i < 5; i++) start();
      for (const execute of [[], ["--execute"]])
        expect(
          pf(["deployment/echo", ":8080", ...flags, ...execute], 1),
        ).toMatchObject({ code: "SESSION_LIMIT" });
      expect(records()).toHaveLength(5);
      pf(["stop", "--all"]);
      // F10: native bind errors are classified without exposing stderr.
      const server = createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("missing port");
        expect(
          pf(
            ["deployment/echo", `${address.port}:8080`, ...flags, "--execute"],
            1,
          ),
        ).toMatchObject({ code: "PORT_IN_USE" });
        expect(records()).toEqual([]);
      } finally {
        server.close();
      }
      // F11: no launch when state cannot be written. Preview still succeeds.
      chmodSync(dir, 0o555);
      try {
        expect(
          pf(["deployment/echo", ":8080", ...flags, "--execute"], 1),
        ).toMatchObject({ code: "AUDIT_UNAVAILABLE" });
        expect(pf(["deployment/echo", ":8080", ...flags])).toMatchObject({
          mode: "preview - nothing ran",
        });
      } finally {
        chmodSync(dir, 0o700);
      }
      // Written outputs are part of the leak sweep, including live session records and list output.
      const sweep = start();
      outputs.push(readFileSync(join(dir, `${sweep.id}.json`), "utf8"));
      pf(["list"]);
      pf(["stop", "--all"]);
      outputs.push(readFileSync(join(state, "k8s-axi", "audit.jsonl"), "utf8"));
      const secrets = objects(
        object(
          JSON.parse(native("get", "secrets", "-n", "fixtures", "-o", "json")),
        ).items,
      )
        .flatMap((s) =>
          Object.values(object(s.data)).map((v) =>
            Buffer.from(text(v), "base64").toString("utf8"),
          ),
        )
        .filter((v) => v.length >= 4);
      const credentials = [
        process.env.K8S_AXI_LIMITED_TOKEN,
        process.env.K8S_AXI_NSONLY_TOKEN,
      ];
      if (credentials.some((v) => !v))
        throw new Error("lab identity tokens are required for the leak sweep");
      const forms = [
        ...secrets,
        "CANARY_ENV_8KSA",
        "CANARY_LOG_8KSA",
        ...credentials.filter((v) => v !== undefined),
      ].flatMap((v) => {
        const bytes = Buffer.from(v);
        const encoded = [bytes.toString("base64"), bytes.toString("base64url")];
        const aligned = [0, 1, 2].flatMap((offset) => {
          const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
          return ["base64", "base64url"]
            .map((encoding) =>
              padded
                .toString(encoding === "base64" ? "base64" : "base64url")
                .slice(offset ? 4 : 0, Math.floor(padded.length / 3) * 4),
            )
            .filter((form) => form.length >= 8);
        });
        return [
          v,
          ...encoded,
          ...encoded.map((form) => form.replace(/=+$/, "")),
          ...aligned,
          bytes.toString("hex"),
          bytes.toString("hex").toUpperCase(),
          encodeURIComponent(v),
        ];
      });
      const tokenSlices = credentials.flatMap((v) => {
        if (!v) return [];
        return [v, Buffer.from(v).toString("base64")].flatMap(
          (representation) =>
            Array.from(
              { length: Math.max(0, representation.length - 7) },
              (_, i) => representation.slice(i, i + 8),
            ),
        );
      });
      const leaks = (value: string) =>
        [...forms, ...tokenSlices].some(
          (form) => form.length >= 4 && value.includes(form),
        );
      expect(secrets.length).toBeGreaterThan(0);
      expect(leaks(secrets[0] ?? "")).toBe(true);
      expect(leaks(outputs.join("\n"))).toBe(false);
    } finally {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* No sessions directory on preflight failure. */
      }
      run(["port-forward", "stop", "--all"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  240000,
);
