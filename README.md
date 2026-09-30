# Uber Delivery Connection

This service connects your online store to Uber Direct. It can check a delivery address, ask Uber for a price, book a courier, look up the delivery later, and pass Uber's automatic updates to your store.

It is a small backend service, not a checkout page or order-management system. It does not save your orders or delivery history. Your store still needs to save the IDs and delivery updates it receives.

### Three Useful Terms

- **Quote:** Uber's estimated delivery price and a check that it can serve the route. No courier is booked yet.
- **Book a delivery:** Place the actual courier order with Uber. This may incur a delivery charge.
- **Webhook:** An automatic message Uber sends when something changes, such as delivery status or courier location. This service checks that the message came from Uber and forwards it to your store.

## Before You Start

You need Bun installed, an Uber Direct account with API access approved, and your store's backend to receive delivery updates. The approval matters: this project previously received an Uber `401 unauthorized_client` response. In plain English, Uber had not authorized the app to use its API. Real quotes and bookings will not work until Uber approves the app and provides working credentials.

This service does not save your orders, quote IDs, delivery IDs, or delivery history. Save the quote and delivery IDs in your store's order record. To get automatic updates, configure the webhook as described below and give this service the URL of your store's update endpoint. Your store must save and apply each update.

### Selecting Accurate Pickup and Drop-off Locations

Your checkout page must collect the pickup and drop-off addresses and send them to this service. This service does not show a map or address picker.

Before asking Uber for a price, the service checks the drop-off address against Photon, a public map search service. This is on by default and does not need an API key. It checks that the street, and house number when supplied, appear on the map. Uber then separately checks whether it can deliver on that route. A map match does not guarantee Uber can serve the address.

Photon's public service is free for reasonable use, but it can be busy, throttle requests, or be unavailable. One address lookup is made for each quote, and the full drop-off address is sent to Photon. If Photon is unavailable, the service stops and returns an error instead of sending the quote request to Uber. Set `ADDRESS_VALIDATION_ENABLED=false` to skip the map check. `ADDRESS_VALIDATION_COUNTRY_CODES=ke` can limit searches to Kenya, for example. The optional `ADDRESS_VALIDATION_BASE_URL` setting is only needed if you host your own compatible map search service; you do not need to fill it in for the default setup.

#### Checkout Address Picker Setup

If you want suggestions as a customer types, add an address picker to your checkout. That is a separate part of your store; it is not included in this backend. Whatever picker you use, still send the chosen address here for a quote.

1. Limit suggestions to the countries and areas where you deliver. Showing nearby suggestions does not prove Uber can deliver there.
2. Ask the customer to choose a suggestion or confirm a map pin. Typing an address alone does not prove it is correct.
3. Save the chosen address and coordinates in your store. Collect apartment, floor, gate, and delivery instructions separately.
4. Choose the pickup address from your own approved store or warehouse list. The customer should not have to enter it.
5. Ask this service for a quote. Show Uber delivery only if the request succeeds. If it fails, ask the customer to correct the address or choose another delivery option.
6. Use the same pickup and drop-off addresses when booking. Save the quote ID and delivery ID with the order.

Example normalized address object sent to this service:

```json
{
	"street_address": ["42 Customer Lane", "Apartment 5B"],
	"city": "Nairobi",
	"state": "Nairobi County",
	"zip_code": "00100",
	"country": "KE"
}
```

The fields describe a street address that this service sends to Uber. Pickup coordinates are also accepted in quote requests. Drop-off coordinates are not currently sent in a verified Uber format, so this service checks the drop-off text address instead. Address suggestions help customers choose correctly; the quote result tells you whether Uber can serve the route.

The quote, booking, and status routes do not have a login or traffic limit built in. Put them behind your store's login/security controls before making them public. The webhook is different: it checks a secret signature from Uber. This service forwards webhook messages but does not save them. Cancelling deliveries, changing delivery details, and refunds are not supported here.

**Uber access may need setup first.** A previous connection attempt returned `401 unauthorized_client`, which means Uber did not accept the app credentials. Ask Uber to approve API access for your account and confirm the credentials and permissions they provide. Adding the customer ID alone will not fix this login error.

## Configuration

Bun reads settings from a local `.env` file when the service starts. Keep that file private; it contains your Uber password-like keys and webhook secret. Do not commit it. Start from `.env.example` and fill in the required values.

| Variable | Purpose | Default |
| --- | --- | --- |
| Setting | What it means | What to enter |
| --- | --- | --- |
| `UBER_CLIENT_ID` | Your app's ID from Uber | Required |
| `UBER_CLIENT_SECRET` | Your app's private key from Uber | Required; keep secret |
| `UBER_CUSTOMER_ID` | Your Uber Direct account/customer ID | Replace the placeholder with the ID Uber gives you |
| `UBER_API_BASE_URL` | Which Uber environment to call | Sandbox by default; use production only when approved |
| `PORT` | Port this service listens on | `3000` by default |
| `UBER_WEBHOOK_SIGNING_KEY` | Secret Uber uses to sign webhook messages | Copy from the webhook you create in the Uber Direct dashboard |
| `DELIVERY_WEBHOOK_FORWARD_URL` | Your store's endpoint for receiving delivery updates | Required for forwarding updates |
| `ADDRESS_VALIDATION_ENABLED` | Check drop-off addresses against the map before asking Uber for a quote | `true` by default; set to `false` to turn off |
| `ADDRESS_VALIDATION_BASE_URL` | Optional replacement for the default map search service | Leave empty for the default Photon service |
| `ADDRESS_VALIDATION_USER_AGENT` | Name sent with map searches | `boost-carrier/1.0` by default |
| `ADDRESS_VALIDATION_COUNTRY_CODES` | Limit address checks to certain countries | Optional; use two-letter country codes such as `ke` |

Use the same Uber customer ID in the request URL and in `.env`. If they do not match, this service returns `404` (not found).

You do not need to request an Uber login token yourself. The service logs in using your app ID and private key. If Uber rejects those keys, ask Uber to confirm that API access is approved for your account.

## Start and Test

Install Bun first, then open a terminal in this project directory. Add your Uber settings to `.env`, then start the service:

```powershell
bun run server.ts
```

During development, use this command to restart the service automatically when files change:

```powershell
bun run dev
```

The examples below use port `5000`; to match them, set `PORT=5000` in `.env`. Otherwise change the example URLs to the port printed when the service starts. Run the tests with:

```powershell
bun test
```

## Ecommerce Delivery Flow

Here is the order from start to finish:

1. Your store sends the pickup and customer addresses to this service and asks Uber for a quote.
2. Show the delivery option and price only if the quote works.
3. After the customer places the order, send the quote ID and same addresses to book the courier.
4. Save the delivery ID with the order. Uber uses it to identify this delivery.
5. Uber sends status and courier-location updates to `/webhook/uber`. This service checks that the message really came from Uber and passes it to your store's `DELIVERY_WEBHOOK_FORWARD_URL` endpoint.

Your store's endpoint must save each update and mark the order accordingly. It should accept duplicate updates safely. The examples below show how to call every route. The optional PowerShell examples follow JavaScript and `curl`.

## JavaScript Examples

These examples use `fetch`, which is built into Bun and modern Node.js. Run them on your server, not in the customer's browser. Your checkout should call your own store backend; keep Uber keys private and do not expose this service's unprotected quote and booking routes to the public internet.

Replace the customer ID and example addresses/contact details with your approved merchant and order data. These snippets share the setup below; run the relevant action block after setup. Run the quote before booking. **The booking example creates a real Uber delivery** in the configured Uber environment, so run it only after order confirmation and use sandbox while testing.

### Shared Setup

Use this helper and address pair with the action examples below. The request helper includes Uber's HTTP status and response body in any thrown error, including address-validation failures (`422`) and geocoder errors (`503`).

```js
const service = "http://localhost:5000";
const customerId = "PENDING_MERCHANT_ID_PLACEHOLDER";
const api = `${service}/v1/customers/${encodeURIComponent(customerId)}`;

async function request(url, options) {
	const response = await fetch(url, options);
	const body = await response.json();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
	}
	return body;
}

const pickup = {
	street_address: ["123 Store Road"],
	city: "Nairobi",
	country: "KE",
};
const dropoff = {
	street_address: ["42 Customer Lane"],
	city: "Nairobi",
	country: "KE",
};
```

### 1. Check Service Health

This checks that the Bun process is responding. It does not check Uber credentials or delivery coverage.

```js
const health = await request(`${service}/health`);
console.log("Service:", health.status);
```

### 2. Request a Delivery Quote

Request a quote before showing Uber delivery as an available checkout option. When address validation is enabled, the server checks the drop-off against Photon before it contacts Uber.

```js
const quote = await request(`${api}/delivery_quotes`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		pickup_address: pickup,
		dropoff_address: dropoff,
		pickup_latitude: -1.2864,
		pickup_longitude: 36.8172,
	}),
});
console.log("Quote:", quote.quote_id, "fee:", quote.estimated_fee);
```

The response is `201` and includes `quote_id` and `estimated_fee`. A `422` means Photon did not find a matching street or house number; a `503` means the geocoder was unavailable. Do not book unless the request succeeds and the customer confirms the order.

### 3. Create a Delivery

This calls Uber to book a courier. Use the same address values from the quote, and save the returned delivery ID and tracking URL in your order database. Reuse the same `idempotency_key` only when retrying the same order.

```js
const delivery = await request(`${api}/deliveries`, {
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
		manifest_items: [{
			name: "Example product",
			quantity: 1,
			size: "medium",
			price: 250000,
			must_be_upright: false,
			weight: 500,
		}],
	}),
});

console.log("Delivery:", delivery.id, delivery.tracking_url);
```

### 4. Check Delivery Status and Courier Location

Use the delivery ID returned by the booking call, or replace `delivery.id` with an ID you previously saved. This returns the latest Uber object; courier/location fields may be absent until Uber assigns a courier and reports a location.

```js
const deliveryId = delivery.id;
const current = await request(
	`${api}/deliveries/${encodeURIComponent(deliveryId)}`,
);

console.log("Full Uber response:", current);
console.log("Status:", current.status ?? "Not present in response");
console.log("Tracking URL:", current.tracking_url ?? "Not present in response");
console.log("Courier:", current.courier ?? "Not assigned or not present yet");
console.log("Courier location:", current.courier?.location ?? "Not available yet");
```

The service does not store status history. Call this endpoint again when you need a fresh snapshot; the tracking URL can also be shown to the customer.

### 5. Configure and Test Webhook Forwarding

For production, configure Uber Direct to POST `event.delivery_status` and `event.courier_update` events to `https://YOUR_HOST/webhook/uber`. The service verifies the HMAC signature, then forwards the unchanged JSON body and `X-Uber-Signature` header to `DELIVERY_WEBHOOK_FORWARD_URL`. Your ecommerce endpoint should persist the event, update the order associated with `delivery_id`, and return a `2xx` only after it has accepted the event. Use HTTPS for both public and production callback URLs.

The following sends a **fake test event** signed with the configured key. Point `DELIVERY_WEBHOOK_FORWARD_URL` at a test receiver before running it; otherwise the test event could update a real order. The receiving endpoint must handle duplicates because Uber may retry failed webhook deliveries.

```js
import { createHmac } from "node:crypto";

const webhookSigningKey = process.env.UBER_WEBHOOK_SIGNING_KEY;
if (!webhookSigningKey) throw new Error("Set UBER_WEBHOOK_SIGNING_KEY first.");

const webhookPayload = JSON.stringify({
	delivery_id: "TEST-DELIVERY-ID",
	kind: "event.delivery_status",
	data: { status: "pickup" },
});
const webhookSignature = createHmac("sha256", webhookSigningKey)
	.update(webhookPayload, "utf8")
	.digest("hex");

const webhookResponse = await fetch(`${service}/webhook/uber`, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		"X-Uber-Signature": webhookSignature,
	},
	body: webhookPayload,
});
console.log(webhookResponse.status, await webhookResponse.json());
```

On success the route responds with `200` and `{"status":"forwarded"}`. It returns `401` for an invalid signature, `503` if the signing key or forwarding URL is missing, and `502` if the ecommerce callback fails. Do not treat a `200` from this service as proof that your app applied the status unless the configured callback also handles it idempotently.

## curl Examples

These examples use POSIX shell quoting and `localhost:5000`. Substitute the actual customer ID after merchant approval. Keep the quote ID and delivery ID returned by Uber; this API does not store them for you.

### 1. Check Service Health

```sh
curl -i http://localhost:5000/health
```

Expect `200` and `{"status":"ok"}` if the Bun process is responding. This checks process health only; it does not verify Uber credentials.

### 2. Request a Delivery Quote

```sh
curl -i -X POST \
	'http://localhost:5000/v1/customers/PENDING_MERCHANT_ID_PLACEHOLDER/delivery_quotes' \
	-H 'Content-Type: application/json' \
	-d '{
		"pickup_address": {"street_address":["123 Store Road"],"city":"Nairobi","country":"KE"},
		"dropoff_address": {"street_address":["42 Customer Lane"],"city":"Nairobi","country":"KE"},
		"pickup_latitude": -1.2864,
		"pickup_longitude": 36.8172
	}'
```

On success, the response is `201` and includes Uber's quote fields plus `quote_id` and `estimated_fee`. Address validation is on by default: `422` means no matching street/house number was found; `503` means Photon could not be reached. Do not show the delivery option unless a quote succeeds. To skip map validation, set `ADDRESS_VALIDATION_ENABLED=false` in the service environment and restart it.

### 3. Book the Delivery

After the customer confirms the order, copy the quote's `quote_id` below. Use the **same pickup and drop-off addresses** that were used for that quote.

```sh
curl -i -X POST \
	'http://localhost:5000/v1/customers/PENDING_MERCHANT_ID_PLACEHOLDER/deliveries' \
	-H 'Content-Type: application/json' \
	-d '{
		"quote_id": "QUOTE_ID_FROM_PREVIOUS_RESPONSE",
		"pickup_address": {"street_address":["123 Store Road"],"city":"Nairobi","country":"KE"},
		"dropoff_address": {"street_address":["42 Customer Lane"],"city":"Nairobi","country":"KE"},
		"pickup_name": "Example Store",
		"pickup_phone_number": "+254700000000",
		"dropoff_name": "Customer Name",
		"dropoff_phone_number": "+254711111111",
		"manifest_reference": "ORDER-1001",
		"external_id": "ORDER-1001",
		"idempotency_key": "ORDER-1001",
		"manifest_total_value_cents": 250000,
		"deliverable_action": "deliverable_action_meet_at_door",
		"undeliverable_action": "return",
		"manifest_items": [{
			"name": "Example product",
			"quantity": 1,
			"size": "medium",
			"price": 250000,
			"must_be_upright": false,
			"weight": 500
		}]
	}'
```

Expect `201` with Uber's delivery object. Save its `id` against your order. Use the same `idempotency_key` when retrying the same booking request; use a different key for a different order.

### 4. Check Delivery Status and Courier Location

Replace the ID with the `id` returned when booking:

```sh
curl -i \
	'http://localhost:5000/v1/customers/PENDING_MERCHANT_ID_PLACEHOLDER/deliveries/DELIVERY_ID_FROM_BOOKING'
```

The response is Uber's latest delivery object. Inspect its `status`, `tracking_url`, and courier/location fields when present. The API returns the raw Uber object, so field availability depends on the delivery state; courier location may not be available before assignment or the first location update. There is no separate endpoint to locate a courier by order number; first save the Uber delivery `id`.

### 5. Test Signed Webhook Forwarding Locally

In production, configure Uber Direct to call your public HTTPS `/webhook/uber` URL and subscribe to `event.delivery_status` and `event.courier_update`. The service verifies the HMAC signature and forwards the unchanged body and signature header to `DELIVERY_WEBHOOK_FORWARD_URL`. The ecommerce callback should persist the event and return `2xx` only when accepted.

This sends a **fake test event**. Set `UBER_WEBHOOK_SIGNING_KEY` and point `DELIVERY_WEBHOOK_FORWARD_URL` at a test receiver first; otherwise the fake event could update a real order. The receiver must tolerate duplicate events.

```sh
payload='{"delivery_id":"TEST-DELIVERY-ID","kind":"event.delivery_status","data":{"status":"pickup"}}'
signature=$(printf %s "$payload" | openssl dgst -sha256 -hmac "$UBER_WEBHOOK_SIGNING_KEY" | awk '{print $2}')

curl -i -X POST 'http://localhost:5000/webhook/uber' \
	-H 'Content-Type: application/json' \
	-H "X-Uber-Signature: $signature" \
	--data-binary "$payload"
```

Success returns `200` and `{"status":"forwarded"}`. An invalid signature returns `401`; missing webhook configuration returns `503`; and a failed callback returns `502` so Uber can retry.

## PowerShell Examples (Optional)

These examples are equivalent to the primary JavaScript and `curl` flow above. Replace the customer ID, addresses, and contact data with real values.

```powershell
$service = 'http://localhost:5000'
$customerId = 'PENDING_MERCHANT_ID_PLACEHOLDER'
$api = "$service/v1/customers/$customerId"
$pickup = @{ street_address = @('123 Store Road'); city = 'Nairobi'; country = 'KE' }
$dropoff = @{ street_address = @('42 Customer Lane'); city = 'Nairobi'; country = 'KE' }

# Health and quote
Invoke-RestMethod "$service/health"
$quote = Invoke-RestMethod -Uri "$api/delivery_quotes" -Method Post `
	-ContentType 'application/json' -Body (@{
		pickup_address = $pickup
		dropoff_address = $dropoff
		pickup_latitude = -1.2864
		pickup_longitude = 36.8172
	} | ConvertTo-Json -Depth 10)

# Book and save $delivery.id against the ecommerce order
$delivery = Invoke-RestMethod -Uri "$api/deliveries" -Method Post `
	-ContentType 'application/json' -Body (@{
		quote_id = $quote.quote_id
		pickup_address = $pickup
		dropoff_address = $dropoff
		pickup_name = 'Example Store'
		pickup_phone_number = '+254700000000'
		dropoff_name = 'Customer Name'
		dropoff_phone_number = '+254711111111'
		manifest_reference = 'ORDER-1001'
		external_id = 'ORDER-1001'
		idempotency_key = 'ORDER-1001'
		manifest_total_value_cents = 250000
		deliverable_action = 'deliverable_action_meet_at_door'
		undeliverable_action = 'return'
		manifest_items = @(@{
			name = 'Example product'
			quantity = 1
			size = 'medium'
			price = 250000
			must_be_upright = $false
			weight = 500
		})
	} | ConvertTo-Json -Depth 10)

# Fetch current Uber status/location
Invoke-RestMethod "$api/deliveries/$($delivery.id)"

# Simulate a signed event only with a test forwarding destination configured
$webhookPayload = '{"delivery_id":"TEST-DELIVERY-ID","kind":"event.delivery_status","data":{"status":"pickup"}}'
$webhookKey = $env:UBER_WEBHOOK_SIGNING_KEY
$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($webhookKey))
$signature = [Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($webhookPayload))).ToLowerInvariant()
$hmac.Dispose()
Invoke-RestMethod -Uri "$service/webhook/uber" -Method Post `
	-Headers @{ 'X-Uber-Signature' = $signature } `
	-ContentType 'application/json' -Body $webhookPayload
```

Persist the returned quote ID and delivery ID in your ecommerce order database. A quote may expire before booking; request another quote if Uber rejects it. Confirm manifest units and accepted values with your Uber Direct account before going live.

## Routes and Responses

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Process liveness check |
| `POST /v1/customers/{customer_id}/delivery_quotes` | Request a quote; response includes Uber quote fields plus `quote_id` and `estimated_fee` |
| `POST /v1/customers/{customer_id}/deliveries` | Book a delivery; response is Uber's delivery object |
| `GET /v1/customers/{customer_id}/deliveries/{delivery_id}` | Fetch current Uber delivery details/status |
| `POST /webhook/uber` | Verify Uber's signature and forward the raw event to the configured ecommerce callback; not persisted |

Local input errors return `400`; unknown routes or a customer ID different from configured `UBER_CUSTOMER_ID` return `404`. Uber API errors are returned with Uber's HTTP status where available. OAuth failures currently surface as server errors with the OAuth error message.

## Go-Live Checklist

- Replace the pending customer ID with the merchant's actual Uber Direct customer ID.
- Resolve the observed OAuth `401 unauthorized_client` and verify token retrieval succeeds.
- Test quote creation, delivery booking, and status lookup against sandbox using valid merchant-approved addresses and manifest data.
- Confirm whether the configured Uber environment is sandbox or production before changing `UBER_API_BASE_URL`.
- Put the service behind HTTPS and authenticate ecommerce-app requests; never expose client secrets to the browser/mobile app.
- Create an HTTPS webhook in the Uber Direct dashboard, subscribe to delivery-status and courier-update events, and set its signing key in `UBER_WEBHOOK_SIGNING_KEY`.
- Set `DELIVERY_WEBHOOK_FORWARD_URL` to an authenticated HTTPS ecommerce endpoint that persists events, applies updates by `delivery_id`, and handles duplicate deliveries idempotently.
- Add durable order-to-delivery storage, retries, monitoring, and cancellation/update flows if the ecommerce workflow requires them.