import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { expect, test } from "vitest";

test.skipIf(process.env.K8S_AXI_LAB_LIVE !== "1")(
  "live Secret output stays clean and failures stay truthful",
  () => {
    expect(process.env.K8S_AXI_LAB_LIVE).toBe("1");
    const kubeconfigPath = process.env.KUBECONFIG;
    if (!kubeconfigPath?.includes("/.lab-live/"))
      throw new Error("lab KUBECONFIG is required");
    const cli = resolve(
      process.env.K8S_AXI_TEST_PACKAGE ?? ".",
      "dist/bin/k8s-axi.js",
    );
    const env: NodeJS.ProcessEnv = { ...process.env, KUBERC: "off" };
    const outputs: string[] = [];
    const run = (
      args: string[],
      status: number,
      extraEnv: NodeJS.ProcessEnv = {},
    ) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        env: { ...env, ...extraEnv },
        timeout: 30_000,
      });
      expect(result.error, args.join(" ")).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(status);
      outputs.push(result.stdout + result.stderr);
      return decode(result.stdout, { strict: true }) as Record<string, unknown>;
    };

    const nodeName = spawnSync(
      "kubectl",
      ["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8", env },
    ).stdout;
    const inspect = spawnSync("docker", ["inspect", nodeName], {
      encoding: "utf8",
    });
    expect(inspect.status).toBe(0);
    expect(JSON.parse(inspect.stdout)[0].HostConfig.NanoCpus).toBe(2_000_000_000);
    for (const args of [
      [],
      ["ctx"],
      ["setup", "status"],
      ["context"],
      ["nodes"],
      ["nodes", "view", nodeName],
      ["namespaces"],
      ["pods", "-n", "fixtures"],
      ["pods", "-n", "emptyns"],
      ["pods", "-A"],
      ["pods", "view", "chatty", "-n", "fixtures"],
      ["pods", "logs", "chatty", "-n", "fixtures"],
      ["events", "-n", "fixtures"],
      ["events", "-A"],
      ["deployments", "-n", "fixtures"],
      ["deployments", "view", "web", "-n", "fixtures"],
      ["deployments", "view", "broken", "-n", "fixtures"],
      ["jobs", "-n", "fixtures"],
      ["pvcs", "-A"],
      ["services", "-n", "fixtures"],
      ["triage", "-n", "fixtures"],
      ["secrets", "-n", "fixtures"],
    ]) {
      run(args, 0);
      if (
        [
          "nodes",
          "namespaces",
          "pods",
          "events",
          "deployments",
          "jobs",
          "pvcs",
          "services",
          "secrets",
        ].includes(args[0] ?? "")
      )
        run([...args, "--full"], 0);
    }
    for (const name of ["db-creds", "api-token", "app-dsn", "app-conn"])
      for (const full of [[], ["--full"]])
        run(["secrets", "view", name, "-n", "fixtures", ...full], 0);

    const webPod = spawnSync(
      "kubectl",
      [
        "get",
        "pods",
        "-n",
        "fixtures",
        "-l",
        "app=web",
        "-o",
        "jsonpath={.items[0].metadata.name}",
      ],
      { encoding: "utf8", env },
    );
    expect(webPod.status).toBe(0);
    run(["pods", "logs", webPod.stdout, "-n", "fixtures", "--tail", "20"], 0);
    run(["pods", "logs", "chatty", "--tail", "100", "-n", "fixtures"], 0);
    run(
      ["pods", "logs", "chatty", "--tail", "100", "-n", "fixtures", "--full"],
      0,
    );

    const missing = `axi-missing-${Date.now()}`;
    for (const noun of ["pods", "events", "deployments", "secrets", "triage"])
      expect(run([noun, "-n", missing], 1).code).toBe("NAMESPACE_NOT_FOUND");
    expect(run(["triage", "--context", missing], 1).code).toBe(
      "CONTEXT_NOT_FOUND",
    );
    expect(run(["pods", "view", "no-such-pod", "-n", "fixtures"], 1).code).toBe(
      "NOT_FOUND",
    );
    expect(
      run(["secrets", "-n", "fixtures", "--context", "limited"], 1).code,
    ).toBe("FORBIDDEN");
    expect(run(["pods", "-n", "fixtures", "--context", "ghost"], 1).code).toBe(
      "SERVER_UNREACHABLE",
    );
    expect(
      run(
        ["pods", "-n", "fixtures", "--context", "blackhole", "--timeout", "3"],
        1,
      ).code,
    ).toBe("TIMEOUT");
    expect(run(["pods", "-n", "emptyns", "--context", "nsonly"], 1).code).toBe(
      "FORBIDDEN",
    );
    expect(
      run(["pods"], 1, {
        KUBECONFIG: resolve(process.env.TMPDIR ?? "/tmp", "absent"),
      }).code,
    ).toBe("NO_CONTEXT");

    const unreadable = resolve(
      process.env.TMPDIR ?? "/tmp",
      `unreadable-${process.pid}`,
    );
    writeFileSync(unreadable, "apiVersion: v1\n");
    chmodSync(unreadable, 0);
    try {
      expect(run(["pods"], 1, { KUBECONFIG: unreadable }).code).toBe(
        "UPSTREAM_ERROR",
      );
    } finally {
      chmodSync(unreadable, 0o600);
      unlinkSync(unreadable);
    }

    const output = outputs.join("\n");
    const secrets = [
      "CANARY_DB_PASSWORD_8KSA",
      "CANARY_API_TOKEN_8KSA",
      "CANARY_NEUTRAL_DSN_8KSA",
      "CANARY_NEUTRAL_CONN_8KSA",
      "CANARY_ENV_8KSA",
      "CANARY_LOG_8KSA",
      "admin",
    ];
    const credentials = [
      process.env.K8S_AXI_LIMITED_TOKEN,
      process.env.K8S_AXI_NSONLY_TOKEN,
    ].filter((value): value is string => Boolean(value));
    const kubeconfig = readFileSync(kubeconfigPath, "utf8");
    for (const match of kubeconfig.matchAll(
      /^\s*(?:client-key-data|client-certificate-data|token|password|username):\s*(\S+)/gm,
    )) {
      if (match[1]) credentials.push(match[1]);
    }
    for (const value of [...secrets, ...credentials]) {
      const candidates = [value, Buffer.from(value).toString("base64")];
      if (credentials.includes(value) && value.length >= 12)
        candidates.push(value.slice(0, 12), value.slice(-12));
      for (const candidate of candidates)
        if (candidate && output.includes(candidate))
          throw new Error("Sensitive material appeared in CLI output");
    }
  },
  180_000,
);
