import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export async function fakeAPI() {
  const dir = mkdtempSync(join(tmpdir(), "k8s-api-"));
  const calls: { method: string; path: string }[] = [];
  let expired = false;
  const secret = (name: string) => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace: "sandbox",
      creationTimestamp: "2020-01-01T00:00:00Z",
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
          data: { token: "CANARY_BASE64_PAYLOAD" },
          stringData: { token: "CANARY_STRING" },
        }),
        free: "CANARY_ANNOTATION",
        doubleEscaped: JSON.stringify(
          JSON.stringify({ password: "CANARY_DOUBLE_ESCAPED" }),
        ),
        escaped: String.raw`{\"password\":\"CANARY_ESCAPED\"}`,
      },
      labels: { free: "CANARY_LABEL" },
    },
    type: 'custom/quoted"type',
    data: {
      "tls.crt": "CANARY_BASE64_PAYLOAD",
      "weird_key-1.x": "CANARY_STRING",
    },
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    calls.push({ method: req.method ?? "", path: req.url ?? "" });
    res.setHeader("Content-Type", "application/json");
    let body: unknown;
    if (url.pathname === "/api")
      body = {
        kind: "APIVersions",
        apiVersion: "v1",
        versions: ["v1"],
        serverAddressByClientCIDRs: [],
      };
    else if (url.pathname === "/apis")
      body = { kind: "APIGroupList", apiVersion: "v1", groups: [] };
    else if (url.pathname === "/api/v1")
      body = {
        kind: "APIResourceList",
        apiVersion: "v1",
        groupVersion: "v1",
        resources: [
          {
            name: "secrets",
            singularName: "secret",
            namespaced: true,
            kind: "Secret",
            verbs: ["get", "list"],
          },
          {
            name: "namespaces",
            singularName: "namespace",
            namespaced: false,
            kind: "Namespace",
            verbs: ["get", "list"],
          },
        ],
      };
    else if (url.pathname === "/api/v1/namespaces/sandbox")
      body = {
        kind: "Namespace",
        apiVersion: "v1",
        metadata: { name: "sandbox" },
      };
    else if (url.pathname.endsWith("/secrets")) {
      if (url.searchParams.get("continue") && expired) {
        res.statusCode = 410;
        body = {
          kind: "Status",
          apiVersion: "v1",
          status: "Failure",
          reason: "Expired",
          message: "continue token expired",
          code: 410,
        };
      } else {
        const name = url.searchParams.get("fieldSelector")?.split("=")[1];
        const items =
          name === "absent"
            ? []
            : name
              ? [secret(name)]
              : url.searchParams.get("continue")
                ? [secret("second")]
                : [secret("first")];
        body = {
          kind: "SecretList",
          apiVersion: "v1",
          metadata: {
            resourceVersion: "1",
            continue: !name && !url.searchParams.get("continue") ? "next" : "",
          },
          items,
        };
      }
    } else {
      res.statusCode = 404;
      body = {
        kind: "Status",
        apiVersion: "v1",
        status: "Failure",
        reason: "NotFound",
        code: 404,
      };
    }
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no server address");
  const kubeconfig = join(dir, "config");
  writeFileSync(
    kubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "test",
          cluster: { server: `http://127.0.0.1:${address.port}` },
        },
      ],
      contexts: [
        {
          name: "default",
          context: { cluster: "test", user: "test", namespace: "sandbox" },
        },
      ],
      users: [{ name: "test", user: {} }],
      "current-context": "default",
    }),
  );
  mkdirSync(join(dir, ".kube"));
  writeFileSync(
    join(dir, ".kube", "kuberc"),
    "apiVersion: kubectl.config.k8s.io/v1beta1\nkind: Preference\ndefaults:\n- command: get\n  options:\n  - name: selector\n    default: canary=1\n",
  );
  return {
    dir,
    kubeconfig,
    calls,
    expire: () => {
      expired = true;
    },
    close: async () => {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
