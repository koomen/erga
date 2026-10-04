// SSH signatures (sshsig.ts) against the real ssh-keygen: each key type it
// makes, signed with `ssh-keygen -Y sign`, verifies; anything changed (the
// message, the namespace, the key) doesn't. Security keys can't be made
// without the hardware, so their signatures are put together here the way a
// key would make them.

import { expect, test } from "bun:test";
import { armor, parsePublicKey, parseSignature, SshError, verifySignature, wire } from "../sshsig";
import { keygen, sign } from "./ssh-keys";

const KINDS: [string, string[]][] = [
  ["ed25519", ["-t", "ed25519"]],
  ["ecdsa256", ["-t", "ecdsa", "-b", "256"]],
  ["ecdsa384", ["-t", "ecdsa", "-b", "384"]],
  ["ecdsa521", ["-t", "ecdsa", "-b", "521"]],
  ["rsa", ["-t", "rsa", "-b", "3072"]],
];

for (const [name, args] of KINDS) {
  test(`${name}: ssh-keygen's signature verifies, and nothing else does`, async () => {
    const k = keygen(name, args);
    const key = await parsePublicKey(k.pub);
    expect(key.comment).toBe(`${name}@test`);
    // The fingerprint is ssh-keygen's own.
    const printed = Bun.spawnSync(["ssh-keygen", "-l", "-E", "sha256", "-f", `${k.path}.pub`]).stdout.toString().split(" ")[1];
    expect(key.fingerprint).toBe(printed);
    const message = "erga-admin unlock example.com ada nonce123 1700000000";
    const sig = await parseSignature(sign(k.path, message));
    expect(await verifySignature(sig, key, "erga-admin", message)).toBe(true);
    expect(await verifySignature(sig, key, "erga-admin", message + "x")).toBe(false);
    expect(await verifySignature(sig, key, "git", message)).toBe(false);
    // Signed in another namespace: refused even with the right message.
    const other = await parseSignature(sign(k.path, message, "file"));
    expect(await verifySignature(other, key, "erga-admin", message)).toBe(false);
    // Another key's signature, claiming to be this key's.
    const stranger = keygen(`${name}`, args);
    const theirs = await parseSignature(sign(stranger.path, message));
    expect(await verifySignature(theirs, key, "erga-admin", message)).toBe(false);
  });
}

test("keys it won't take say why", async () => {
  await expect(parsePublicKey("hello")).rejects.toBeInstanceOf(SshError);
  await expect(parsePublicKey("-----BEGIN OPENSSH PRIVATE KEY----- abc")).rejects.toThrow(/private key/);
  const dsa = "ssh-dss " + btoa("\x00\x00\x00\x07ssh-dss");
  await expect(parsePublicKey(dsa)).rejects.toThrow(/not ssh-dss/);
  const short = keygen("rsa1024", ["-t", "rsa", "-b", "1024"]);
  await expect(parsePublicKey(short.pub)).rejects.toThrow(/too short/);
  const ed = keygen("mislabel", ["-t", "ed25519"]);
  await expect(parsePublicKey(ed.pub.replace("ssh-ed25519", "ssh-rsa"))).rejects.toThrow(/says it's/);
  await expect(parseSignature("not a signature")).rejects.toThrow(/BEGIN SSH SIGNATURE/);
});

test("security keys: a signature made the way a FIDO key makes it verifies, only with user presence", async () => {
  const { sshString, concat, u32, signedData, digest } = wire;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pk = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const type = "sk-ssh-ed25519@openssh.com";
  const blob = concat(sshString(type), sshString(pk), sshString("ssh:"));
  const key = await parsePublicKey(`${type} ${btoa(String.fromCharCode(...blob))} yubikey`);
  const message = "erga-admin unlock example.com ada n 1";
  const make = async (flags: number) => {
    const data = await signedData("erga-admin", "sha512", new TextEncoder().encode(message));
    const signed = concat(await digest("SHA-256", new TextEncoder().encode("ssh:")), new Uint8Array([flags]), u32(7), await digest("SHA-256", data));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, signed));
    return parseSignature(armor(blob, "erga-admin", "sha512", concat(sshString(type), sshString(raw), new Uint8Array([flags]), u32(7))));
  };
  expect(await verifySignature(await make(0x01), key, "erga-admin", message)).toBe(true);
  expect(await verifySignature(await make(0x00), key, "erga-admin", message)).toBe(false);
});
