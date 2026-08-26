import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function sign(unsigned, secret) {
  return createHmac("sha256", secret).update(unsigned).digest("base64url");
}

export function createProfileSecret() {
  return randomBytes(32).toString("base64url");
}

export function hashProfileSecret(profileSecret, salt = randomBytes(16).toString("base64url")) {
  const hash = scryptSync(profileSecret, salt, 64).toString("base64url");
  return { salt, hash };
}

export function verifyProfileSecret(profileSecret, stored) {
  if (!profileSecret || !stored?.salt || !stored?.hash) return false;
  const actual = scryptSync(profileSecret, stored.salt, 64);
  const expected = Buffer.from(stored.hash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function issueToken(profileId, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "HWIL" });
  const payload = encode({ sub: profileId, iat: now, exp: now + ttlSeconds });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign(unsigned, secret)}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const actual = Buffer.from(parts[2], "utf8");
  const expected = Buffer.from(sign(unsigned, secret), "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = decode(parts[1]);
    if (!payload.sub || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
