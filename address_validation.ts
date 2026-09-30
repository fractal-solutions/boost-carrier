import type { UberAddress } from "./delivery";

const addressValidationEnv = process.env as unknown as Record<string, string | undefined>;

type GeocoderResult = {
  geometry?: { coordinates?: unknown };
  properties?: Record<string, string>;
};

const DEFAULT_GEOCODER_URL = "https://photon.komoot.io/api/";

export class AddressValidationError extends Error {
  constructor(
    public readonly status: 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = "AddressValidationError";
  }
}

function isEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(addressValidationEnv.ADDRESS_VALIDATION_ENABLED || "true");
}

function addressQuery(address: UberAddress): string {
  if (typeof address === "string") {
    const trimmed = address.trim();
    if (!trimmed) return "";
    try {
      return addressQuery(JSON.parse(trimmed) as UberAddress);
    } catch {
      return trimmed;
    }
  }

  const fields = ["street_address", "city", "state", "zip_code", "country"];
  return fields.flatMap((field) => {
    const value = address[field];
    if (Array.isArray(value)) return value.filter((part) => typeof part === "string");
    return typeof value === "string" ? [value] : [];
  }).map((part) => part.trim()).filter(Boolean).join(", ");
}

function requestedHouseNumber(query: string): string | undefined {
  const firstLine = query.split(",", 1)[0];
  return firstLine.match(/^\s*(\d+[a-z]?)\b/i)?.[1].toLowerCase();
}

function requestedStreetName(query: string): string {
  return query.split(",", 1)[0].replace(/^\s*\d+[a-z]?\s*/i, "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasStreetLevelMatch(result: GeocoderResult, houseNumber: string | undefined, streetName: string): boolean {
  const properties = result.properties;
  if (!properties?.street) return false;
  const mappedStreet = properties.street.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!streetName || mappedStreet !== streetName) return false;
  if (houseNumber && properties.housenumber?.toLowerCase() !== houseNumber) return false;

  const coordinates = result.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

export async function validateDropoffAddress(address: UberAddress): Promise<void> {
  if (!isEnabled()) return;

  const query = addressQuery(address);
  if (!query) {
    throw new AddressValidationError(422, "Drop-off address is empty or could not be verified.");
  }

  const baseUrl = (addressValidationEnv.ADDRESS_VALIDATION_BASE_URL || DEFAULT_GEOCODER_URL).replace(/\/+$/, "");

  let searchUrl: URL;
  try {
    searchUrl = new URL(baseUrl);
  } catch {
    throw new AddressValidationError(503, "Address verification URL is invalid.");
  }
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.append("layer", "house");
  searchUrl.searchParams.append("layer", "street");
  searchUrl.searchParams.set("limit", "5");
  const countryCodes = addressValidationEnv.ADDRESS_VALIDATION_COUNTRY_CODES?.trim();
  if (countryCodes) {
    for (const code of countryCodes.split(",").map((value) => value.trim()).filter(Boolean)) {
      searchUrl.searchParams.append("countrycode", code);
    }
  }

  let response: Response;
  try {
    response = await fetch(searchUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": addressValidationEnv.ADDRESS_VALIDATION_USER_AGENT || "boost-carrier/1.0",
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AddressValidationError(503, "Address verification is temporarily unavailable.");
  }

  if (!response.ok) {
    throw new AddressValidationError(503, "Address verification is temporarily unavailable.");
  }

  let results: unknown;
  try {
    results = await response.json();
  } catch {
    throw new AddressValidationError(503, "Address verification returned an invalid response.");
  }

  const houseNumber = requestedHouseNumber(query);
  const streetName = requestedStreetName(query);
  const features = results && typeof results === "object" ? (results as { features?: unknown }).features : undefined;
  if (!Array.isArray(features) || !features.some((result) =>
    result && typeof result === "object" && hasStreetLevelMatch(result as GeocoderResult, houseNumber, streetName)
  )) {
    throw new AddressValidationError(422, "Drop-off address could not be matched to a street-level map location.");
  }
}