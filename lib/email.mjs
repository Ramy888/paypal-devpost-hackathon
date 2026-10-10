// One email check for everything PayPal will send to. Domain labels are letters, digits and
// hyphens with at least one dot between them: PayPal rejects "name@example.com." (trailing dot).
const EMAIL = /^[^\s@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export const isEmail = (s) => typeof s === "string" && EMAIL.test(s);
