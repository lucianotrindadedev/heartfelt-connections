import { useEffect, useState } from "react";

/** Remove barra final e normaliza host sem protocolo. */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

/**
 * URL pública da app (Coolify, Vercel, localhost).
 * No browser usa window.location.origin; no servidor usa APP_BASE_URL.
 */
export function getAppBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin.replace(/\/$/, "");
  }
  const raw =
    process.env.APP_BASE_URL ??
    process.env.APP_URL ??
    process.env.PUBLIC_APP_URL ??
    "";
  return normalizeBaseUrl(raw);
}

/** Igual a getAppBaseUrl no servidor; no cliente atualiza após mount (SSR + hidratação). */
export function useClientAppBaseUrl(): string {
  const [base, setBase] = useState(() => getAppBaseUrl());
  useEffect(() => {
    setBase(window.location.origin.replace(/\/$/, ""));
  }, []);
  return base;
}

export function appUrl(path: string): string {
  const base = getAppBaseUrl();
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

export function helenaWebhookUrl(accountId: string, baseUrl?: string): string {
  const base = baseUrl ?? getAppBaseUrl();
  return base
    ? `${base}/api/public/webhook/helena/${accountId}`
    : `/api/public/webhook/helena/${accountId}`;
}

export function helenaAutomationWebhookUrl(accountId: string, baseUrl?: string): string {
  const base = baseUrl ?? getAppBaseUrl();
  return base
    ? `${base}/api/public/webhook/helena-automation/${accountId}`
    : `/api/public/webhook/helena-automation/${accountId}`;
}

export function embedAccountUrl(accountId: string, baseUrl?: string): string {
  const base = baseUrl ?? getAppBaseUrl();
  return base ? `${base}/embed/account/${accountId}` : `/embed/account/${accountId}`;
}

/** Para chamadas server-side (cron drain, etc.). */
export function resolveAppBaseUrl(): string | null {
  const raw =
    process.env.APP_URL ??
    process.env.APP_BASE_URL ??
    process.env.PUBLIC_APP_URL ??
    process.env.VERCEL_URL ??
    null;
  if (!raw) return null;
  return normalizeBaseUrl(raw) || null;
}
