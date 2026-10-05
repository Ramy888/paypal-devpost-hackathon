import { timingSafeEqual } from "node:crypto";

// Constant-time check of an `Authorization: Bearer <token>` header.
export function bearerMatches(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
