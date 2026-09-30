const TOKEN_URL = "https://login.uber.com/oauth/v2/token";
const TOKEN_SCOPE = "eats.deliveries direct.organizations";

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: CachedToken | undefined;
let tokenRequest: Promise<string> | undefined;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.accessToken;
  if (tokenRequest) return tokenRequest;

  tokenRequest = requestToken();
  try {
    return await tokenRequest;
  } finally {
    tokenRequest = undefined;
  }
}

async function requestToken(): Promise<string> {
  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("UBER_CLIENT_ID and UBER_CLIENT_SECRET must be configured.");
  }

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: TOKEN_SCOPE,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok) {
    throw new Error(body.error_description || body.error || `Uber OAuth failed (${response.status}).`);
  }
  if (!body.access_token || !Number.isFinite(body.expires_in) || body.expires_in! <= 0) {
    throw new Error("Uber OAuth response did not include a valid access token and expiry.");
  }

  const expiresInMs = body.expires_in * 1000;
  cachedToken = {
    accessToken: body.access_token,
    expiresAt: Date.now() + Math.max(0, expiresInMs - Math.min(60_000, expiresInMs * 0.1)),
  };
  return body.access_token;
}