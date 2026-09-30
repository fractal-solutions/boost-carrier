import { afterEach, expect, test } from "bun:test";
import { validateDropoffAddress } from "../address_validation.ts";

const originalFetch = globalThis.fetch;
const originalEnabled = process.env.ADDRESS_VALIDATION_ENABLED;
const originalBaseUrl = process.env.ADDRESS_VALIDATION_BASE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnabled === undefined) delete process.env.ADDRESS_VALIDATION_ENABLED;
  else process.env.ADDRESS_VALIDATION_ENABLED = originalEnabled;
  if (originalBaseUrl === undefined) delete process.env.ADDRESS_VALIDATION_BASE_URL;
  else process.env.ADDRESS_VALIDATION_BASE_URL = originalBaseUrl;
});

test("disabled validation does not call the geocoder", async () => {
  process.env.ADDRESS_VALIDATION_ENABLED = "false";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("[]");
  };

  await validateDropoffAddress({ street_address: ["42 Market Road"], city: "Nairobi" });
  expect(called).toBe(false);
});

test("enabled validation accepts a street-level result matching the house number", async () => {
  process.env.ADDRESS_VALIDATION_ENABLED = "true";
  delete process.env.ADDRESS_VALIDATION_BASE_URL;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://photon.komoot.io");
    expect(url.pathname).toBe("/api");
    expect(url.searchParams.get("q")).toBe("42 Market Road, Nairobi");
    return Response.json({ features: [{
      geometry: { coordinates: [36.8172, -1.2864] },
      properties: { street: "Market Road", housenumber: "42" },
    }] });
  };

  await expect(validateDropoffAddress({
    street_address: ["42 Market Road"],
    city: "Nairobi",
  })).resolves.toBeUndefined();
});

test("enabled validation rejects results without an exact street number", async () => {
  process.env.ADDRESS_VALIDATION_ENABLED = "true";
  process.env.ADDRESS_VALIDATION_BASE_URL = "http://geocoder.test";
  globalThis.fetch = async () => Response.json({ features: [{
    geometry: { coordinates: [36.8172, -1.2864] },
    properties: { street: "Market Road", housenumber: "40" },
  }] });

  await expect(validateDropoffAddress({
    street_address: ["42 Market Road"],
    city: "Nairobi",
  })).rejects.toMatchObject({ status: 422 });
});

test("enabled validation rejects a different mapped street", async () => {
  process.env.ADDRESS_VALIDATION_ENABLED = "true";
  process.env.ADDRESS_VALIDATION_BASE_URL = "http://geocoder.test";
  globalThis.fetch = async () => Response.json({ features: [{
    geometry: { coordinates: [36.8172, -1.2864] },
    properties: { street: "Market Avenue", housenumber: "42" },
  }] });

  await expect(validateDropoffAddress({
    street_address: ["42 Market Road"],
    city: "Nairobi",
  })).rejects.toMatchObject({ status: 422 });
});