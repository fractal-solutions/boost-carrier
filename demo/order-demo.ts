#!/usr/bin/env bun
// Interactive end-to-end order demo.
//
//   bun demo/order-demo.ts          # interactive menu
//   bun demo/order-demo.ts --auto   # run one full order then exit
//
// Spawns its own fast-timing uber-delivery-mock-api + boost-carrier + webhook
// receiver on dedicated ports, then drives a real order through them.

import path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const AUTO = process.argv.includes("--auto");

const boostDir = path.resolve(import.meta.dir, "..");
const mockDir = process.env.MOCK_API_DIR || path.resolve(import.meta.dir, "..", "..", "uber-delivery-mock-api");
const python = process.env.PYTHON || "python";

const MOCK_PORT = 3200;
const SERVICE_PORT = 5200;
const RECEIVER_PORT = 9299;

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const CUSTOMER_ID = "PENDING_MERCHANT_ID_PLACEHOLDER";
const SIGNING_KEY = "demo-webhook-signing-key";

const mockBase = `http://127.0.0.1:${MOCK_PORT}`;
const serviceBase = `http://127.0.0.1:${SERVICE_PORT}`;
const receiverBase = `http://127.0.0.1:${RECEIVER_PORT}`;
const apiBase = `${serviceBase}/v1/customers/${CUSTOMER_ID}`;

const tty = Boolean(process.stdout.isTTY);
const paint = (code: string) => (s: string) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = paint("1");
const dim = paint("2");
const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const blue = paint("34");
const magenta = paint("35");
const cyan = paint("36");

const pickup = { street_address: ["123 Store Road"], city: "Nairobi", country: "KE" };
const dropoff = { street_address: ["42 Customer Lane"], city: "Nairobi", country: "KE" };

let receiver: ReturnType<typeof Bun.serve> | undefined;
let mockProcess: ReturnType<typeof Bun.spawn> | undefined;
let serviceProcess: ReturnType<typeof Bun.spawn> | undefined;
let lastDeliveryId: string | undefined;

const events: Array<{ headers: Record<string, string>; body: string; json: any }> = [];
let eventCursor = 0;

function banner(title: string): void {
  const line = "─".repeat(title.length + 2);
  console.log(`\n${cyan(`┌${line}┐`)}`);
  console.log(`${cyan("│")} ${bold(title)} ${cyan("│")}`);
  console.log(`${cyan(`└${line}┘`)}`);
}

function step(n: number, label: string): void {
  console.log(`\n${blue(`[${n}]`)} ${bold(label)}`);
}

function kv(key: string, value: string): void {
  console.log(`    ${dim(key.padEnd(16))} ${value}`);
}

function printStatus(status: string, elapsedMs: number): void {
  const icon: Record<string, string> = {
    pending: "⏳",
    pickup: "🚚",
    pickup_complete: "📦",
    dropoff: "🏁",
    delivered: "✅",
    canceled: "❌",
  };
  console.log(`    ${green("→")} ${icon[status] ?? "•"} ${bold(status)} ${dim(`(+${(elapsedMs / 1000).toFixed(1)}s)`)}`);
}

function printWebhook(event: (typeof events)[number]): void {
  const kind = event.json?.kind ?? "unknown";
  const status = event.json?.data?.status ?? "-";
  const signature = event.headers["x-uber-signature"];
  const signed = signature ? green("signed") : red("unsigned");
  console.log(`    ${magenta("webhook")} ${kind.padEnd(22)} status=${String(status).padEnd(16)} ${signed}`);
}

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!tty) return fn();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${cyan(frames[i++ % frames.length])} ${label}`);
  }, 80);
  try {
    const result = await fn();
    clearInterval(timer);
    process.stdout.write(`\r${green("✓")} ${label}\n`);
    return result;
  } catch (error) {
    clearInterval(timer);
    process.stdout.write(`\r${red("✗")} ${label}\n`);
    throw error;
  }
}

async function waitFor(url: string, label: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${label} (${url})`);
}

async function startServices(): Promise<void> {
  receiver = Bun.serve({
    port: RECEIVER_PORT,
    async fetch(request) {
      const body = await request.text();
      let json: any = null;
      try {
        json = JSON.parse(body);
      } catch {
        // ignore
      }
      events.push({ headers: Object.fromEntries(request.headers), body, json });
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
      PENDING_MS: "1500",
      PICKUP_MS: "1500",
      PICKUP_COMPLETE_MS: "2000",
      DROPOFF_MS: "2500",
      WEBHOOK_INTERVAL_MS: "2500",
      COURIER_UPDATE_INTERVAL_MS: "1200",
      MIN_FEE: "120",
      MAX_FEE: "480",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

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
    stdout: "ignore",
    stderr: "ignore",
  });

  await withSpinner("starting mock Uber API and boost-carrier...", async () => {
    await waitFor(`${mockBase}/`, "mock API");
    await waitFor(`${serviceBase}/health`, "boost-carrier");
  });

  console.log(`    ${dim("mock")}      ${mockBase}`);
  console.log(`    ${dim("boost")}     ${serviceBase}`);
  console.log(`    ${dim("receiver")}  ${receiverBase}`);
}

async function watchDelivery(deliveryId: string): Promise<void> {
  const start = Date.now();
  let lastStatus: string | null = null;

  while (true) {
    while (eventCursor < events.length) printWebhook(events[eventCursor++]);

    try {
      const response = await fetch(`${apiBase}/deliveries/${deliveryId}`);
      if (response.ok) {
        const delivery = await response.json();
        if (delivery.status !== lastStatus) {
          printStatus(delivery.status, Date.now() - start);
          lastStatus = delivery.status;
        }
        if (delivery.status === "delivered" || delivery.status === "canceled") break;
      }
    } catch {
      // keep polling
    }

    if (Date.now() - start > 30000) {
      console.log(`    ${yellow("watch timed out")}`);
      break;
    }
    await Bun.sleep(300);
  }

  while (eventCursor < events.length) printWebhook(events[eventCursor++]);
}

async function placeOrder(): Promise<void> {
  step(1, "Health check");
  const health = await (await fetch(`${serviceBase}/health`)).json();
  kv("boost-carrier", green(health.status));

  step(2, "Request delivery quote");
  kv("pickup", `${pickup.street_address[0]}, ${pickup.city}`);
  kv("dropoff", `${dropoff.street_address[0]}, ${dropoff.city}`);
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
  if (quoteResponse.status !== 201) throw new Error(`quote failed: HTTP ${quoteResponse.status}`);
  const quote = await quoteResponse.json();
  kv("quote id", bold(quote.quote_id));
  kv("estimated fee", `${green(`KES ${quote.estimated_fee}`)}`);
  kv("duration", `${quote.duration}s`);

  step(3, "Book the courier");
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
      idempotency_key: `ORDER-${Date.now()}`,
      manifest_total_value_cents: 250000,
      deliverable_action: "deliverable_action_meet_at_door",
      undeliverable_action: "return",
      manifest_items: [{ name: "Example product", quantity: 1, size: "medium", price: 250000, must_be_upright: false, weight: 500 }],
    }),
  });
  if (deliveryResponse.status !== 201) throw new Error(`booking failed: HTTP ${deliveryResponse.status}`);
  const delivery = await deliveryResponse.json();
  lastDeliveryId = delivery.id;
  kv("delivery id", bold(delivery.id));
  kv("tracking url", cyan(delivery.tracking_url));
  kv("status", delivery.status);

  step(4, "Live tracking — status changes and Uber webhooks");
  await watchDelivery(delivery.id);

  step(5, "Order complete");
  kv("delivery id", delivery.id);
  kv("webhooks seen", String(events.length));
}

async function requestQuoteOnly(): Promise<void> {
  const response = await fetch(`${apiBase}/delivery_quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pickup_address: pickup, dropoff_address: dropoff }),
  });
  const quote = await response.json();
  banner("Quote");
  kv("status", String(response.status));
  kv("quote id", quote.quote_id ?? quote.id);
  kv("estimated fee", `KES ${quote.estimated_fee ?? quote.fee}`);
}

async function lookupDelivery(): Promise<string> {
  const answer = await prompt(`Delivery id${lastDeliveryId ? ` [${lastDeliveryId}]` : ""}: `);
  const id = answer.trim() || lastDeliveryId;
  if (!id) {
    console.log(`    ${yellow("no delivery id")}`);
    return "";
  }
  const response = await fetch(`${apiBase}/deliveries/${id}`);
  if (!response.ok) {
    console.log(`    ${red(`HTTP ${response.status}`)}`);
    return "";
  }
  const delivery = await response.json();
  banner("Delivery");
  kv("id", delivery.id);
  kv("status", delivery.status);
  kv("fee", `KES ${delivery.fee}`);
  kv("tracking url", delivery.tracking_url);
  return delivery.id;
}

async function sendTestWebhook(): Promise<void> {
  const { createHmac } = await import("node:crypto");
  const payload = JSON.stringify({
    delivery_id: lastDeliveryId ?? "TEST-DELIVERY-ID",
    kind: "event.delivery_status",
    data: { status: "dropoff", courier_imminent: true },
  });
  const signature = createHmac("sha256", SIGNING_KEY).update(payload, "utf8").digest("hex");
  const before = events.length;
  const response = await fetch(`${serviceBase}/webhook/uber`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Uber-Signature": signature },
    body: payload,
  });
  await Bun.sleep(150);
  banner("Test webhook");
  kv("boost response", `${response.status} ${(await response.json()).status}`);
  kv("forwarded", events.length > before ? green("yes") : red("no"));
}

let rl: readline.Interface | undefined;
async function prompt(question: string): Promise<string> {
  rl ??= readline.createInterface({ input, output });
  return rl.question(`${bold(question)}`);
}

async function menu(): Promise<void> {
  while (true) {
    banner("Uber Delivery — order demo");
    console.log(`  ${bold("1")}) Place a live order (end-to-end)`);
    console.log(`  ${bold("2")}) Request a quote only`);
    console.log(`  ${bold("3")}) Look up a delivery by id`);
    console.log(`  ${bold("4")}) Send a signed test webhook`);
    console.log(`  ${bold("0")}) Exit`);

    let choice: string;
    try {
      choice = (await prompt("Choose: ")).trim();
    } catch {
      break; // stdin closed (e.g. piped input reached EOF)
    }
    if (choice === "0" || choice === "q") break;

    try {
      if (choice === "1") await placeOrder();
      else if (choice === "2") await requestQuoteOnly();
      else if (choice === "3") await lookupDelivery();
      else if (choice === "4") await sendTestWebhook();
      else console.log(`    ${yellow("unknown choice")}`);
    } catch (error) {
      console.log(`    ${red(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  receiver?.stop(true);
  mockProcess?.kill();
  serviceProcess?.kill();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

try {
  console.log(cyan("\nUber Delivery — end-to-end demo"));
  await startServices();
  if (AUTO) {
    await placeOrder();
  } else {
    await menu();
  }
} finally {
  rl?.close();
  shutdown();
  console.log(`\n${dim("services stopped. bye.")}\n`);
}
