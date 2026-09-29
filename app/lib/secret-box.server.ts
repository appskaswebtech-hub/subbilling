// app/lib/secret-box.server.ts
//
// Encrypts secrets the app must be able to read back, such as a merchant's
// SMTP password. AES-256-GCM, so a tampered ciphertext fails to decrypt rather
// than decrypting to garbage.
//
// The key comes from APP_ENCRYPTION_KEY: 32 random bytes, base64-encoded.
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Rotating the key makes every stored secret unreadable. Merchants would have
// to re-enter them, so treat the key like the database password.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES  = 12;   // the GCM standard nonce length
// Stored with the ciphertext so a future algorithm or key change can be told
// apart from this one.
const VERSION   = "v1";

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("APP_ENCRYPTION_KEY is not set — cannot store or read encrypted settings.");
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  }
  return buf;
}

/** Whether secrets can be stored at all. Lets the settings page say so up front. */
export function encryptionConfigured(): boolean {
  try { key(); return true; } catch { return false; }
}

/** "v1:<iv>:<tag>:<ciphertext>", each part base64. */
export function encryptSecret(plain: string): string {
  const iv     = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const data   = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

/** Throws if the value was not produced by encryptSecret with the current key. */
export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(":");
  if (version !== VERSION || !iv || !tag || !data) {
    throw new Error("Unrecognised encrypted value");
  }
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
