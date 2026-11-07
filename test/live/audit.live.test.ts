import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { cli } from "../helpers.js";

const live = process.env.K8S_AXI_LIVE === "1" ? test : test.skip;
live("disposable kind lab is up and audit reads an empty local state", () => {
  const kind = process.env.K8S_AXI_KIND;
  if (!kind) throw new Error("K8S_AXI_KIND is required for live tests");
  expect(
    execFileSync(kind, ["get", "clusters"], { encoding: "utf8" }),
  ).toContain("k8s-axi-live");
  expect(
    execFileSync(
      "kubectl",
      [
        "--context",
        "kind-k8s-axi-live",
        "-n",
        "fixtures",
        "get",
        "deployment",
        "web",
        "-o",
        "name",
      ],
      { encoding: "utf8" },
    ),
  ).toContain("deployment.apps/web");
  const state = mkdtempSync(join(tmpdir(), "k8s-axi-audit-live-"));
  try {
    const result = cli(["audit"], { XDG_STATE_HOME: state });
    expect(result.status).toBe(0);
    expect(result.data).toMatchObject({ count: 0, records: [] });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
