// SSH signatures (OpenSSH's SSHSIG, what `ssh-keygen -Y sign` makes),
// verified with WebCrypto alone, so the Worker and the tests run the same
// code. Admins prove they hold an SSH key with them (admin-keys.ts).
//
// The format (PROTOCOL.sshsig in OpenSSH): an armored blob
//
//   "SSHSIG" | uint32 1 | string publickey | string namespace | string reserved
//   | string hash_algorithm | string signature
//
// whose signature is over
//
//   "SSHSIG" | string namespace | string reserved | string hash_algorithm | string H(message)
//
// Key types: ssh-ed25519, ecdsa-sha2-nistp256/384/521, ssh-rsa (with
// rsa-sha2-256 or rsa-sha2-512, never SHA-1; 2048 bits or more), and the
// security-key ones, sk-ssh-ed25519@openssh.com and
// sk-ecdsa-sha2-nistp256@openssh.com (user presence required). A key in
// text is the usual "type base64 [comment]" line (id_ed25519.pub).

export const KEY_TYPES = [
  "ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa",
  "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;
export type KeyType = (typeof KEY_TYPES)[number];

/** A public key: its type, its wire blob, the "type base64" line (no comment) and its SHA256 fingerprint as ssh-keygen -l prints it. */
export interface PublicKey { type: KeyType; blob: Uint8Array; text: string; fingerprint: string; comment: string }

/** What's wrong with a key or a signature, in words a person can act on. */
export class SshError extends Error {}

const enc = new TextEncoder(), dec = new TextDecoder();
/** Bytes on an ArrayBuffer of their own, as WebCrypto wants them. */
type Bytes = Uint8Array<ArrayBuffer>;

// ---------------------------------------------------------------- wire format

class Reader {
  private at = 0;
  constructor(private bytes: Uint8Array) {}
  get done() { return this.at >= this.bytes.length; }
  u8(): number {
    if (this.at + 1 > this.bytes.length) throw new SshError("The data ends too soon.");
    return this.bytes[this.at++];
  }
  u32(): number {
    if (this.at + 4 > this.bytes.length) throw new SshError("The data ends too soon.");
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 4).getUint32(0);
    this.at += 4;
    return v;
  }
  raw(n: number): Bytes {
    if (n < 0 || this.at + n > this.bytes.length) throw new SshError("The data ends too soon.");
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  string(): Bytes { return this.raw(this.u32()); }
  text(): string { return dec.decode(this.string()); }
  /** An mpint, without its sign byte. */
  mpint(): Bytes {
    const b = this.string();
    let i = 0;
    while (i < b.length - 1 && b[i] == 0) i++;
    return b.slice(i);
  }
}

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const sshString = (b: Uint8Array | string) => { const bytes = typeof b == "string" ? enc.encode(b) : b; return concat(u32(bytes.length), bytes); };

const b64 = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string) => {
  try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { throw new SshError("That isn't valid base64."); }
};
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const digest = async (alg: string, data: Uint8Array) => new Uint8Array(await crypto.subtle.digest(alg, Uint8Array.from(data)));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length == b.length && a.every((x, i) => x == b[i]);

// ---------------------------------------------------------------- keys

const CURVES: Record<string, { name: string; size: number; hash: string }> = {
  nistp256: { name: "P-256", size: 32, hash: "SHA-256" },
  nistp384: { name: "P-384", size: 48, hash: "SHA-384" },
  nistp521: { name: "P-521", size: 66, hash: "SHA-512" },
};

/** The SHA256 fingerprint of a key's blob, as `ssh-keygen -l` prints it. */
export async function fingerprintOf(blob: Uint8Array): Promise<string> {
  return "SHA256:" + b64(await digest("SHA-256", blob)).replace(/=+$/, "");
}

/** Reads a key's wire blob: its type, checked for what this file can verify. */
export async function keyFromBlob(blob: Uint8Array, comment = ""): Promise<PublicKey> {
  const r = new Reader(blob);
  const type = r.text();
  if (!(KEY_TYPES as readonly string[]).includes(type)) throw new SshError(`Erga takes ed25519, ECDSA, RSA and security keys (sk-…), not ${type || "that kind of key"}.`);
  // Each part is read, so a key that's cut short or padded is refused here, not at the first signature.
  if (type == "ssh-ed25519") { if (r.string().length != 32) throw new SshError("That ed25519 key is the wrong size."); }
  else if (type.startsWith("ecdsa-sha2-")) { const curve = r.text(); if (`ecdsa-sha2-${curve}` != type || !CURVES[curve]) throw new SshError("That ECDSA key's curve doesn't match its type."); r.string(); }
  else if (type == "ssh-rsa") { r.mpint(); const n = r.mpint(); if (n.length * 8 < 2048) throw new SshError("That RSA key is too short: use 2048 bits or more (or, better, ed25519)."); }
  else if (type == "sk-ssh-ed25519@openssh.com") { if (r.string().length != 32) throw new SshError("That security key is the wrong size."); r.text(); }
  else { if (r.text() != "nistp256") throw new SshError("That security key's curve isn't nistp256."); r.string(); r.text(); }
  if (!r.done) throw new SshError("That key has extra data after it.");
  return { type: type as KeyType, blob, text: `${type} ${b64(blob)}`, fingerprint: await fingerprintOf(blob), comment };
}

/** Reads a public key as it's written in id_ed25519.pub (or as GitHub lists it): "type base64 [comment]". */
export async function parsePublicKey(line: string): Promise<PublicKey> {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || !parts[1]) throw new SshError("Paste a public key: one line, like “ssh-ed25519 AAAA… you@laptop” (the .pub file, never the private key).");
  if (/PRIVATE KEY/.test(line)) throw new SshError("That's a private key: never paste it anywhere. Paste the .pub file's one line instead.");
  const key = await keyFromBlob(unb64(parts[1]), parts.slice(2).join(" ").slice(0, 100));
  if (key.type != parts[0]) throw new SshError(`That key says it's ${parts[0]} but is ${key.type}.`);
  return key;
}

// ---------------------------------------------------------------- signatures

export interface Signature { key: PublicKey; namespace: string; hashAlgorithm: "sha256" | "sha512"; signature: Uint8Array }

/** Reads an armored SSH signature (-----BEGIN SSH SIGNATURE-----…). */
export async function parseSignature(armored: string): Promise<Signature> {
  const m = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(armored);
  if (!m) throw new SshError("Paste the whole signature, from -----BEGIN SSH SIGNATURE----- to -----END SSH SIGNATURE-----.");
  const r = new Reader(unb64(m[1].replace(/\s+/g, "")));
  if (dec.decode(r.raw(6)) != "SSHSIG") throw new SshError("That isn't an SSH signature.");
  if (r.u32() != 1) throw new SshError("That SSH signature's version isn't one Erga reads.");
  const key = await keyFromBlob(r.string());
  const namespace = r.text();
  r.string(); // reserved
  const hashAlgorithm = r.text();
  if (hashAlgorithm != "sha256" && hashAlgorithm != "sha512") throw new SshError(`That signature hashes with ${hashAlgorithm}: use sha256 or sha512.`);
  const signature = r.string();
  return { key, namespace, hashAlgorithm, signature };
}

/** The bytes the signer's key signed (before the key type's own hashing). */
async function signedData(namespace: string, hashAlgorithm: "sha256" | "sha512", message: Uint8Array): Promise<Bytes> {
  const h = await digest(hashAlgorithm == "sha256" ? "SHA-256" : "SHA-512", message);
  return concat(enc.encode("SSHSIG"), sshString(namespace), sshString(""), sshString(hashAlgorithm), sshString(h));
}

/** An mpint pair (r, s) as WebCrypto's ECDSA wants it: each left-padded to the curve's size. */
function ecdsaRaw(blob: Uint8Array, size: number): Bytes {
  const r = new Reader(blob);
  const pad = (n: Uint8Array) => { if (n.length > size) throw new SshError("That ECDSA signature is malformed."); const out = new Uint8Array(size); out.set(n, size - n.length); return out; };
  return concat(pad(r.mpint()), pad(r.mpint()));
}

const importEd25519 = (raw: Bytes) => crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
const importEcdsa = (q: Bytes, curve: string) => crypto.subtle.importKey("raw", q, { name: "ECDSA", namedCurve: curve }, false, ["verify"]);

/**
 * Whether `sig` is `key`'s signature of `message` in `namespace`. The key
 * that made it must be `key` itself (its blob, byte for byte), so a
 * signature names the key it's from but can't choose it.
 */
export async function verifySignature(sig: Signature, key: PublicKey, namespace: string, message: Uint8Array | string): Promise<boolean> {
  if (!sameBytes(sig.key.blob, key.blob)) return false;
  if (sig.namespace != namespace) return false;
  const data = await signedData(namespace, sig.hashAlgorithm, typeof message == "string" ? enc.encode(message) : message);
  const k = new Reader(key.blob);
  k.text();
  const s = new Reader(sig.signature);
  const format = s.text();
  const blob = s.string();
  try {
    switch (key.type) {
      case "ssh-ed25519": {
        if (format != "ssh-ed25519") return false;
        return await crypto.subtle.verify({ name: "Ed25519" }, await importEd25519(k.string()), blob, data);
      }
      case "ecdsa-sha2-nistp256": case "ecdsa-sha2-nistp384": case "ecdsa-sha2-nistp521": {
        if (format != key.type) return false;
        const curve = CURVES[k.text()];
        return await crypto.subtle.verify({ name: "ECDSA", hash: curve.hash }, await importEcdsa(k.string(), curve.name), ecdsaRaw(blob, curve.size), data);
      }
      case "ssh-rsa": {
        const hash = format == "rsa-sha2-512" ? "SHA-512" : format == "rsa-sha2-256" ? "SHA-256" : null;
        if (!hash) return false; // "ssh-rsa" signatures are SHA-1: refused.
        const e = k.mpint(), n = k.mpint();
        const pub = await crypto.subtle.importKey("jwk", { kty: "RSA", e: b64url(e), n: b64url(n), ext: true }, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
        return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, pub, blob, data);
      }
      case "sk-ssh-ed25519@openssh.com": case "sk-ecdsa-sha2-nistp256@openssh.com": {
        if (format != key.type) return false;
        const flags = s.u8(), counter = s.u32();
        // The security key must say someone touched it (user presence), and no extensions.
        if (!(flags & 0x01) || (flags & 0x80)) return false;
        const ed = key.type == "sk-ssh-ed25519@openssh.com";
        if (!ed) k.text();
        const pk = k.string(), application = enc.encode(k.text());
        const signed = concat(await digest("SHA-256", application), new Uint8Array([flags]), u32(counter), await digest("SHA-256", data));
        return ed
          ? await crypto.subtle.verify({ name: "Ed25519" }, await importEd25519(pk), blob, signed)
          : await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importEcdsa(pk, "P-256"), ecdsaRaw(blob, 32), signed);
      }
    }
  } catch (e) {
    if (e instanceof SshError) return false;
    return false;
  }
  return false;
}

/** For tests: an SSHSIG blob armored, as ssh-keygen prints it, from its parts. */
export function armor(key: Uint8Array, namespace: string, hashAlgorithm: string, signature: Uint8Array): string {
  const blob = concat(enc.encode("SSHSIG"), u32(1), sshString(key), sshString(namespace), sshString(""), sshString(hashAlgorithm), sshString(signature));
  const lines = b64(blob).match(/.{1,70}/g) ?? [];
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

/** For tests: the pieces the wire format is built from. */
export const wire = { sshString, u32, concat, signedData, digest };
