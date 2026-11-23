import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { expect, test } from "vitest";
import { object } from "../../src/kubectl.js";

test.skipIf(process.env.K8S_AXI_LAB_LIVE !== "1")(
  "E1-E16 guarded exec against the packed artifact and leased kind cluster",
  () => {
    const state = process.env.BERTH_STATE;
    const lease = process.env.K8S_AXI_LAB_LEASE;
    if (
      !state ||
      !lease ||
      process.env.KUBECONFIG !==
        resolve(state, "resources", lease, "kubeconfig")
    )
      throw new Error(
        "exec live suite requires the lab berth lease kubeconfig",
      );
    const originalHome = process.env.HOME;
    if (!originalHome?.includes("/.lab-live/"))
      throw new Error("isolated live HOME is required");
    const home = join(originalHome, "exec");
    mkdirSync(home, { recursive: true });
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      KUBERC: "off",
    };
    const binary = resolve(
      process.env.K8S_AXI_TEST_PACKAGE ?? ".",
      "dist/bin/k8s-axi.js",
    );
    const outputs: string[] = [];
    const kubectl = (args: string[]) => {
      const result = spawnSync("kubectl", args, {
        env,
        encoding: "utf8",
        timeout: 15_000,
      });
      if (result.status !== 0) throw new Error("lab setup read failed");
      return result.stdout;
    };
    const context = kubectl(["config", "current-context"]).trim();
    const run = (args: string[], exit: number, input?: string) => {
      const result = spawnSync(process.execPath, [binary, ...args], {
        env,
        encoding: "utf8",
        timeout: 20_000,
        input,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout).toBe(exit);
      expect(result.stderr).toBe("");
      outputs.push(result.stdout + result.stderr);
      return object(decode(result.stdout, { strict: true }));
    };
    const exec = (
      command: string[],
      options: {
        execute?: boolean;
        context?: string;
        full?: boolean;
        timeout?: number;
        target?: string;
        container?: string;
      } = {},
      exit = 0,
    ) =>
      run(
        [
          "exec",
          options.target ?? "deployment/web",
          "--context",
          options.context ?? context,
          "-n",
          "fixtures",
          ...(options.container ? ["-c", options.container] : []),
          ...(options.execute ? ["--execute"] : []),
          ...(options.full ? ["--full"] : []),
          ...(options.timeout ? ["--timeout", String(options.timeout)] : []),
          "--",
          ...command,
        ],
        exit,
      );
    const audit = () => {
      const path = join(env.XDG_STATE_HOME, "k8s-axi/audit.jsonl");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    const preview = exec(["ls", "/"]);
    expect(preview.mode).toContain("preview");
    expect(object(preview.target)).toMatchObject({
      context,
      namespace: "fixtures",
      from: "deployment/web",
      container: "app",
    });
    expect(object(preview.target).pod).toMatch(/^web-/);
    expect(object(preview.target).server).toMatch(/^https:\/\//);
    expect(audit()).toBe(""); // E13: preview has no start/effect record.
    const pod = String(object(preview.target).pod);
    const forbidden = [
      ["printenv", "DB_PASSWORD"],
      ["env"],
      ["busybox", "env"],
      ["timeout", "5", "printenv"],
      ["sh", "-c", "echo $DB_PASSWORD"],
      ["python3", "-c", "import os; print(os.environ)"],
      ["cat", "/proc/1/environ"],
      ["cat", "/proc/self/../1/environ"],
      ["cat", "/var/run/secrets/kubernetes.io/serviceaccount/token"],
      ["cat", "/etc/app-conn/conn"],
      ["grep", "-r", "CANARY", "/"],
      ["tar", "c", "/etc"],
    ];
    for (const command of forbidden)
      expect(exec(command, { execute: true }, 1).code).toBe("SECRET_EXPOSURE");
    expect(audit()).not.toContain('"phase":"start"');
    expect(
      audit()
        .split("\n")
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)).phase),
    ).toEqual(forbidden.map(() => "refused"));
    // Namespace Events are not API audit records and cannot prove that exec did not run.
    // The unit CLI tests assert that preview and guard refusals make no exec call.

    // E4-E7: trusted image-side scripts bypass input inspection, not output guards.
    for (const script of [
      "leak-env",
      "leak-b64",
      "leak-neutral",
      "leak-file",
      "leak-token",
    ]) {
      for (const full of [false, true]) {
        const output = exec([`/scripts/${script}`], { execute: true, full });
        expect(output.remote_exit).toBe(0);
        expect(output.stdout).toContain(
          script === "leak-token"
            ? "[REDACTED JWT]"
            : "[REDACTED SECRET VALUE]",
        );
        expect(
          Number(script === "leak-token" ? output.redacted : output.scrubbed),
        ).toBeGreaterThanOrEqual(1);
        expect(output.audit_id).toBeTruthy();
      }
    }
    // E8-E9: check and execute agree when either exec or scrub permission is absent.
    for (const execute of [false, true]) {
      const denied = exec(["ls"], { execute, context: "limited" }, 1);
      expect(denied.code).toBe("FORBIDDEN");
      expect(denied.error).toContain("create pods/exec in fixtures");
      const unscrubbable = exec(["ls"], { execute, context: "operator" }, 1);
      expect(unscrubbable.code).toBe("SCRUB_UNAVAILABLE");
      expect(unscrubbable.error).toContain("db-creds");
      expect(unscrubbable.error).toContain("get secrets");
    }
    const nonzero = exec(["/scripts/exit7"], { execute: true }, 1);
    expect(nonzero).toMatchObject({
      code: "REMOTE_EXIT_NONZERO",
      remote_exit: 7,
    });
    const localStart = Date.now();
    const timeout = exec(
      ["sleep", "600"],
      { execute: true, timeout: 3, target: pod },
      1,
    );
    expect(timeout.code).toBe("TIMEOUT");
    expect(timeout.remote_process).toContain(
      `may still be running in ${pod}/app`,
    );
    // Pod lookup, permission and Secret reads happen before the 3s remote deadline.
    expect(parseInt(String(timeout.duration), 10)).toBeLessThanOrEqual(6000);
    expect(Date.now() - localStart).toBeLessThan(20_000);
    const localProcesses = spawnSync("ps", ["-axo", "command="], {
      encoding: "utf8",
    }).stdout;
    expect(
      localProcesses
        .split("\n")
        .filter((line) => line.includes(`kubectl exec ${pod} `)),
    ).toEqual([]);
    expect(audit()).toContain('"outcome":"timeout"');
    // E12: existing read-only state must not be chmod'ed into an execution permit.
    const dir = join(env.XDG_STATE_HOME, "k8s-axi");
    chmodSync(dir, 0o555);
    try {
      exec(["ls"]);
      expect(exec(["ls"], { execute: true }, 1).code).toBe("AUDIT_UNAVAILABLE");
    } finally {
      chmodSync(dir, 0o700);
    }
    for (const target of ["no-such-pod", "deployment/nope"]) {
      const output = exec(["ls"], { target }, 1);
      expect(output.code).toBe("NOT_FOUND");
      expect(output.error).toContain(target);
    }
    const container = exec(["ls"], { container: "missing" }, 1);
    expect(container.code).toBe("NOT_FOUND");
    expect(container.error).toContain("containers: app");
    for (const args of [
      ["exec", pod, "-A", "--", "ls"],
      ["exec", pod, "--execute", "-n", "fixtures", "--", "ls"],
      ["exec", pod, "--execute", "--context", context, "--", "ls"],
      ...[
        "--subresource",
        "--subresource=exec",
        "--subresource=portforward",
      ].map((flag) => [
        "exec",
        pod,
        "--context",
        context,
        "-n",
        "fixtures",
        "--execute",
        flag,
        ...(flag === "--subresource" ? ["exec"] : []),
        "--",
        "true",
      ]),
      ...["-i", "-t", "--stdin", "--tty"].map((flag) => [
        "exec",
        pod,
        flag,
        "--",
        "ls",
      ]),
    ])
      expect(run(args, 2).code).toBe("VALIDATION_ERROR");
    expect(exec(["true"], { execute: true, target: pod }).remote_exit).toBe(0);
    const transcript = join(process.env.TMPDIR ?? "", "exec-session.jsonl");
    writeFileSync(
      transcript,
      [
        `k8s-axi exec ${pod} -n fixtures --context ${context} --execute -- printenv DB_PASSWORD`,
        `k8s-axi exec ${pod} -- echo --context CANARY_ENV_8KSA`,
        `k8s-axi exec ${pod} -- echo --context=CANARY_ENV_8KSA`,
      ]
        .map((command) =>
          JSON.stringify({
            message: { content: [{ type: "tool_use", input: { command } }] },
          }),
        )
        .join("\n") + "\n",
    );
    run(
      ["context", "end"],
      0,
      JSON.stringify({ cwd: home, transcript_path: transcript }),
    );
    run(["audit", "--action", "exec"], 0);
    const written = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? written(join(directory, entry.name))
          : [readFileSync(join(directory, entry.name), "utf8")],
      );
    const all = outputs.join("\n") + written(home).join("\n");
    const secretList = JSON.parse(
      kubectl(["get", "secrets", "-n", "fixtures", "-o", "json"]),
    ) as { items: { data?: Record<string, string> }[] };
    const values = secretList.items.flatMap((item) =>
      Object.values(item.data ?? {}).map((value) =>
        Buffer.from(value, "base64").toString("utf8"),
      ),
    );
    values.push("CANARY_ENV_8KSA");
    const scan = (output: string) => {
      for (const value of values) {
        const bytes = Buffer.from(value);
        const forms = [
          value,
          bytes.toString("hex"),
          bytes.toString("hex").toUpperCase(),
          encodeURIComponent(value),
        ];
        for (const encoding of ["base64", "base64url"] as const) {
          forms.push(
            bytes.toString(encoding),
            bytes.toString(encoding).replace(/=+$/, ""),
          );
          for (let prefix = 0; prefix < 3; prefix++)
            forms.push(
              Buffer.concat([Buffer.alloc(prefix), bytes])
                .toString(encoding)
                .slice(
                  Math.ceil((prefix * 8) / 6),
                  Math.floor(((prefix + bytes.length) * 8) / 6),
                ),
            );
        }
        if (forms.some((form) => form.length >= 8 && output.includes(form)))
          throw new Error(
            "Secret canary found in exec output or written state",
          );
      }
    };
    expect(() => scan(values[0] ?? "")).toThrow("Secret canary"); // Negative control.
    scan(all);
    const token = kubectl([
      "exec",
      pod,
      "-n",
      "fixtures",
      "-c",
      "app",
      "--",
      "/scripts/leak-token",
    ]).trim();
    expect(token).toMatch(/^eyJ/);
    for (const start of [
      0,
      token.indexOf(".") + 1,
      token.lastIndexOf(".") + 1,
    ]) {
      const slice = token.slice(start, start + 20);
      if (slice.length >= 8 && all.includes(slice))
        throw new Error(
          "ServiceAccount token slice found in exec output or written state",
        );
    }
  },
  180_000,
);
