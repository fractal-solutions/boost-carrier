import { afterAll, expect, test } from "bun:test";

process.env.PORT = "0";
const { server } = await import("../server.ts");

afterAll(() => server.stop(true));

test("health endpoint responds without Uber credentials", async () => {
  const response = await fetch(new URL("health", server.url));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("quote endpoint rejects missing address data before contacting Uber", async () => {
  const response = await fetch(
    new URL("v1/customers/PENDING_MERCHANT_ID_PLACEHOLDER/delivery_quotes", server.url),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "pickup_address and dropoff_address are required.",
  });
});

test("quote endpoint rejects an unverified drop-off before contacting Uber", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnabled = process.env.ADDRESS_VALIDATION_ENABLED;
  const originalBaseUrl = process.env.ADDRESS_VALIDATION_BASE_URL;
  let requestCount = 0;
  process.env.ADDRESS_VALIDATION_ENABLED = "true";
  process.env.ADDRESS_VALIDATION_BASE_URL = "http://geocoder.test";
  globalThis.fetch = async (input, init) => {
    const hostname = new URL(input).hostname;
    if (hostname !== "localhost") {
      requestCount += 1;
      if (hostname !== "geocoder.test") throw new Error("Unexpected external request");
      return Response.json([]);
    }
    return originalFetch(input, init);
  };

  try {
    const response = await fetch(
      new URL("v1/customers/PENDING_MERCHANT_ID_PLACEHOLDER/delivery_quotes", server.url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pickup_address: { street_address: ["123 Store Road"], city: "Nairobi" },
          dropoff_address: { street_address: ["42 Unknown Road"], city: "Nairobi" },
        }),
      },
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("could not be matched");
    expect(requestCount).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnabled === undefined) delete process.env.ADDRESS_VALIDATION_ENABLED;
    else process.env.ADDRESS_VALIDATION_ENABLED = originalEnabled;
    if (originalBaseUrl === undefined) delete process.env.ADDRESS_VALIDATION_BASE_URL;
    else process.env.ADDRESS_VALIDATION_BASE_URL = originalBaseUrl;
  }
});