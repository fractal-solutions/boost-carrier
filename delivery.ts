import { getAccessToken } from "./auth";

export type UberAddress = string | Record<string, unknown>;

export type DeliveryQuoteInput = {
  pickup_address: UberAddress;
  dropoff_address: UberAddress;
  pickup_latitude?: number;
  pickup_longitude?: number;
  [key: string]: unknown;
};

export type DeliveryInput = {
  quote_id: string;
  manifest_items: Array<Record<string, unknown>>;
  dropoff_name: string;
  dropoff_phone_number: string;
  pickup_address: UberAddress;
  dropoff_address: UberAddress;
  [key: string]: unknown;
};

function apiBaseUrl(): string {
  const configured = (process.env.UBER_API_BASE_URL || "https://api.sandbox.uber.com").replace(/\/+$/, "");
  return configured.endsWith("/v1") ? configured : `${configured}/v1`;
}

export function formatUberAddress(address: UberAddress): string {
  return typeof address === "string" ? address : JSON.stringify(address);
}

async function uberRequest<T>(customerId: string, endpoint: string, init: RequestInit = {}): Promise<T> {
  if (!customerId) throw new Error("Uber customer ID is required.");
  const accessToken = await getAccessToken();
  const response = await fetch(
    `${apiBaseUrl()}/customers/${encodeURIComponent(customerId)}/${endpoint}`,
    {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal || AbortSignal.timeout(20_000),
    },
  );

  const rawBody = await response.text();
  let body: unknown = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = { message: rawBody };
    }
  }

  if (!response.ok) {
    const error = body as { message?: string; code?: string };
    throw new UberApiError(response.status, error.message || error.code || "Uber Direct request failed.", body);
  }
  return body as T;
}

export class UberApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = "UberApiError";
  }
}

export async function createDeliveryQuote(customerId: string, input: DeliveryQuoteInput) {
  const payload = {
    ...input,
    pickup_address: formatUberAddress(input.pickup_address),
    dropoff_address: formatUberAddress(input.dropoff_address),
  };
  return uberRequest<Record<string, unknown>>(customerId, "delivery_quotes", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function createDelivery(customerId: string, input: DeliveryInput) {
  const payload = {
    ...input,
    pickup_address: formatUberAddress(input.pickup_address),
    dropoff_address: formatUberAddress(input.dropoff_address),
  };
  return uberRequest<Record<string, unknown>>(customerId, "deliveries", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getDelivery(customerId: string, deliveryId: string) {
  if (!deliveryId) throw new Error("Uber delivery ID is required.");
  return uberRequest<Record<string, unknown>>(
    customerId,
    `deliveries/${encodeURIComponent(deliveryId)}`,
  );
}