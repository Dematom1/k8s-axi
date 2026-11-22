import {
  appendFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { SECRET_TEMPLATE } from "../../dist/src/registry.js";
const args = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.K8S_AXI_SCENARIO, "utf8"));
if (process.env.K8S_AXI_CALLS)
  appendFileSync(
    process.env.K8S_AXI_CALLS,
    JSON.stringify({ args, kuberc: process.env.KUBERC }) + "\n",
  );
const match = (scenario.rules ?? []).find((r) =>
  r.prefix.every((x, i) => args[i] === x),
);
if (
  args[0] === "get" &&
  args[1] === "secrets" &&
  !args.includes("--output=go-template=" + SECRET_TEMPLATE)
) {
  process.stdout.write(
    JSON.stringify({
      kind: "Secret",
      data: { token: "CANARY_UNPROJECTED_SECRET" },
    }),
  );
  process.exit(0);
}
const r = match ??
  scenario.default ?? { stdout: JSON.stringify({ items: [] }) };
if (r.mode === "port-forward-ipv6-silent") {
  // Captured from kubectl v1.36.2: IPv4 collision leaves only this stdout and no stderr.
  const [local, remote] = args[2].split(":");
  process.stdout.write(
    `Forwarding from [::1]:${local || "55874"} -> ${remote}\n`,
  );
  setInterval(() => {}, 1000);
} else if (r.mode === "port-forward-ipv6-only") {
  const [local, remote] = args[2].split(":");
  process.stdout.write(`Forwarding from [::1]:${local} -> ${remote}\n`);
  process.stderr.write(
    `Unable to create listener: Error listen tcp4 127.0.0.1:${local}: bind: address already in use\n`,
  );
  setInterval(() => {}, 1000);
} else if (r.mode === "port-forward") {
  const [local, remote] = args[2].split(":");
  const server = createServer((_req, res) => res.end("k8s-axi-echo\n"));
  server.on("error", () => {
    process.stderr.write("Unable to listen on port: address already in use\n");
    process.exitCode = 1;
  });
  server.listen(Number(local) || 0, "127.0.0.1", () => {
    process.stdout.write(
      `Forwarding from 127.0.0.1:${server.address().port} -> ${remote}\nForwarding from [::1]:${server.address().port} -> ${remote}\n`,
    );
  });
} else if (r.mode === "stdin") {
  let bytes = 0;
  process.stdin.on("data", (b) => (bytes += b.length));
  process.stdin.on("end", () =>
    process.stdout.write(bytes === 0 ? "closed" : "unexpected input"),
  );
  process.stdin.resume();
} else if (r.mode === "hang") setInterval(() => {}, 1000);
else if (r.mode === "ignore-term") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (r.mode === "grandchild" || r.mode === "grandchild-ignore-term") {
  const p = spawn(
    process.execPath,
    [
      "-e",
      (r.mode === "grandchild-ignore-term"
        ? "process.on('SIGTERM',()=>{});"
        : "") + "setInterval(()=>{},1000)",
    ],
    {
      stdio: ["ignore", 1, 2],
    },
  );
  if (process.env.K8S_AXI_PID)
    writeFileSync(process.env.K8S_AXI_PID, String(p.pid));
  setInterval(() => {}, 1000);
} else if (r.mode === "audit-end-fail") {
  chmodSync(`${process.env.XDG_STATE_HOME}/k8s-axi`, 0o555);
  process.stdout.write("action ran");
} else if (r.mode === "require-audit") {
  const record = readFileSync(
    `${process.env.XDG_STATE_HOME}/k8s-axi/audit.jsonl`,
    "utf8",
  )
    .trim()
    .split("\n")
    .at(-1);
  if (JSON.parse(record).phase !== "start") process.exitCode = 55;
  else process.stdout.write("audit precedes effect");
} else if (r.mode === "huge") process.stdout.write("x".repeat(100000));
else
  setTimeout(() => {
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    process.exitCode = r.code ?? 0;
  }, r.delayMs ?? 0);
