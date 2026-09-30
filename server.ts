import {
  createDelivery,
  createDeliveryQuote,
  getDelivery,
  UberApiError,
  type DeliveryInput,
  type DeliveryQuoteInput,
} from "./delivery";
import { AddressValidationError, validateDropoffAddress } from "./address_validation";

const customerId = process.env.UBER_CUSTOMER_ID || "PENDING_MERCHANT_ID_PLACEHOLDER";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function validateCustomerId(requestedId: string): void {
  if (requestedId !== customerId) throw new HttpError(404, "Customer not found.");
}

function validateQuoteInput(body: Record<string, unknown>): DeliveryQuoteInput {
  if (!body.pickup_address || !body.dropoff_address) {
    throw new HttpError(400, "pickup_address and dropoff_address are required.");
  }
  return body as DeliveryQuoteInput;
}

function validateDeliveryInput(body: Record<string, unknown>): DeliveryInput {
  if (
    typeof body.quote_id !== "string" ||
    !body.quote_id ||
    !Array.isArray(body.manifest_items) ||
    body.manifest_items.length === 0 ||
    typeof body.dropoff_name !== "string" ||
    typeof body.dropoff_phone_number !== "string" ||
    !body.pickup_address ||
    !body.dropoff_address
  ) {
    throw new HttpError(400, "quote_id, pickup_address, dropoff_address, non-empty manifest_items, dropoff_name, and dropoff_phone_number are required.");
  }
  return body as DeliveryInput;
}

function logWebhook(payload: Record<string, unknown>): void {
  const data = payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : {};
  console.info("Uber Direct webhook update", JSON.stringify({
    delivery_id: payload.delivery_id,
    kind: payload.kind,
    status: data.status,
    courier_imminent: data.courier_imminent,
    courier: data.courier,
    tracking_url: data.tracking_url,
    created: payload.created,
  }));
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  if (error instanceof AddressValidationError) {
    return json({ error: error.message }, error.status);
  }
  if (error instanceof UberApiError) {
    return json({ error: error.message, details: error.details }, error.status);
  }
  if (error instanceof SyntaxError) return json({ error: "Request body must contain valid JSON." }, 400);

  console.error("Uber Direct request failed", error);
  return json({ error: error instanceof Error ? error.message : "Internal server error." }, 500);
}

export const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ status: "ok" });
      }

      if (url.pathname === "/webhook/uber" && request.method === "POST") {
        const payload = await readJson(request);
        logWebhook(payload);
        return json({ status: "acknowledged" });
      }

      if (parts[0] !== "v1" || parts[1] !== "customers" || !parts[2]) {
        return json({ error: "Not found." }, 404);
      }
      validateCustomerId(parts[2]);

      if (parts.length === 4 && parts[3] === "delivery_quotes" && request.method === "POST") {
        const input = validateQuoteInput(await readJson(request));
        await validateDropoffAddress(input.dropoff_address);
        const quote = await createDeliveryQuote(parts[2], input);
        return json({
          ...quote,
          quote_id: quote.quote_id ?? quote.id,
          estimated_fee: quote.fee,
        }, 201);
      }

      if (parts.length === 4 && parts[3] === "deliveries" && request.method === "POST") {
        const input = validateDeliveryInput(await readJson(request));
        return json(await createDelivery(parts[2], input), 201);
      }

      if (parts.length === 5 && parts[3] === "deliveries" && request.method === "GET") {
        return json(await getDelivery(parts[2], parts[4]));
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  },
});

console.info(`Uber Direct backend listening at ${server.url}`);