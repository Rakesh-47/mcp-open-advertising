// Copyright (c) Cesteral AB. Licensed under the Apache License, Version 2.0.
// See LICENSE.md in the project root for full license terms.

import type { Logger } from "pino";
import type { GoogleAuthAdapter } from "@cesteral/shared";
import { fetchWithTimeout, executeWithRetry } from "@cesteral/shared";
import type { RequestContext, RetryConfig } from "@cesteral/shared";
import { withDV360ApiSpan } from "../../utils/platform.js";

export const DV360_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 10_000,
  timeoutMs: 10_000,
  platformName: "DV360",
};

/** `overrides` without its `undefined` entries, so they cannot unset a default. */
function definedOnly<T extends object>(overrides: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/**
 * The retry budget of the advertiser currency lookup that governed writes make
 * for their snapshots (`DV360Service.getAdvertiserCurrency`). It is a read
 * that only labels a snapshot, so a failure degrades to an explicitly unknown
 * currency instead of being pursued: one retry and a 5 s timeout per attempt,
 * at most ~11 s once per failure window, instead of the client's default of 3
 * retries at 10 s (about a minute) paid again by every governed write.
 */
export const DV360_CURRENCY_LOOKUP_RETRY = {
  timeoutMs: 5_000,
  maxRetries: 1,
  initialBackoffMs: 500,
  maxBackoffMs: 2_000,
} as const;

/**
 * Shared HTTP client for DV360 API requests.
 *
 * Delegates authentication to the injected GoogleAuthAdapter (which handles
 * token caching, refresh, and mutex internally). Provides retry logic with
 * exponential backoff and consistent error handling via shared executeWithRetry.
 */
export class DV360HttpClient {
  constructor(
    private authAdapter: GoogleAuthAdapter,
    private baseUrl: string,
    private logger: Logger
  ) {}

  /**
   * Derive the upload base URL from the configured base URL.
   *
   * For a base URL like `https://displayvideo.googleapis.com/v4`
   * the upload base is `https://displayvideo.googleapis.com/upload/v4` —
   * Google's media-upload convention is `/upload/{versionPath}`, not
   * `/upload/{serviceName}/{versionPath}`.
   */
  getUploadBaseUrl(): string {
    const parsed = new URL(this.baseUrl);
    // pathname is e.g. "/v4"
    return `${parsed.origin}/upload${parsed.pathname}`;
  }

  /**
   * Build the media-upload URI for a reserved upload location.
   *
   * DV360's `media.upload` endpoint is version-less:
   * `POST https://displayvideo.googleapis.com/upload/media/{resourceName=**}`
   * — note it is NOT under the versioned `/upload/v4` path that
   * {@link getUploadBaseUrl} produces for asset/creative uploads. The
   * `resourceName` comes from a prior `:uploadScript` / `:uploadRules`
   * reservation and is itself a multi-segment path, so its slashes are part of
   * the URI (`{resourceName=**}` matches multiple segments) and must not be
   * percent-encoded.
   */
  getMediaUploadUrl(resourceName: string): string {
    const parsed = new URL(this.baseUrl);
    return `${parsed.origin}/upload/media/${resourceName}`;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Make an authenticated request to the DV360 API.
   *
   * - Prepends `baseUrl` to `path`.
   * - Retries on 429 and 5xx with exponential backoff (respects Retry-After).
   * - Parses JSON or returns `{}` for 204 No Content.
   *
   * `overrides.timeoutMs` raises the per-attempt timeout for methods Discovery
   * flags as "regularly experiences high latency" (e.g. `lineItems.duplicate`),
   * where the default would abort a request that is still committing. The other
   * overrides narrow the retry budget of a best-effort read
   * ({@link DV360_CURRENCY_LOOKUP_RETRY}).
   */
  async fetch(
    path: string,
    context?: RequestContext,
    options?: RequestInit,
    overrides?: Partial<
      Pick<RetryConfig, "timeoutMs" | "maxRetries" | "initialBackoffMs" | "maxBackoffMs">
    >
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const method = options?.method || "GET";

    this.logger.debug({ url, method, requestId: context?.requestId }, "Making DV360 API request");

    return withDV360ApiSpan(`api.${method}`, path, async (span) => {
      span.setAttribute("http.request.method", method);
      span.setAttribute("http.url", url);
      const retryConfig: RetryConfig = overrides
        ? { ...DV360_RETRY_CONFIG, ...definedOnly(overrides) }
        : DV360_RETRY_CONFIG;
      return executeWithRetry(retryConfig, {
        url,
        fetchOptions: options,
        context,
        logger: this.logger,
        fetchFn: fetchWithTimeout,
        getHeaders: async () => {
          const accessToken = await this.authAdapter.getAccessToken();
          return {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          };
        },
      });
    });
  }

  /**
   * Make an authenticated request with full caller control over the URL,
   * timeout, and options.
   *
   * Used by upload endpoints (e.g. custom bidding script/rules uploads)
   * that require absolute URLs and non-JSON content types.
   *
   * **No retry logic** is applied - the caller is responsible for error handling.
   */
  async fetchRaw(
    url: string,
    timeoutMs: number,
    context?: RequestContext,
    options?: RequestInit
  ): Promise<Response> {
    const method = options?.method || "POST";

    return withDV360ApiSpan(`api.raw.${method}`, url, async (span) => {
      span.setAttribute("http.request.method", method);
      span.setAttribute("http.url", url);
      const accessToken = await this.authAdapter.getAccessToken();
      const response = await fetchWithTimeout(url, timeoutMs, context, {
        ...options,
        headers: {
          ...options?.headers,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      span.setAttribute("http.response.status_code", response.status);
      return response;
    });
  }
}
