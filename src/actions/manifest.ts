import { constants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { parseAllDocuments } from "yaml";
import {
  validateNamespace,
  validateResourceName,
  type NamespaceName,
} from "../args.js";
import { fail, usage } from "../errors.js";
import { object, text, type Obj } from "../kubectl.js";

export const MANIFEST_CAP = 1024 * 1024;
export interface Manifest {
  value: Obj;
  kind: string;
  name: ReturnType<typeof validateResourceName>;
  namespace?: NamespaceName;
}

export async function readManifest(filename: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filename))
    usage("manifest URLs are not supported");
  let input: NodeJS.ReadableStream = process.stdin;
  let file;
  try {
    if (filename !== "-") {
      file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile())
        usage("manifest must be a regular file, not a directory");
      if (stat.size > MANIFEST_CAP) usage("manifest exceeds 1 MiB");
      input = createReadStream(filename, { fd: file.fd, autoClose: false });
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MANIFEST_CAP) usage("manifest exceeds 1 MiB");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      usage("manifest file not found");
    if (error instanceof Error && "code" in error && error.code === "EACCES")
      usage("manifest file is not readable");
    throw error;
  } finally {
    await file?.close();
  }
}

export function parseManifests(
  raw: string,
  namespace?: NamespaceName,
): Manifest[] {
  if (Buffer.byteLength(raw) > MANIFEST_CAP) usage("manifest exceeds 1 MiB");
  let values: unknown[];
  try {
    const docs = parseAllDocuments(raw, { uniqueKeys: true, version: "1.1" });
    if (docs.length > 50) usage("manifest exceeds 50 documents");
    values = docs.map((doc) => {
      if (doc.errors.length || doc.warnings.length)
        throw new Error("invalid YAML");
      return doc.toJS({ maxAliasCount: 50 });
    });
    // Reject cycles and excessive alias expansion before traversing JSON-compatible input.
    values = JSON.parse(JSON.stringify(values));
  } catch {
    usage("invalid YAML or JSON manifest (maximum 50 documents)");
  }
  const flattened: unknown[] = [];
  function add(value: unknown, depth = 0): void {
    if (flattened.length >= 50 || depth > 50)
      usage("manifest exceeds 50 documents");
    const wrapper = object(value);
    const kind = text(wrapper.kind);
    if (kind.endsWith("List")) {
      const items = wrapper.items;
      if (!Array.isArray(items)) usage("List requires items");
      for (const item of items) {
        if (kind === "List") {
          add(item, depth + 1);
          continue;
        }
        const member = object(item);
        const memberKind = kind.slice(0, -4);
        if (
          (member.kind !== undefined && member.kind !== memberKind) ||
          (member.apiVersion !== undefined &&
            member.apiVersion !== wrapper.apiVersion)
        )
          usage("typed List item conflicts with wrapper kind or apiVersion");
        add(
          {
            ...member,
            apiVersion: wrapper.apiVersion,
            kind: memberKind,
          },
          depth + 1,
        );
      }
    } else if (value !== null) flattened.push(value);
  }
  values.forEach((value) => add(value));
  if (!flattened.length) usage("manifest contains no objects");
  return flattened.map((value, i) => {
    const doc = object(value),
      meta = object(doc.metadata);
    const kind = text(doc.kind),
      apiVersion = text(doc.apiVersion);
    if (
      !/^[A-Za-z][A-Za-z0-9]*$/.test(kind) ||
      !/^(?:[a-z0-9.-]+\/)?v[0-9][a-z0-9]*$/.test(apiVersion) ||
      !text(meta.name)
    )
      usage(`document ${i + 1} requires apiVersion, kind and metadata.name`);
    const name = validateResourceName(text(meta.name));
    const ns =
      meta.namespace === undefined
        ? undefined
        : validateNamespace(text(meta.namespace));
    if (namespace && ns && namespace !== ns)
      usage(`document ${i + 1} namespace conflicts with -n`);
    if (/^secrets?$/i.test(kind)) {
      if (kind !== "Secret") usage(`document ${i + 1} must use kind: Secret`);
      const keys: string[] = [];
      for (const field of ["data", "stringData"]) {
        if (
          doc[field] !== undefined &&
          (typeof doc[field] !== "object" ||
            doc[field] === null ||
            Array.isArray(doc[field]))
        )
          usage(`document ${i + 1} Secret ${field} must be a map`);
        for (const [key, v] of Object.entries(object(doc[field])))
          if (v !== "<redacted>") keys.push(key);
      }
      if (keys.length)
        fail(
          "SECRET_MANIFEST",
          `document ${i + 1} Secret ${ns ?? namespace ?? "(context namespace)"}/${name} has non-placeholder keys: ${keys.join(", ")}`,
          [
            'Replace every Secret value with "<redacted>" to preview keys and type; manage values with the Secret tool',
          ],
        );
    }
    return { value: doc, kind, name, namespace: ns };
  });
}
