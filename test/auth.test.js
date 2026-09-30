import { expect, test } from "bun:test";
import { getAccessToken } from "../auth.ts";

test("shares a single form-encoded OAuth request between concurrent callers", async () => {
  process.env.UBER_CLIENT_ID = "test-client";
  process.env.UBER_CLIENT_SECRET = "test-secret";
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async (_input, init) => {
    calls += 1;
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(String(init?.body)).toContain("grant_type=client_credentials");
    expect(String(init?.body)).toContain("scope=eats.deliveries+direct.organizations");
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ access_token: "cached-test-token", expires_in: 3600 });
  };

  try {
    const tokens = await Promise.all([getAccessToken(), getAccessToken()]);
    expect(tokens).toEqual(["cached-test-token", "cached-test-token"]);
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.UBER_CLIENT_ID;
    delete process.env.UBER_CLIENT_SECRET;
  }
});