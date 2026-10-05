import { createHmac, timingSafeEqual } from "node:crypto";

// Signed cookie values: "<value>.<hmac>". Used to remember which payer this browser connected.
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
};
const mac = (value: string) => createHmac("sha256", secret()).update(value).digest("base64url");

export const sign = (value: string) => `${value}.${mac(value)}`;

export function unsign(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(signed.slice(i + 1));
  const b = Buffer.from(mac(value));
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}
