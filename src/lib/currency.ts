export interface CurrencyOption {
  code: string;
  label: string;
}

// A curated set covering the pilot market plus common regional/international
// options an organizer might reasonably need — not the full ISO 4217 list.
export const CURRENCIES: CurrencyOption[] = [
  { code: "TZS", label: "Tanzanian Shilling (TZS)" },
  { code: "KES", label: "Kenyan Shilling (KES)" },
  { code: "UGX", label: "Ugandan Shilling (UGX)" },
  { code: "RWF", label: "Rwandan Franc (RWF)" },
  { code: "ZAR", label: "South African Rand (ZAR)" },
  { code: "NGN", label: "Nigerian Naira (NGN)" },
  { code: "GHS", label: "Ghanaian Cedi (GHS)" },
  { code: "USD", label: "US Dollar (USD)" },
  { code: "EUR", label: "Euro (EUR)" },
  { code: "GBP", label: "British Pound (GBP)" },
];

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code) as [string, ...string[]];

export const DEFAULT_CURRENCY = "TZS";

// These shillings/francs have no meaningful subunit in everyday use, so
// amounts round to whole units for display (still stored as integer minor
// units internally, consistent with every other currency).
const ZERO_DECIMAL_CURRENCIES = new Set(["TZS", "UGX", "RWF"]);

export function isZeroDecimalCurrency(code: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(code);
}

export function currencyLabel(code: string): string {
  return CURRENCIES.find((c) => c.code === code)?.label ?? code;
}
