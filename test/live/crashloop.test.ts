import { execFileSync } from "node:child_process";
import { test } from "vitest";
import { resolve } from "node:path";

test.skipIf(process.env.K8S_AXI_LAB_LIVE !== "1")(
  "crash loops remain visible for the first 120 seconds",
  () =>
    execFileSync("bash", [resolve("test/live/crashloop.sh")], {
      stdio: "inherit",
      env: process.env,
      timeout: 20 * 60 * 1000,
    }),
  20 * 60 * 1000,
);
