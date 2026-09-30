# Uber Direct Delivery Service

A Bun HTTP service for connecting an ecommerce application to Uber Direct. The implemented flow is: request a delivery quote, book a delivery with that quote, then fetch its latest status and courier details. Uber webhooks are accepted and logged. The service uses Bun's built-in `fetch` and `Bun.serve`; it has no runtime package dependencies.

## Read This Before Going Live

This is an API adapter, not a complete order-management system. It does not store orders, delivery status history, or webhook events. Your ecommerce application should store the delivery ID returned by booking and call the status endpoint when it needs fresh status/location. Webhook events currently go to the server console only; they are not saved or forwarded to your ecommerce application.

### Selecting Accurate Pickup and Drop-off Locations

This service does **not** provide a customer-facing location picker. Your ecommerce application supplies the pickup and drop-off addresses. Uber Direct's quote request checks the supplied route and returns a quote when it can service it; it does not return a list of address/place suggestions for a customer to choose from. A successful quote is the serviceability check, not an address-autocomplete result.

The quote endpoint verifies the drop-off against Komoot's public Photon geocoder before sending the quote request to Uber. It is enabled by default and needs no API key or geocoder URL. Set `ADDRESS_VALIDATION_ENABLED=false` to turn it off. The check requires a mapped street match and, when the submitted street starts with a house number, the same house number in the result. Unmatched addresses are rejected with `422`; if Photon is unavailable, the quote is rejected with `503` rather than sent to Uber. A map match improves address accuracy but does not guarantee Uber can serve the route; Uber's quote is still required.

Photon's public demo is free for reasonable request volumes, but has no availability guarantee and may throttle or block extensive usage. This service makes one geocoding request per quote. The full drop-off address is sent from your server to `https://photon.komoot.io`; account for that third-party processing in your privacy disclosures. For higher-volume or guaranteed availability, host Photon yourself and set `ADDRESS_VALIDATION_BASE_URL` to that endpoint. This setting is optional; it is an override, not a required setup URL. `ADDRESS_VALIDATION_COUNTRY_CODES` can restrict results, for example `ke`.

The Bun API still listens on its single `PORT` (default `3000`). The optional geocoder URL is only used for server-to-server requests; customers do not need a second port.

#### Checkout Address Picker Setup

Implement the picker in your ecommerce checkout with a provider such as Google Places Autocomplete or Mapbox Search JS. The picker belongs in the customer-facing ecommerce app; this Bun service does not render a map or call a mapping provider.

1. Restrict autocomplete to the countries and service area where you deliver. Bias results around the delivery region, but do not treat that bias as proof Uber serves the address.
2. Require the customer to select an autocomplete result or confirm a dropped pin. Do not submit arbitrary, unselected text as a verified location.
3. From the selected result, save the provider place/feature ID for your own records, its canonical formatted address, and its latitude/longitude. Ask for apartment, suite, floor, gate, or delivery instructions separately; append street/unit details to the address where appropriate.
4. For pickup, maintain an admin-verified list of store/warehouse locations, each with its canonical address, coordinates, and courier instructions. At checkout choose the fulfillment location for the order from this list; do not ask the buyer to type the pickup address.
5. Convert the selected address into Uber's structured address shape and call this service's quote endpoint. Only present the Uber option if the quote succeeds. If Uber reports an undeliverable address/route, ask the buyer to correct the drop-off or choose another delivery method.
6. Send the exact same pickup and drop-off addresses with the quote ID when booking. Store the selected provider ID and coordinates alongside your order so your support team can verify what the customer selected.

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

The service serializes this object as the address string Uber Direct expects. It currently explicitly accepts pickup latitude/longitude on quote requests. Although extra fields are forwarded, this integration has not verified Uber's accepted drop-off coordinate fields; treat selected drop-off coordinates as your own stored data until confirmed against your Uber Direct account/API reference. An autocomplete result improves address selection but does not guarantee Uber coverage; the quote response is the serviceability check.

The API routes currently have no app authentication or rate limiting. The webhook has no signature verification. Do not expose this server publicly until it is behind your authentication/network controls and the webhook is verified. Delivery cancellation, delivery updates, refunds, and persistent event delivery are not implemented.

The live OAuth check made during setup returned `401 unauthorized_client`, even with the requested `eats.deliveries` scope. Therefore, this is **not yet plug-and-play**: adding the customer ID alone will not be enough until Uber accepts the client credentials and grants the app the required access. Confirm the Uber Direct app is enabled/approved for the client-credentials grant and required scope, then test OAuth again.

## Configuration

Bun automatically loads a local `.env` file. Keep `.env` private and do not commit it. The repository's `.gitignore` excludes it.

| Variable | Purpose | Default |
| --- | --- | --- |
| `UBER_CLIENT_ID` | Uber OAuth client ID | Required |
| `UBER_CLIENT_SECRET` | Uber OAuth client secret | Required |
| `UBER_CUSTOMER_ID` | Merchant/customer ID used in every Uber API URL and local API route | `PENDING_MERCHANT_ID_PLACEHOLDER` |
| `UBER_API_BASE_URL` | Uber API environment | `https://api.sandbox.uber.com` |
| `PORT` | Local HTTP port | `3000` |
| `ADDRESS_VALIDATION_ENABLED` | Require a map match before requesting an Uber quote | `true` |
| `ADDRESS_VALIDATION_BASE_URL` | Optional Photon-compatible geocoder endpoint override | `https://photon.komoot.io/api/` |
| `ADDRESS_VALIDATION_USER_AGENT` | Identifies this service in geocoder requests | `boost-carrier/1.0` |
| `ADDRESS_VALIDATION_COUNTRY_CODES` | Optional comma-separated country codes to limit Photon results | Empty |

The customer ID is required by the existing Odoo implementation as well: its API URLs are built under `/customers/{customer_id}/...`. Once Uber provides the real ID, set it in `.env` and use the same value in the request path to this service. A mismatched ID gets a local `404`.

Uber's OAuth token endpoint is `https://login.uber.com/oauth/v2/token`. The service requests a `client_credentials` token with the `eats.deliveries direct.organizations` scopes used by the Odoo implementation and caches the token until shortly before expiry.

## Start and Test

From the project directory:

```powershell
bun run server.ts
```

For development with reload:

```powershell
bun run dev
```

Set `PORT=5000` in `.env` to listen on port 5000. The server prints its listening URL at startup. Run the local tests with:

```powershell
bun test
```

## Ecommerce Delivery Flow

Use the same customer ID and selected pickup/drop-off addresses for the quote and booking. Address objects are serialized to JSON strings for Uber Direct; structured fields should include street, city, region/postal code when applicable, and country.

The primary integration examples below are JavaScript and `curl`. The lifecycle is: check service health, request a quote, book after order confirmation, persist the returned delivery ID, then fetch current status/location as needed. Configure Uber to send webhooks to `https://YOUR_HOST/webhook/uber`; this handler currently logs and acknowledges events but does not store or forward them. An optional PowerShell version follows the JavaScript and `curl` examples.

## JavaScript Examples

These examples use native `fetch` and work in Bun or modern Node.js. Run them on your ecommerce backend, not in browser code. Your ecommerce frontend should call your own authenticated application API; never expose Uber credentials or this unauthenticated service directly to browsers.

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

### 5. Test Webhook Acknowledgement

For production, configure Uber Direct to POST real events to `https://YOUR_HOST/webhook/uber`; your ecommerce app does not send those events. This local example sends a **fake test event**. The route only logs and acknowledges it; it does not update an order database, verify Uber's signature, or forward the event elsewhere.

```js
const webhookResponse = await fetch("http://localhost:5000/webhook/uber", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		delivery_id: "DELIVERY_ID_FROM_UBER",
		kind: "event.delivery_status",
		data: {
			status: "pickup",
			courier_imminent: false,
			tracking_url: "https://example.test/track",
			courier: {
				name: "Test Courier",
				location: { lat: -1.2864, lng: 36.8172 },
			},
		},
	}),
});
console.log(webhookResponse.status, await webhookResponse.json());
```

The test route responds with `200` and `{"status":"acknowledged"}`. This confirms only that the local handler accepted the test payload, not that a real delivery or order was updated.

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

### 5. Test Webhook Acknowledgement Locally

This sends a **fake test event** to the local route. In production, configure Uber Direct to call your public `/webhook/uber` URL. The route currently logs and acknowledges the body only; it does not persist it, update the order, or verify a signature.

```sh
curl -i -X POST 'http://localhost:5000/webhook/uber' \
	-H 'Content-Type: application/json' \
	-d '{
		"delivery_id":"DELIVERY_ID_FROM_UBER",
		"kind":"event.delivery_status",
		"data":{
			"status":"pickup",
			"courier_imminent":false,
			"tracking_url":"https://example.test/track",
			"courier":{"name":"Test Courier","location":{"lat":-1.2864,"lng":36.8172}}
		}
	}'
```

The route returns `200` with `{"status":"acknowledged"}` and logs the event. Do not treat that response as confirmation that your ecommerce order was updated.

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

# Simulate a webhook locally; the service acknowledges and logs this event
Invoke-RestMethod -Uri "$service/webhook/uber" -Method Post `
	-ContentType 'application/json' -Body (@{
		delivery_id = $delivery.id
		kind = 'event.delivery_status'
		data = @{
			status = 'pickup'
			courier_imminent = $false
			courier = @{ name = 'Test Courier'; location = @{ lat = -1.2864; lng = 36.8172 } }
		}
	} | ConvertTo-Json -Depth 10)
```

Persist the returned quote ID and delivery ID in your ecommerce order database. A quote may expire before booking; request another quote if Uber rejects it. Confirm manifest units and accepted values with your Uber Direct account before going live.

## Routes and Responses

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Process liveness check |
| `POST /v1/customers/{customer_id}/delivery_quotes` | Request a quote; response includes Uber quote fields plus `quote_id` and `estimated_fee` |
| `POST /v1/customers/{customer_id}/deliveries` | Book a delivery; response is Uber's delivery object |
| `GET /v1/customers/{customer_id}/deliveries/{delivery_id}` | Fetch current Uber delivery details/status |
| `POST /webhook/uber` | Acknowledge and log an Uber event; not persisted |

Local input errors return `400`; unknown routes or a customer ID different from configured `UBER_CUSTOMER_ID` return `404`. Uber API errors are returned with Uber's HTTP status where available. OAuth failures currently surface as server errors with the OAuth error message.

## Go-Live Checklist

- Replace the pending customer ID with the merchant's actual Uber Direct customer ID.
- Resolve the observed OAuth `401 unauthorized_client` and verify token retrieval succeeds.
- Test quote creation, delivery booking, and status lookup against sandbox using valid merchant-approved addresses and manifest data.
- Confirm whether the configured Uber environment is sandbox or production before changing `UBER_API_BASE_URL`.
- Put the service behind HTTPS and authenticate ecommerce-app requests; never expose client secrets to the browser/mobile app.
- Verify webhook authenticity, persist events, and make event handling idempotent before relying on callbacks for order updates.
- Add durable order-to-delivery storage, retries, monitoring, and cancellation/update flows if the ecommerce workflow requires them.