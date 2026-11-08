import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { expect, test } from "vitest";

const liveTest = test.skipIf(process.env.K8S_AXI_LAB_LIVE !== "1");
const namespace = `logs-${process.pid}-${Date.now()}`;
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

liveTest("log tails preserve newest whole lines and report errors safely", async () => {
  try {
    kubectl(["create", "namespace", namespace]);
    kubectl(["-n", namespace, "apply", "-f", "-"], `apiVersion: v1
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
      command: ["sh", "-c", "printf 'password=secret\\nAuthorization: Bearer token\\n'; sleep 3600"]
`);
    for (const pod of ["chatty", "web"])
      kubectl(["-n", namespace, "wait", "--for=jsonpath={.status.phase}=Running", `pod/${pod}`, "--timeout=120s"]);

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (kubectl(["-n", namespace, "logs", "chatty"]).includes("line 2999")) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    expect(ready).toBe(true);

    for (const [tail, first] of [[100, 2900], [1000, 2000]]) {
      const result = run(["pods", "logs", "chatty", "-n", namespace, "--tail", String(tail)]);
      expect(result.status).toBe(0);
      const output = decode(result.stdout);
      expect(output.logs).toEqual(Array.from({ length: tail }, (_, i) => `line ${first + i}`));
      expect(output["omitted-lines"]).toBe(3000 - tail);
      expect(output.shown).toBe(`line ${first}..line 2999`);
      if (tail === 1000) expect(output.help?.[0]).toContain("--tail 1000");
    }

    const previous = run(["pods", "logs", "chatty", "-n", namespace, "--previous"]);
    expect(previous.status).toBe(1);
    expect(previous.stdout).toContain("LOGS_UNAVAILABLE");

    const web = decode(run(["pods", "logs", "web", "-n", namespace]).stdout);
    expect(web.redacted).toBe(2);
    expect(web.logs).toEqual(["password=[REDACTED]", "Authorization: Bearer [REDACTED]"]);
  } finally {
    kubectl(["delete", "namespace", namespace, "--wait=false"]);
  }
});
