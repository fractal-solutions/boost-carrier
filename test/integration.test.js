import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

// End-to-end test: drives the real boost-carrier server against the
// uber-delivery-mock-api. Both are spawned as child processes on dedicated
// ports so this can run alongside the development servers.
//
//   bun test test/integration.test.js
//
// Override the mock location with MOCK_API_DIR and the interpreter with PYTHON.

const boostDir = path.resolve(import.meta.dir, "..");
const mockDir = process.env.MOCK_API_DIR || path.resolve(import.meta.dir, "..", "..", "uber-delivery-mock-api");
const python = process.env.PYTHON || "python";

// Skip the whole suite when the mock API has not been cloned next to this repo
// (see the "Interactive Demo" section of the README for setup).
const mockAvailable = existsSync(path.join(mockDir, "run.py"));

const MOCK_PORT = 3100;
const SERVICE_PORT = 5100;
const RECEIVER_PORT = 9199;

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const CUSTOMER_ID = "PENDING_MERCHANT_ID_PLACEHOLDER";
const SIGNING_KEY = "integration-webhook-signing-key";

const mockBase = `http://127.0.0.1:${MOCK_PORT}`;
const serviceBase = `http://127.0.0.1:${SERVICE_PORT}`;
const receiverBase = `http://127.0.0.1:${RECEIVER_PORT}`;
const apiBase = `${serviceBase}/v1/customers/${CUSTOMER_ID}`;

const pickup = { street_address: ["123 Store Road"], city: "Nairobi", country: "KE" };
const dropoff = { street_address: ["42 Customer Lane"], city: "Nairobi", country: "KE" };

let receiver;
let mockProcess;
let serviceProcess;
let deliveryId;

const mockLog = { text: "" };
const serviceLog = { text: "" };
const received = [];

function drain(stream, sink) {
  (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        sink.text = (sink.text + decoder.decode(chunk, { stream: true })).slice(-8000);
      }
    } catch {
      // stream closed on shutdown
    }
  })();
}

async function waitFor(url, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(200);
  }
  throw new Error(
    `Timed out waiting for ${label} at ${url}: ${lastError ?? "no successful response"}\n` +
      `--- mock log ---\n${mockLog.text}\n--- boost-carrier log ---\n${serviceLog.text}`,
  );
}

beforeAll(async () => {
  if (!mockAvailable) return;
  receiver = Bun.serve({
    port: RECEIVER_PORT,
    async fetch(request) {
      const body = await request.text();
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        // ignore non-JSON bodies
      }
      received.push({ headers: Object.fromEntries(request.headers), body, json });
      return Response.json({ ok: true });
    },
  });

  mockProcess = Bun.spawn([python, "run.py"], {
    cwd: mockDir,
    env: {
      ...process.env,
      PORT: String(MOCK_PORT),
      CLIENT_ID,
      CLIENT_SECRET,
      WEBHOOK_URL: `${serviceBase}/webhook/uber`,
      UBER_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
      PENDING_MS: "600",
      PICKUP_MS: "600",
      PICKUP_COMPLETE_MS: "600",
      DROPOFF_MS: "600",
      WEBHOOK_INTERVAL_MS: "60000",
      COURIER_UPDATE_INTERVAL_MS: "60000",
      MIN_FEE: "5",
      MAX_FEE: "5",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  drain(mockProcess.stdout, mockLog);
  drain(mockProcess.stderr, mockLog);

  serviceProcess = Bun.spawn(["bun", "server.ts"], {
    cwd: boostDir,
    env: {
      ...process.env,
      PORT: String(SERVICE_PORT),
      UBER_API_BASE_URL: mockBase,
      UBER_TOKEN_URL: `${mockBase}/oauth/v2/token`,
      UBER_CLIENT_ID: CLIENT_ID,
      UBER_CLIENT_SECRET: CLIENT_SECRET,
      UBER_CUSTOMER_ID: CUSTOMER_ID,
      ADDRESS_VALIDATION_ENABLED: "false",
      UBER_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
      DELIVERY_WEBHOOK_FORWARD_URL: `${receiverBase}/uber-events`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  drain(serviceProcess.stdout, serviceLog);
  drain(serviceProcess.stderr, serviceLog);

  await waitFor(`${mockBase}/`, "mock API");
  await waitFor(`${serviceBase}/health`, "boost-carrier");
}, 30000);

afterAll(() => {
  mockProcess?.kill();
  serviceProcess?.kill();
  receiver?.stop(true);
});

test.skipIf(!mockAvailable)("mock API mimics Uber's OAuth token endpoint", async () => {
  const response = await fetch(`${mockBase}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: "eats.deliveries direct.organizations",
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.access_token).toBeTruthy();
  expect(body.expires_in).toBeGreaterThan(0);
});

test.skipIf(!mockAvailable)("mock API rejects invalid OAuth credentials", async () => {
  const response = await fetch(`${mockBase}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "wrong", client_secret: "wrong" }),
  });
  expect(response.status).toBe(401);
});

test.skipIf(!mockAvailable)("boost-carrier reports healthy", async () => {
  const response = await fetch(`${serviceBase}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test.skipIf(!mockAvailable)("boost-carrier rejects an unknown customer id", async () => {
  const response = await fetch(`${serviceBase}/v1/customers/someone-else/delivery_quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pickup_address: pickup, dropoff_address: dropoff }),
  });
  expect(response.status).toBe(404);
});

test.skipIf(!mockAvailable)("full quote -> book -> status flow through the mock", async () => {
  const quoteResponse = await fetch(`${apiBase}/delivery_quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pickup_address: pickup,
      dropoff_address: dropoff,
      pickup_latitude: -1.2864,
      pickup_longitude: 36.8172,
    }),
  });
  expect(quoteResponse.status).toBe(201);
  const quote = await quoteResponse.json();
  expect(quote.quote_id).toBeTruthy();
  expect(typeof quote.estimated_fee).toBe("number");

  const deliveryResponse = await fetch(`${apiBase}/deliveries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quote_id: quote.quote_id,
      pickup_address: pickup,
      dropoff_address: dropoff,
      pickup_name: "Example Store",
      pickup_phone_number: "+254700000000",
      dropoff_name: "Customer Name",
      dropoff_phone_number: "+254711111111",
      manifest_reference: "ORDER-1001",
      external_id: "ORDER-1001",
      idempotency_key: "ORDER-1001",
      manifest_total_value_cents: 250000,
      deliverable_action: "deliverable_action_meet_at_door",
      undeliverable_action: "return",
      manifest_items: [{ name: "Example product", quantity: 1, size: "medium", price: 250000, must_be_upright: false, weight: 500 }],
    }),
  });
  expect(deliveryResponse.status).toBe(201);
  const delivery = await deliveryResponse.json();
  expect(delivery.id).toBeTruthy();
  expect(delivery.tracking_url).toContain("http");
  expect(delivery.status).toBe("pending");
  deliveryId = delivery.id;

  const statusResponse = await fetch(`${apiBase}/deliveries/${delivery.id}`);
  expect(statusResponse.status).toBe(200);
  const status = await statusResponse.json();
  expect(status.id).toBe(delivery.id);
  expect(status.status).toBeTruthy();
});

test.skipIf(!mockAvailable)("mock-signed webhook is verified and forwarded by boost-carrier", async () => {
  expect(deliveryId).toBeTruthy();

  const deadline = Date.now() + 15000;
  let captured;
  while (Date.now() < deadline && !captured) {
    captured = received.find((entry) => entry.json?.delivery_id === deliveryId);
    if (!captured) await Bun.sleep(200);
  }

  expect(captured).toBeTruthy();
  expect(captured.json.kind).toBe("event.delivery_status");
  expect(captured.headers["x-uber-signature"]).toMatch(/^[a-f\d]{64}$/i);

  const expected = createHmac("sha256", SIGNING_KEY).update(captured.body, "utf8").digest("hex");
  expect(captured.headers["x-uber-signature"]).toBe(expected);
});
