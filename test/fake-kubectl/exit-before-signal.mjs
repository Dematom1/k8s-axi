import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Keep the failed supervisor alive until the CLI reaches its group-signal check.
if (process.argv[1]?.endsWith("k8s-axi-pf-supervisor.js"))
  setInterval(() => {}, 1000);

if (
  process.argv[1]?.endsWith("k8s-axi.js") &&
  process.argv.includes("--execute")
) {
  const kill = process.kill.bind(process);
  process.kill = (pid, signal) => {
    if (
      pid < 0 &&
      signal === "SIGTERM" &&
      process.env.TEST_PF_SIGNAL === "SIGKILL"
    )
      return true;
    if (pid < 0 && signal === process.env.TEST_PF_SIGNAL) {
      appendFileSync(`${process.env.K8S_AXI_SCENARIO}.signals`, `${signal}\n`);
      if (process.env.TEST_PF_GROUP === "exited") {
        kill(pid, "SIGKILL");
        let exited = false;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          try {
            const status = execFileSync(
              "/bin/ps",
              ["-o", "stat=", "-p", String(-pid)],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              },
            ).trim();
            if (status.startsWith("Z")) {
              exited = true;
              break;
            }
          } catch {
            exited = true;
            break;
          }
        }
        if (!exited) throw new Error("test process group did not exit");
      }
      throw Object.assign(new Error("kill EPERM"), {
        code: "EPERM",
        errno: -1,
        syscall: "kill",
      });
    }
    return kill(pid, signal);
  };
}
