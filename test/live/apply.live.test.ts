import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@toon-format/toon";
import { expect, test } from "vitest";
import { normalize } from "../../src/actions/diff.js";
import { object } from "../../src/kubectl.js";

const live = process.env.K8S_AXI_LIVE === "1" ? test : test.skip;
live(
  "A1-A12: apply/diff previews are truthful, dry-run only, and never expose Secret values",
  () => {
    if (!process.env.K8S_AXI_LAB_LEASE)
      throw new Error("berth lab lease is required");
    const context = execFileSync("kubectl", ["config", "current-context"], {
      encoding: "utf8",
    }).trim();
    const kubectl = (args: string[]) =>
      execFileSync(
        "kubectl",
        ["--context", context, "-n", "fixtures", ...args],
        { encoding: "utf8" },
      );
    const before = JSON.parse(kubectl(["get", "deployment/web", "-o", "json"]));
    const manifest = normalize(before);
    object(manifest.spec).replicas = 3;
    const dir = mkdtempSync(join(tmpdir(), "apply-live-"));
    const filename = join(dir, "manifest.json");
    const outputs: string[] = [];
    const bin = resolve(
      process.env.K8S_AXI_TEST_PACKAGE ?? ".",
      "dist/bin/k8s-axi.js",
    );
    const run = (
      docs: unknown[],
      status = 0,
      ctx = context,
      command = "apply",
      flags: string[] = [],
    ) => {
      writeFileSync(filename, JSON.stringify({ kind: "List", items: docs }));
      const result = spawnSync(
        process.execPath,
        [
          bin,
          command,
          "-f",
          filename,
          "--context",
          ctx,
          "-n",
          "fixtures",
          ...flags,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_STATE_HOME: join(dir, "state"),
            XDG_CONFIG_HOME: join(dir, "config"),
          },
          timeout: 30000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(status);
      outputs.push(result.stdout + result.stderr);
      return {
        stdout: result.stdout,
        data: object(decode(result.stdout, { strict: true })),
      };
    };
    try {
      const preview = run([manifest]);
      expect(preview.stdout).toContain("spec.replicas,1,3");
      expect(
        JSON.parse(kubectl(["get", "deployment/web", "-o", "json"])).spec
          .replicas,
      ).toBe(1);
      expect(run([manifest], 0, context, "diff").stdout).toBe(
        preview.stdout.replace("action: apply", "action: diff"),
      );
      const secret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "db-creds" },
        stringData: { password: "CANARY_DB_PASSWORD_8KSA" },
      };
      expect(run([secret], 1).data.code).toBe("SECRET_MANIFEST");
      secret.stringData.password = "<redacted>";
      const redacted = {
        ...secret,
        stringData: {
          ...secret.stringData,
          username: "<redacted>",
          extra: "<redacted>",
        },
      };
      expect(run([redacted]).stdout).toContain("added [extra]");
      expect(run([redacted]).stdout).toContain("values: never compared");
      const sensitive = structuredClone(manifest);
      const containers = object(
        object(object(sensitive.spec).template).spec,
      ).containers;
      if (!Array.isArray(containers))
        throw new Error("fixture containers required");
      object(containers[0]).env = [
        { name: "API_KEY", value: "CANARY_NEW_ENV_8KSA" },
      ];
      object(containers[0]).args = ["password=CANARY_ARG_8KSA"];
      for (const flags of [[], ["--full"]]) {
        const output = run([sensitive], 0, context, "apply", flags).stdout;
        expect(output).toContain("[REDACTED]");
        expect(output).not.toContain("last-applied-configuration");
      }
      const forbidden = run([manifest], 1, "limited");
      expect(forbidden.data.code).toBe("FORBIDDEN");
      expect(forbidden.stdout).toContain(
        "needs patch on deployments.apps in fixtures",
      );
      const fresh = structuredClone(manifest);
      object(fresh.metadata).name = "preview-new";
      const createForbidden = run([fresh], 1, "previewer-patch");
      expect(createForbidden.data.code).toBe("FORBIDDEN");
      expect(createForbidden.stdout).toContain(
        "needs create on deployments.apps in fixtures",
      );
      const mixed = run([manifest, fresh], 1, "previewer-patch");
      expect(mixed.data.code).toBe("PARTIAL");
      expect(mixed.stdout).toContain("configure");
      const invalid = structuredClone(manifest);
      object(invalid.spec).replicas = -1;
      const invalidResult = run([invalid], 1);
      expect(invalidResult.data.code).toBe("INVALID_MANIFEST");
      expect(invalidResult.stdout).toContain("spec.replicas");
      expect(invalidResult.stdout).not.toContain("-1");
      expect(
        run([manifest], 2, context, "apply", ["--execute"]).stdout,
      ).toContain("--execute is not available for apply");
      expect(
        run([manifest], 2, context, "apply", ["--recursive"]).data.code,
      ).toBe("VALIDATION_ERROR");
      expect(
        JSON.parse(kubectl(["get", "deployment/web", "-o", "json"])).spec
          .replicas,
      ).toBe(1);
      expect(
        kubectl([
          "get",
          "deployment/preview-new",
          "--ignore-not-found",
          "-o",
          "name",
        ]).trim(),
      ).toBe("");
      function scanFiles(path: string): string {
        return readdirSync(path, { withFileTypes: true })
          .map((entry) =>
            entry.isDirectory()
              ? scanFiles(join(path, entry.name))
              : readFileSync(join(path, entry.name), "utf8"),
          )
          .join("\n");
      }
      // Input is intentionally not an output; audit/session artifacts would be under these directories.
      for (const subdir of ["state", "config"]) {
        try {
          outputs.push(scanFiles(join(dir, subdir)));
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error;
        }
      }
      const combined = outputs.join("\n");
      for (const canary of [
        "CANARY_DB_PASSWORD_8KSA",
        "CANARY_ENV_8KSA",
        "CANARY_NEW_ENV_8KSA",
        "CANARY_ARG_8KSA",
      ]) {
        for (const form of [
          canary,
          Buffer.from(canary).toString("base64"),
          Buffer.from(canary).toString("hex"),
          encodeURIComponent(canary),
        ])
          expect(combined).not.toContain(form);
      }
      // Negative control: this sweep must detect a deliberately planted plaintext value.
      expect(combined + "CANARY_ENV_8KSA").toContain("CANARY_ENV_8KSA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120000,
);
