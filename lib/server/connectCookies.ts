// Cookies used by the client connect flow. All httpOnly; secure in production.
export const COOKIE = {
  // Proves this browser started the approval (raw nonce; only its hash is stored).
  connect: "cp_connect",
  // The new agent key, kept for a few minutes so /connect/done can show it once.
  reveal: "cp_reveal",
  // Signed payer id, so this browser can see and revoke its connection.
  payer: "cp_payer",
} as const;

export const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/connect",
  maxAge: maxAgeSeconds,
});
