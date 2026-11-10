import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { expect, test } from "vitest";

const liveTest = test.skipIf(process.env.K8S_AXI_LAB_LIVE !== "1");
const namespace = `logs-${process.pid}-${Date.now()}`;
const ownerLabel = "k8s-axi-run";
const owner = randomUUID();
type LogsOutput = {
  logs: string[];
  "omitted-lines": number | null;
  "more-lines": boolean;
  shown: string[];
  help?: string[];
  redacted: number;
};
const cliPath = resolve("dist/bin/k8s-axi.js");
function kubectl(args: string[], input?: string) {
  const result = spawnSync("kubectl", args, {
    encoding: "utf8",
    env: process.env,
    input,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function run(args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

liveTest(
  "log tails preserve newest whole lines and report errors safely",
  async () => {
    let created = false;
    try {
      kubectl(["create", "namespace", namespace]);
      created = true;
      kubectl([
        "label",
        "namespace",
        namespace,
        `${ownerLabel}=${owner}`,
        "--overwrite=false",
      ]);
      kubectl(
        ["-n", namespace, "apply", "-f", "-"],
        `apiVersion: v1
kind: Pod
metadata:
  name: chatty
spec:
  restartPolicy: Never
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "i=0; while [ $i -lt 3000 ]; do printf 'line %s\\n' $i; i=$((i+1)); done; sleep 3600"]
---
apiVersion: v1
kind: Pod
metadata:
  name: web
spec:
  restartPolicy: Never
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "printf 'password=secret\\nAuthorization: Bearer token\\n'"]
`,
      );
      kubectl([
        "-n",
        namespace,
        "wait",
        "--for=jsonpath={.status.phase}=Running",
        "pod/chatty",
        "--timeout=120s",
      ]);
      kubectl([
        "-n",
        namespace,
        "wait",
        "--for=jsonpath={.status.phase}=Succeeded",
        "pod/web",
        "--timeout=120s",
      ]);
      for (let attempt = 0; attempt < 60; attempt++) {
        if (
          kubectl([
            "-n",
            namespace,
            "logs",
            "chatty",
            "-c",
            "app",
            "--tail=1",
          ]).includes("line 2999")
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (attempt === 59)
          throw new Error("chatty fixture did not reach line 2999");
      }

      for (const [tail, first] of [
        [100, 2900],
        [1000, 2000],
      ] as const) {
        const args = [
          "pods",
          "logs",
          "chatty",
          "-n",
          namespace,
          "--tail",
          String(tail),
        ];
        if (tail === 1000) args.push("--full");
        const result = run(args);
        expect(result.status).toBe(0);
        const output = decode(result.stdout) as LogsOutput;
        expect(output.logs).toEqual(
          Array.from({ length: tail }, (_, i) => `line ${first + i}`),
        );
        expect(output["omitted-lines"]).toBeNull();
        expect(output["more-lines"]).toBe(true);
        expect(output.shown).toEqual([`line ${first}`, "line 2999"]);
        expect(output.help?.[0]).toBeDefined();
        if (tail === 100) expect(output.help?.[0]).toContain("--tail 200");
        if (tail === 1000)
          expect(output.help?.[0]).toContain("--tail is capped at 1000");
      }

      const previous = run([
        "pods",
        "logs",
        "chatty",
        "-n",
        namespace,
        "--previous",
      ]);
      expect(previous.status).toBe(1);
      expect(previous.stdout).toContain("LOGS_UNAVAILABLE");

      const webResult = run(["pods", "logs", "web", "-n", namespace]);
      expect(webResult.status).toBe(0);
      const web = decode(webResult.stdout) as LogsOutput;
      expect(web.redacted).toBe(2);
      expect(web.logs).toEqual([
        "password=[REDACTED]",
        "Authorization: Bearer [REDACTED]",
      ]);
    } finally {
      if (created) {
        const currentOwner = spawnSync(
          "kubectl",
          [
            "get",
            "namespace",
            namespace,
            "-o=jsonpath={.metadata.labels.k8s-axi-run}",
          ],
          { encoding: "utf8", env: process.env, timeout: 30_000 },
        );
        if (currentOwner.status === 0 && currentOwner.stdout === owner)
          spawnSync(
            "kubectl",
            ["delete", "namespace", namespace, "--wait=false"],
            { stdio: "ignore", env: process.env },
          );
      }
    }
  },
  120_000,
);
