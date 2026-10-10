// Currencies PayPal can invoice in, and a default for the freelancer's country.
export const PAYPAL_CURRENCIES = [
  ["USD", "US dollar"], ["EUR", "Euro"], ["GBP", "British pound"], ["AUD", "Australian dollar"], ["BRL", "Brazilian real"],
  ["CAD", "Canadian dollar"], ["CHF", "Swiss franc"], ["CNY", "Chinese yuan"], ["CZK", "Czech koruna"], ["DKK", "Danish krone"],
  ["HKD", "Hong Kong dollar"], ["HUF", "Hungarian forint"], ["ILS", "Israeli shekel"], ["JPY", "Japanese yen"], ["MXN", "Mexican peso"],
  ["MYR", "Malaysian ringgit"], ["NOK", "Norwegian krone"], ["NZD", "New Zealand dollar"], ["PHP", "Philippine peso"], ["PLN", "Polish złoty"],
  ["SEK", "Swedish krona"], ["SGD", "Singapore dollar"], ["THB", "Thai baht"], ["TWD", "New Taiwan dollar"],
].map(([code, name]) => ({ code, name }));
const SUPPORTED = new Set(PAYPAL_CURRENCIES.map((c) => c.code));
export const isPayPalCurrency = (code) => SUPPORTED.has(code);

const EURO = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];
const BY_COUNTRY = {
  ...Object.fromEntries(EURO.map((c) => [c, "EUR"])),
  US: "USD", GB: "GBP", AU: "AUD", BR: "BRL", CA: "CAD", CH: "CHF", CN: "CNY", CZ: "CZK", DK: "DKK", HK: "HKD", HU: "HUF",
  IL: "ILS", JP: "JPY", MX: "MXN", MY: "MYR", NO: "NOK", NZ: "NZD", PH: "PHP", PL: "PLN", SE: "SEK", SG: "SGD", TH: "THB", TW: "TWD",
};

/** The local currency if PayPal can invoice in it, else USD (e.g. Egypt: PayPal has no EGP invoices). */
export const currencyForCountry = (country) => BY_COUNTRY[String(country ?? "").toUpperCase()] ?? "USD";

// IP-country headers set by common edges/CDNs. "XX"/"T1" mean unknown or Tor.
const IP_COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-country-code"];

/** Two-letter country of the request: from the edge's IP lookup, else the browser language's region. */
export function countryFromRequest(headers) {
  for (const h of IP_COUNTRY_HEADERS) {
    const v = headers.get(h)?.trim().toUpperCase();
    if (v && /^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1") return v;
  }
  const region = (headers.get("accept-language") ?? "").split(",")[0]?.match(/^[a-z]{2,3}-([A-Za-z]{2})\b/)?.[1];
  return region ? region.toUpperCase() : null;
}
