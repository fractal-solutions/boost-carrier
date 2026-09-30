import { afterAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

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

test("Uber webhook verifies the signature and forwards the unchanged event", async () => {
  const originalFetch = globalThis.fetch;
  const originalSigningKey = process.env.UBER_WEBHOOK_SIGNING_KEY;
  const originalForwardUrl = process.env.DELIVERY_WEBHOOK_FORWARD_URL;
  const signingKey = "test-webhook-signing-key";
  const rawBody = '{"kind":"event.courier_update","delivery_id":"delivery-1","data":{"status":"pickup"}}';
  const signature = createHmac("sha256", signingKey).update(rawBody, "utf8").digest("hex");
  let forwardedBody;
  process.env.UBER_WEBHOOK_SIGNING_KEY = signingKey;
  process.env.DELIVERY_WEBHOOK_FORWARD_URL = "https://consumer.test/uber-events";
  globalThis.fetch = async (input, init) => {
    if (new URL(input).hostname === "localhost") return originalFetch(input, init);
    expect(new URL(input).href).toBe("https://consumer.test/uber-events");
    forwardedBody = init.body;
    expect(init.headers["X-Uber-Signature"]).toBe(signature);
    return new Response(null, { status: 204 });
  };

  try {
    const response = await fetch(new URL("webhook/uber", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Uber-Signature": signature },
      body: rawBody,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "forwarded" });
    expect(forwardedBody).toBe(rawBody);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSigningKey === undefined) delete process.env.UBER_WEBHOOK_SIGNING_KEY;
    else process.env.UBER_WEBHOOK_SIGNING_KEY = originalSigningKey;
    if (originalForwardUrl === undefined) delete process.env.DELIVERY_WEBHOOK_FORWARD_URL;
    else process.env.DELIVERY_WEBHOOK_FORWARD_URL = originalForwardUrl;
  }
});

test("Uber webhook rejects an invalid signature without forwarding", async () => {
  const originalFetch = globalThis.fetch;
  const originalSigningKey = process.env.UBER_WEBHOOK_SIGNING_KEY;
  const originalForwardUrl = process.env.DELIVERY_WEBHOOK_FORWARD_URL;
  process.env.UBER_WEBHOOK_SIGNING_KEY = "test-webhook-signing-key";
  process.env.DELIVERY_WEBHOOK_FORWARD_URL = "https://consumer.test/uber-events";
  globalThis.fetch = async (input, init) => {
    if (new URL(input).hostname === "localhost") return originalFetch(input, init);
    throw new Error("Invalid signatures must not be forwarded");
  };

  try {
    const response = await fetch(new URL("webhook/uber", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Uber-Signature": "invalid" },
      body: JSON.stringify({ kind: "event.delivery_status" }),
    });

    expect(response.status).toBe(401);
    expect((await response.json()).error).toContain("signature");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSigningKey === undefined) delete process.env.UBER_WEBHOOK_SIGNING_KEY;
    else process.env.UBER_WEBHOOK_SIGNING_KEY = originalSigningKey;
    if (originalForwardUrl === undefined) delete process.env.DELIVERY_WEBHOOK_FORWARD_URL;
    else process.env.DELIVERY_WEBHOOK_FORWARD_URL = originalForwardUrl;
  }
});

test("Uber webhook returns a retryable error when the ecommerce callback fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalSigningKey = process.env.UBER_WEBHOOK_SIGNING_KEY;
  const originalForwardUrl = process.env.DELIVERY_WEBHOOK_FORWARD_URL;
  const signingKey = "test-webhook-signing-key";
  const rawBody = '{"kind":"event.delivery_status","delivery_id":"delivery-1"}';
  const signature = createHmac("sha256", signingKey).update(rawBody, "utf8").digest("hex");
  process.env.UBER_WEBHOOK_SIGNING_KEY = signingKey;
  process.env.DELIVERY_WEBHOOK_FORWARD_URL = "https://consumer.test/uber-events";
  globalThis.fetch = async (input, init) => {
    if (new URL(input).hostname === "localhost") return originalFetch(input, init);
    return new Response("temporary failure", { status: 503 });
  };

  try {
    const response = await fetch(new URL("webhook/uber", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Uber-Signature": signature },
      body: rawBody,
    });

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("returned HTTP 503");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSigningKey === undefined) delete process.env.UBER_WEBHOOK_SIGNING_KEY;
    else process.env.UBER_WEBHOOK_SIGNING_KEY = originalSigningKey;
    if (originalForwardUrl === undefined) delete process.env.DELIVERY_WEBHOOK_FORWARD_URL;
    else process.env.DELIVERY_WEBHOOK_FORWARD_URL = originalForwardUrl;
  }
});