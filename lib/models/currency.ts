// A leaf split from pricing.ts so client code can import it without ~46KB of rates. Never converted:
// costs freeze at write time, so currencies are kept apart, never summed.

/** Both bulk price lists quote USD; Scaleway bills in euros and its own catalog says so. */
export type Currency = "USD" | "EUR";

/** Where a rate carries no currency — every entry vendored before the field existed. */
export const DEFAULT_CURRENCY: Currency = "USD";
