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