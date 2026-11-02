import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
if (r.mode === "stdin") {
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
} else if (r.mode === "huge") process.stdout.write("x".repeat(100000));
else
  setTimeout(() => {
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    process.exitCode = r.code ?? 0;
  }, r.delayMs ?? 0);
