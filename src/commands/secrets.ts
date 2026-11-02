import type { Parsed } from "../args.js";
import { deadline } from "../registry.js";
import { resolveTarget, resolveScope, scopeLabel, scoped } from "../target.js";
import { kubectl } from "../kubectl.js";
import {
  parseSecrets,
  secretRow,
  secretDetail,
  secretSpec,
} from "../model/secrets.js";
import { renderList, validateFields } from "../render.js";
import { encodeObject } from "../toon.js";
import { fail } from "../errors.js";
export async function secretsCommand(p: Parsed): Promise<string> {
  validateFields(secretSpec, p);
  const d = deadline(p.timeout),
    t = await resolveTarget(p.context, d),
    s = resolveScope(p, t);
  const rows = await scoped(s, t, d, async () =>
    parseSecrets(
      await kubectl({ op: "secrets", scope: s, name: p.name }, t, d),
    ),
  );
  if (p.action === "view") {
    const row = rows[0];
    if (!row) fail("NOT_FOUND", "Secret not found in the cluster");
    return encodeObject({ context: t.context, ...secretDetail(row) });
  }
  return renderList(
    rows.map((x) => secretRow(x, s.kind === "all")),
    secretSpec,
    p,
    scopeLabel(s),
    t.context,
  );
}
