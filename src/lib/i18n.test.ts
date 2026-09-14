import { describe, expect, it } from "vitest";
import { dictionaries } from "@/lib/i18n";

// Session 20 — guards against a future session shipping an English-only
// string: every key that exists in the "en" dictionary must also exist in
// "sw" (and vice versa), so the language toggle never silently falls back
// to English for a page that's supposed to be translated.
describe("i18n dictionary completeness", () => {
  const enKeys = Object.keys(dictionaries.en);
  const swKeys = Object.keys(dictionaries.sw);

  it("has at least one key", () => {
    expect(enKeys.length).toBeGreaterThan(0);
  });

  it("every English key has a corresponding Swahili key", () => {
    const swSet = new Set(swKeys);
    const missing = enKeys.filter((key) => !swSet.has(key));
    expect(missing).toEqual([]);
  });

  it("every Swahili key has a corresponding English key", () => {
    const enSet = new Set(enKeys);
    const extra = swKeys.filter((key) => !enSet.has(key));
    expect(extra).toEqual([]);
  });

  it("has no blank translation values in either language", () => {
    const blankEn = enKeys.filter((key) => !dictionaries.en[key as keyof typeof dictionaries.en]?.trim());
    const blankSw = swKeys.filter((key) => !dictionaries.sw[key as keyof typeof dictionaries.sw]?.trim());
    expect(blankEn).toEqual([]);
    expect(blankSw).toEqual([]);
  });

  it("has no Swahili value that is just a byte-for-byte copy of its English value", () => {
    // A handful of short brand/technical terms are legitimately identical
    // across languages (e.g. a literal product/network name) — this checks
    // for accidental untranslated copy-paste, not every possible false
    // positive, so it only flags values long enough to be real sentences.
    const untranslated = enKeys.filter((key) => {
      const en = dictionaries.en[key as keyof typeof dictionaries.en];
      const sw = dictionaries.sw[key as keyof typeof dictionaries.sw];
      return en.length > 12 && en === sw;
    });
    expect(untranslated).toEqual([]);
  });
});
