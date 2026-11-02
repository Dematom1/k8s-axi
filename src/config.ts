import { homedir } from "node:os";
import { join } from "node:path";
export function configPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "k8s-axi",
    "config.json",
  );
}
