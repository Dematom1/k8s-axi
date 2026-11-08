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
    expect(JSON.parse(inspect.stdout)[0].HostConfig.NanoCpus).toBe(
      2_000_000_000,
    );
    for (const args of [
      [],
      ["ctx"],
      ["setup", "status"],
      ["context"],
      ["nodes"],
      ["nodes", "view", nodeName],
      ["nodes", "view", nodeName, "--full"],
      ["namespaces"],
      ["pods", "-n", "fixtures"],
      ["pods", "-n", "emptyns"],
      ["pods", "-A"],
      ["pods", "--problems", "-n", "fixtures"],
      ["pods", "view", "chatty", "-n", "fixtures"],
      ["pods", "view", "chatty", "-n", "fixtures", "--full"],
      ["pods", "logs", "chatty", "-n", "fixtures"],
      ["events", "-n", "fixtures"],
      ["events", "-A"],
      ["deployments", "-n", "fixtures"],
      ["deployments", "view", "web", "-n", "fixtures"],
      ["deployments", "view", "web", "-n", "fixtures", "--full"],
      ["deployments", "view", "broken", "-n", "fixtures"],
      ["deployments", "view", "broken", "-n", "fixtures", "--full"],
      ["jobs", "-n", "fixtures"],
      ["pvcs", "-A"],
      ["services", "-n", "fixtures"],
      ["triage", "-n", "fixtures"],
      ["secrets", "-n", "fixtures"],
    ]) {
      run(args, 0);
    }
    expect(
      run(["deployments", "view", "broken", "-n", "fixtures", "--rollout-status"], 1).code,
    ).toBe("UPSTREAM_ERROR");
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
    run(["pods", "logs", webPod.stdout, "-n", "fixtures", "--tail", "20", "--full"], 0);
    run(["pods", "logs", "chatty", "--tail", "100", "-n", "fixtures"], 0);
    run(
      ["pods", "logs", "chatty", "--tail", "100", "-n", "fixtures", "--full"],
      0,
    );
    for (const pod of ["crashy", "crashy2"])
      for (const full of [[], ["--full"]])
        run(["pods", "logs", pod, "-n", "fixtures", "--previous", ...full], 0);
    const failedJobPod = spawnSync(
      "kubectl",
      ["get", "pods", "-n", "fixtures", "-l", "job-name=failjob", "-o", "jsonpath={.items[0].metadata.name}"],
      { encoding: "utf8", env },
    );
    expect(failedJobPod.status).toBe(0);
    for (const full of [[], ["--full"]])
      run(["pods", "logs", failedJobPod.stdout, "-n", "fixtures", ...full], 0);

    const alternate = run(
      ["pods", "-n", "fixtures", "--context", "kind-k8sx-alt"],
      0,
    );
    expect(JSON.stringify(alternate)).toContain("chatty");

    const missing = `axi-missing-${Date.now()}`;
    for (const noun of [
      "pods",
      "events",
      "deployments",
      "jobs",
      "pvcs",
      "services",
      "secrets",
      "triage",
    ])
      expect(run([noun, "-n", missing], 1).code).toBe("NAMESPACE_NOT_FOUND");
    expect(run(["triage", "--context", missing], 1).code).toBe(
      "CONTEXT_NOT_FOUND",
    );
    for (const [noun, name] of [
      ["pods", "no-such-pod"],
      ["deployments", "no-such-deployment"],
      ["secrets", "no-such-secret"],
    ] as const)
      expect(run([noun, "view", name, "-n", "fixtures"], 1).code).toBe(
        "NOT_FOUND",
      );
    for (const noun of ["jobs", "pvcs", "services"])
      expect(
        run([noun, "view", "no-such-object", "-n", "fixtures"], 2),
      ).toMatchObject({
        code: "VALIDATION_ERROR",
        help: [`Run \`k8s-axi ${noun} --help\``],
      });
    expect(
      run(["secrets", "-n", "fixtures", "--context", "limited"], 1).code,
    ).toBe("FORBIDDEN");
    expect(run(["pods", "-n", "default", "--context", "limited"], 1).code).toBe(
      "FORBIDDEN",
    );
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
      let canRead = true;
      try {
        readFileSync(unreadable);
      } catch {
        canRead = false;
      }
      if (!canRead)
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
      "CANARY_USERNAME_8KSA",
      "Q0FOQVJZX1VTRVJOQU1FXzhLU0E=",
      "Q0FOQVJZX0RCX1BBU1NXT1JEXzhLU0E=",
      "Q0FOQVJZX05FVVRSQUxfRFNOXzhLU0E=",
    ];
    const secretObjects = spawnSync(
      "kubectl",
      ["get", "secrets", "-n", "fixtures", "-o", "json"],
      { encoding: "utf8", env },
    );
    expect(secretObjects.status).toBe(0);
    const secretList = JSON.parse(secretObjects.stdout) as {
      items: {
        data?: Record<string, string>;
        metadata?: { annotations?: Record<string, string> };
      }[];
    };
    for (const secret of secretList.items) {
      for (const encoded of Object.values(secret.data ?? {})) {
        secrets.push(encoded, Buffer.from(encoded, "base64").toString());
      }
      const applied =
        secret.metadata?.annotations?.[
          "kubectl.kubernetes.io/last-applied-configuration"
        ];
      if (applied)
        secrets.push(applied, Buffer.from(applied).toString("base64"));
    }
    const credentials = [
      process.env.K8S_AXI_LIMITED_TOKEN,
      process.env.K8S_AXI_NSONLY_TOKEN,
    ];
    if (credentials.some((value) => !value))
      throw new Error("lab service-account tokens are required");
    const kubeconfig = readFileSync(kubeconfigPath, "utf8");
    for (const match of kubeconfig.matchAll(
      /^\s*(?:client-key-data|client-certificate-data|token|password|username):\s*(\S+)/gm,
    )) {
      if (match[1]) credentials.push(match[1]);
    }
    for (const value of [...secrets, ...credentials]) {
      if (!value) continue;
      const candidates = [value, Buffer.from(value).toString("base64")];
      if (credentials.includes(value)) {
        const encoded = Buffer.from(value).toString("base64");
        candidates.push(encoded);
        for (const representation of [value, encoded])
          for (let i = 0; i <= representation.length - 4; i++)
            candidates.push(representation.slice(i, i + 4));
      }
      for (const candidate of candidates)
        if (candidate && output.includes(candidate))
          throw new Error("Sensitive material appeared in CLI output");
    }
  },
  180_000,
);
