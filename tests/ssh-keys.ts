// SSH keys for tests, made and used with the real ssh-keygen, in a scratch
// folder of their own (removed when the process exits).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "erga-ssh-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

/** A new key (`ssh-keygen -t ed25519` unless `args` say otherwise): its private key's path and its .pub line. */
export function keygen(name: string, args: string[] = ["-t", "ed25519"]): { path: string; pub: string } {
  const path = join(dir, `${name}-${crypto.randomUUID().slice(0, 8)}`);
  const p = Bun.spawnSync(["ssh-keygen", "-q", "-N", "", "-C", `${name}@test`, "-f", path, ...args]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  return { path, pub: readFileSync(`${path}.pub`, "utf8").trim() };
}

/** `ssh-keygen -Y sign` of `message` with the key at `path`: the armored signature. */
export function sign(path: string, message: string, namespace = "erga-admin"): string {
  const file = join(dir, `msg-${crypto.randomUUID()}`);
  writeFileSync(file, message);
  const p = Bun.spawnSync(["ssh-keygen", "-Y", "sign", "-n", namespace, "-f", path, file]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  return readFileSync(`${file}.sig`, "utf8");
}

/** The command the server gives (printf %s '<message>' | ssh-keygen -Y sign ...), run as a person would, with the key at `path`. */
export function runCommand(command: string, path: string): string {
  const p = Bun.spawnSync(["sh", "-c", command.replace(/-f \S+$/, `-f '${path}'`)]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}
