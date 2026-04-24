/**
 * Cliente HTTP para o backend (Node/Hono na sua VPS).
 * Configure VITE_API_BASE_URL no ambiente para apontar para sua API
 * (ex.: https://api.suaplataforma.com).
 *
 * Quando VITE_MOCK_API=true (ou estamos em DEV sem backend),
 * as requisições são interceptadas por src/lib/mockApi.ts.
 */

import { handleMock, MOCK_API_ENABLED } from "./mockApi";

export const API_BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  "https://yyggvih3qzox0cl5jbftnvf2.72.62.104.184.sslip.io";

export const IS_MOCK = MOCK_API_ENABLED;

const TOKEN_STORAGE_KEY = "helena_agent_jwt";
const ADMIN_TOKEN_STORAGE_KEY = "helena_admin_token";

export function getJwt(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setJwt(token: string) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearJwt() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function setAdminToken(token: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
}

export function clearAdminToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

type ApiOptions = RequestInit & {
  admin?: boolean;
  json?: unknown;
};

export async function api<T = unknown>(
  path: string,
  options: ApiOptions = {},
): Promise<T> {
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");

  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  if (options.admin) {
    const adminToken = getAdminToken();
    if (adminToken) headers.set("X-Admin-Token", adminToken);
  } else {
    const jwt = getJwt();
    if (jwt) {
      headers.set("Authorization", `Bearer ${jwt}`);
    } else {
      console.warn("[api] No JWT found for request:", path);
    }
  }

  const url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;

  if (IS_MOCK && !path.startsWith("http")) {
    const result = await handleMock(path, {
      method: (options.method as string | undefined) ?? "GET",
      body: options.json,
    });
    return result as T;
  }

  const res = await fetch(url, {
    ...options,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText) || `HTTP ${res.status}`;
    throw new ApiError(res.status, message, parsed);
  }

  return parsed as T;
}

export async function exchangeAccountToken(params: {
  accountId: string;
}): Promise<{ token: string; account: { id: string; name: string } }> {
  const adminToken = getAdminToken();
  return api("/api/auth/exchange", {
    method: "POST",
    json: params,
    admin: !!adminToken, // Envia X-Admin-Token se existir localmente
  });
}
