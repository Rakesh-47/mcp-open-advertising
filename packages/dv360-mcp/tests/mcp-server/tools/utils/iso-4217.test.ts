// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

/**
 * The ISO 4217 minor-unit exponents a snapshot's `amountMinor` is denominated
 * in, and the pin that keeps this producer and the governance layer reading
 * the same unit (#300 review S2).
 *
 * `amountMinor` is only meaningful with an exponent both sides agree on. The
 * governance layer converts it back to major units with an explicit ISO 4217
 * table; if the producer used anything else (it used `Intl`, whose CLDR display
 * digits differ from ISO 4217 for 14 codes, RSD among them) an amount is
 * mis-sized by a power of ten with no error on either side.
 */

import { describe, it, expect } from "vitest";
import {
  ISO_4217_NON_DEFAULT_EXPONENTS,
  currencyMinorUnitExponent,
  knownCurrencyOrNull,
} from "../../../../src/mcp-server/tools/utils/iso-4217.js";

/**
 * Verbatim copy of `ISO_4217_NON_DEFAULT_EXPONENTS` in the governance layer:
 *
 *   repo:   cesteral/cesteral-governance-layer
 *   file:   lib/features/governance/budget-magnitude.ts
 *   blob:   a67ab61603eeaa53a6241f36e4f386d11306742f (origin/main 03e421810, 2026-10-20)
 *
 * Every other recognised ISO 4217 code has exponent 2. This copy is the pin:
 * when the governance table changes, this test must change in the same
 * release, and the two tables stay equal by being edited together.
 */
const GOVERNANCE_ISO_4217_NON_DEFAULT_EXPONENTS = {
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
} as const;

describe("ISO 4217 minor-unit exponents", () => {
  it("is equal to the governance layer's table", () => {
    expect({ ...ISO_4217_NON_DEFAULT_EXPONENTS }).toEqual(
      GOVERNANCE_ISO_4217_NON_DEFAULT_EXPONENTS
    );
  });

  it("gives the exponents the governance layer reads back", () => {
    expect(currencyMinorUnitExponent("USD")).toBe(2);
    expect(currencyMinorUnitExponent("EUR")).toBe(2);
    expect(currencyMinorUnitExponent("JPY")).toBe(0);
    expect(currencyMinorUnitExponent("KRW")).toBe(0);
    expect(currencyMinorUnitExponent("KWD")).toBe(3);
    expect(currencyMinorUnitExponent("IQD")).toBe(3);
    expect(currencyMinorUnitExponent("CLF")).toBe(4);
  });

  it("is ISO 4217, not the CLDR display digits Intl reports", () => {
    // RSD, ALL, MGA, YER, ... are exponent 2 in ISO 4217; CLDR displays them
    // with 0 fraction digits, and IQD with 0 where ISO says 3. These are the
    // codes where the old `Intl`-based exponent disagreed with the consumer.
    for (const code of ["AFN", "ALL", "IRR", "KPW", "LAK", "LBP", "MGA", "MMK", "RSD", "SLL"]) {
      expect(currencyMinorUnitExponent(code), code).toBe(2);
    }
    for (const code of ["SOS", "SYP", "YER"]) {
      expect(currencyMinorUnitExponent(code), code).toBe(2);
    }
  });

  it("treats a code it does not know as unresolved, never as a default", () => {
    // XXX is the ISO 4217 "no currency" code the snapshot uses for unresolved.
    for (const code of ["XXX", "ZZZ", "usd", " USD", "US", "USDD", "", null, undefined]) {
      expect(currencyMinorUnitExponent(code as string | null | undefined), String(code)).toBeNull();
      expect(knownCurrencyOrNull(code as string | null | undefined), String(code)).toBeNull();
    }
  });

  it("returns a known code unchanged", () => {
    expect(knownCurrencyOrNull("RSD")).toBe("RSD");
    expect(knownCurrencyOrNull("JPY")).toBe("JPY");
  });
});
