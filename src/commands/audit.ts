import { encodeObject } from "../toon.js";
import { usage } from "../errors.js";
import { auditStorage, readAudit } from "../actions/audit.js";
import type { Parsed } from "../args.js";

export async function auditCommand(parsed: Parsed): Promise<string> {
  if (parsed.action !== "list")
    usage("audit does not accept a subcommand", "audit");
  const records = readAudit({
    limit: parsed.limit,
    action: parsed.auditAction,
  });
  return encodeObject({ ...auditStorage(), count: records.length, records }) + "\n";
}
