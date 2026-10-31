/** Sealing what ubercal keeps for people (Google refresh tokens, private calendar links) and signing what it hands out. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** A 32-byte key from any secret string: hex or base64 of 32 bytes is used as is, anything else is hashed. */
export function keyFrom(secret) {
  const text = String(secret || "");
  if (!text) throw new Error("missing key");
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  const decoded = Buffer.from(text, "base64");
  if (decoded.length === 32 && /^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return decoded;
  return createHash("sha256").update(text).digest();
}

export function seal(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

export function open(key, sealed) {
  const text = String(sealed || "");
  if (!text.startsWith("v1.")) throw new Error("unknown seal");
  const raw = Buffer.from(text.slice(3), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export function token(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

export function hmac(key, value) {
  return createHmac("sha256", key).update(String(value)).digest("base64url");
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** `payload.signature`, the payload being base64url JSON; null when it was tampered with or has expired. */
export function signJson(key, data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${hmac(key, payload)}`;
}

export function verifyJson(key, value, now = Date.now()) {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature || !safeEqual(signature, hmac(key, payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.exp === "number" && data.exp < now) return null;
    return data;
  } catch {
    return null;
  }
}
