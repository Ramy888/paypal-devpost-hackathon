// PayPal Orders through the official PayPal Server SDK (APIMatic-generated). The rest of the
// app calls PayPal's REST API directly (lib/paypal.mjs): the SDK has no Invoicing controller.
import { ApiError, Client, Environment, OrdersController } from "@paypal/paypal-server-sdk";

// The SDK only knows these two hosts, so refuse anything else rather than guess between them.
const HOSTS = { "https://api-m.sandbox.paypal.com": Environment.Sandbox, "https://api-m.paypal.com": Environment.Production };
export function environmentFor(apiBase) {
  const env = HOSTS[(apiBase ?? "").replace(/\/+$/, "")];
  if (!env) throw new Error(`PAYPAL_API_BASE must be ${Object.keys(HOSTS).join(" or ")} for the PayPal Server SDK, got "${apiBase}".`);
  return env;
}

// Lent tokens are re-read this often, inside the REST client's 60 s refresh margin.
const LEND_SECONDS = 50;

const isStaleScopes = (err) => {
  if (!(err instanceof ApiError) || err.statusCode !== 403) return false;
  try {
    return (err.result?.name ?? JSON.parse(String(err.body)).name) === "NOT_AUTHORIZED";
  } catch {
    return false;
  }
};

/**
 * Orders API on the SDK, sharing the REST client's OAuth token so there is one token cache.
 * @param {{ apiBase: string, auth: { getToken: () => Promise<string>, revokeToken: () => Promise<void> }, adapter?: Function }} opts
 *   `adapter` is for tests: the SDK's axios-adapter seam.
 */
export function createOrdersApi({ apiBase, auth, adapter }) {
  const environment = environmentFor(apiBase);
  const build = () =>
    new OrdersController(
      new Client({
        environment,
        clientCredentialsAuthCredentials: {
          oAuthClientId: "unused: token comes from the provider",
          oAuthClientSecret: "unused",
          oAuthTokenProvider: async () => ({
            accessToken: await auth.getToken(),
            tokenType: "Bearer",
            expiry: BigInt(Math.floor(Date.now() / 1000) + LEND_SECONDS),
          }),
        },
        // The SDK's generated default is timeout 0 (wait forever). Retries stay off (its default):
        // a payment POST is only safe to repeat with the same PayPal-Request-Id, which callers set.
        timeout: 30_000,
        ...(adapter && { unstable_httpClientOptions: { adapter } }),
      }),
    );
  let orders = build();

  return {
    // Same retry-on-stale-scopes rule as lib/paypal.mjs: revoke the token, rebuild, try once more.
    async createOrder(args) {
      try {
        return await orders.createOrder(args);
      } catch (err) {
        if (!isStaleScopes(err)) throw err;
        await auth.revokeToken();
        orders = build();
        return orders.createOrder(args);
      }
    },
  };
}
