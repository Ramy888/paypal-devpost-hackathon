// On by default; INVOICE_REVIEW_ENABLED=false hides the invoice check and turns its route off.
export const reviewEnabled = () => process.env.INVOICE_REVIEW_ENABLED !== "false";
