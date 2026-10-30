// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

/**
 * ISO 4217 minor-unit exponents for the canonical snapshot's `amountMinor`.
 *
 * A snapshot amount is only meaningful with an exponent the producer and the
 * governance layer agree on, so this is an explicit ISO 4217 table and not
 * `Intl.NumberFormat(...).maximumFractionDigits`: Intl reports CLDR DISPLAY
 * digits, which differ from ISO 4217 for 14 codes (RSD, ALL, IQD, IRR, MGA,
 * YER, ...). Reading RSD 1,500 as 1,500 minor units while the consumer reads
 * exponent 2 under-states it 100x, with no error on either side.
 *
 * The table is the governance layer's, entry for entry
 * (cesteral-governance-layer `lib/features/governance/budget-magnitude.ts`,
 * `ISO_4217_NON_DEFAULT_EXPONENTS`). `tests/mcp-server/tools/utils/iso-4217.test.ts`
 * pins the two as equal; change both together.
 */

/**
 * ISO 4217 codes whose minor-unit exponent is NOT 2. Every other recognised
 * code is 2.
 */
export const ISO_4217_NON_DEFAULT_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

let knownCurrencies: ReadonlySet<string> | null = null;

function isKnownCurrency(code: string): boolean {
  if (code in ISO_4217_NON_DEFAULT_EXPONENTS) return true;
  if (knownCurrencies === null) {
    // `Intl.supportedValuesOf` is used for MEMBERSHIP only, never for digits
    // (see above). Absent it, fall back to the shape check alone.
    knownCurrencies =
      typeof Intl.supportedValuesOf === "function"
        ? new Set(Intl.supportedValuesOf("currency"))
        : new Set();
  }
  return knownCurrencies.size === 0 ? true : knownCurrencies.has(code);
}

/**
 * The ISO 4217 minor-unit exponent for `currency` (JPY 0, USD 2, KWD 3), or
 * `null` when the code is not a recognised ISO 4217 currency, which includes
 * the "no currency" code XXX: such a currency is unresolved, never defaulted.
 * Codes match exactly: a lower-case or padded code is as unknown as a missing
 * one.
 */
export function currencyMinorUnitExponent(currency: string | null | undefined): number | null {
  if (!currency || currency === "XXX" || !/^[A-Z]{3}$/.test(currency)) return null;
  if (!isKnownCurrency(currency)) return null;
  return ISO_4217_NON_DEFAULT_EXPONENTS[currency] ?? 2;
}

/** `currency` when it is a recognised ISO 4217 code, else `null`. */
export function knownCurrencyOrNull(currency: string | null | undefined): string | null {
  return currencyMinorUnitExponent(currency) === null ? null : (currency as string);
}
