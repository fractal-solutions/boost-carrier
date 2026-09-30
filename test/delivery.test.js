import { expect, test } from "bun:test";
import { formatUberAddress } from "../delivery.ts";

test("serializes structured addresses in the format expected by Uber Direct", () => {
  expect(formatUberAddress({
    street_address: ["42 Market Road"],
    city: "Nairobi",
    country: "KE",
  })).toBe('{"street_address":["42 Market Road"],"city":"Nairobi","country":"KE"}');
});

test("preserves address strings already formatted for Uber Direct", () => {
  const address = '{"street_address":["42 Market Road"],"city":"Nairobi"}';
  expect(formatUberAddress(address)).toBe(address);
});