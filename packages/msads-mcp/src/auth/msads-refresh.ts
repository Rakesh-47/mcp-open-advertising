import { readFile, rename, writeFile } from "node:fs/promises";
import type { Logger } from "pino";
import type { AuthStrategy, AuthResult, OAuth2RefreshTokenCredentials } from "@cesteral/shared";
import {
  classifyOAuth2RefreshFailure,
  extractHeader,
  fetchWithTimeout,
  fingerprintCredentials,
  OAuth2RefreshAdapterBase,
} from "@cesteral/shared";
import { MsAdsAccessTokenAdapter } from "./msads-auth-adapter.js";

const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/**
 * Production scope (MicrosoftDocs `authentication-oauth-get-tokens.md`). Sandbox with a
 * normal Microsoft account uses `https://si.ads.microsoft.com/msads.manage offline_access`
 * (BingAds Python SDK `authorization.py`, `(SANDBOX, MSA_PROD)`).
 */
export const MSADS_PRODUCTION_SCOPE = "https://ads.microsoft.com/msads.manage offline_access";

/**
 * Exchanges a Microsoft identity refresh token for access tokens. Microsoft returns a
 * new refresh token on each refresh and expects the old one to be discarded, so
 * rotations are passed to `onRefreshTokenRotated`. Caching and single-flight refresh
 * come from OAuth2RefreshAdapterBase. `appId` / `appSecret` are the Azure app
 * registration's client ID and secret (secret empty for a public client).
 */
export class MsAdsRefreshTokenProvider extends OAuth2RefreshAdapterBase<OAuth2RefreshTokenCredentials> {
  constructor(
    credentials: OAuth2RefreshTokenCredentials,
    scope: string,
    onRefreshTokenRotated?: (newRefreshToken: string) => Promise<void>
  ) {
    super({
      platformName: "MsAds",
      credentials,
      onRefreshTokenRotated,
      requestToken: async (refreshToken) => {
        const body = new URLSearchParams({
          client_id: credentials.appId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope,
        });
        if (credentials.appSecret) {
          body.set("client_secret", credentials.appSecret);
        }

        const response = await fetchWithTimeout(MICROSOFT_TOKEN_URL, 10_000, undefined, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw classifyOAuth2RefreshFailure(
            "MsAds",
            response.status,
            response.statusText,
            errorBody
          );
        }
        return (await response.json()) as {
          access_token?: string;
          expires_in?: number;
          refresh_token?: string;
        };
      },
    });
  }
}

export interface MsAdsRefreshConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** File that keeps the latest rotated refresh token across restarts. */
  refreshTokenFile?: string;
  scope?: string;
  developerToken?: string;
  customerApiBaseUrl?: string;
  logger?: Logger;
}

/** Contents of `refreshTokenFile`; `seedHash` ties it to the MSADS_REFRESH_TOKEN it came from. */
interface StoredRefreshToken {
  seedHash?: string;
  refreshToken?: string;
}

/**
 * Microsoft Ads auth for one server-held Microsoft login (manager-account model).
 *
 * The server holds the refresh token and the developer token; callers only choose
 * the account with X-MSAds-Customer-Id / X-MSAds-Account-Id. One token provider is
 * shared by all sessions, so the token is refreshed about once an hour, not once per
 * session.
 *
 * A session opened without either account header can only list tools: its API
 * calls are refused by MsAdsHttpClient.
 *
 * Any caller that can reach the server can use every account linked to that
 * login — run it on a private network only.
 */
export class MsAdsRefreshAuthStrategy implements AuthStrategy {
  private tokenProvider?: Promise<MsAdsRefreshTokenProvider>;

  constructor(private readonly config: MsAdsRefreshConfig) {}

  async verify(headers: Record<string, string | string[] | undefined>): Promise<AuthResult> {
    const { clientId, refreshToken, developerToken } = this.config;
    if (!clientId || !refreshToken || !developerToken) {
      throw new Error(
        "MCP_AUTH_MODE=msads-refresh requires MSADS_CLIENT_ID, MSADS_REFRESH_TOKEN and MSADS_DEVELOPER_TOKEN"
      );
    }

    const { customerId, accountId } = this.resolveAccount(headers);
    this.tokenProvider ??= this.createTokenProvider(clientId, refreshToken);
    const tokenProvider = await this.tokenProvider;

    const adapter = new MsAdsAccessTokenAdapter(
      () => tokenProvider.getAccessToken(),
      developerToken,
      customerId,
      accountId,
      this.config.customerApiBaseUrl
    );

    await adapter.validate();

    return {
      authInfo: {
        clientId: adapter.userId,
        authType: "msads-refresh",
      },
      platformAuthAdapter: adapter,
      credentialFingerprint: fingerprintCredentials(customerId, accountId),
    };
  }

  async getCredentialFingerprint(
    headers: Record<string, string | string[] | undefined>
  ): Promise<string | undefined> {
    try {
      const { customerId, accountId } = this.resolveAccount(headers);
      return fingerprintCredentials(customerId, accountId);
    } catch {
      return undefined;
    }
  }

  private resolveAccount(headers: Record<string, string | string[] | undefined>): {
    customerId: string;
    accountId: string;
  } {
    const customerId = extractHeader(headers, "x-msads-customer-id") ?? "";
    const accountId = extractHeader(headers, "x-msads-account-id") ?? "";
    // Neither header: a tools-only session (e.g. the gateway's tools/list).
    if (customerId && !accountId) {
      throw new Error("Missing required X-MSAds-Account-Id header");
    }
    if (accountId && !customerId) {
      throw new Error("Missing required X-MSAds-Customer-Id header");
    }
    return { customerId, accountId };
  }

  /**
   * Starts from the stored rotated token when it was derived from the current
   * MSADS_REFRESH_TOKEN; a new MSADS_REFRESH_TOKEN (after re-consent) wins over it.
   */
  private async createTokenProvider(
    clientId: string,
    seedToken: string
  ): Promise<MsAdsRefreshTokenProvider> {
    const { refreshTokenFile, logger } = this.config;
    const seedHash = fingerprintCredentials(seedToken);

    let startToken = seedToken;
    if (refreshTokenFile) {
      try {
        const stored = JSON.parse(await readFile(refreshTokenFile, "utf8")) as StoredRefreshToken;
        if (stored.seedHash === seedHash && stored.refreshToken) {
          startToken = stored.refreshToken;
        }
      } catch {
        // No stored token yet.
      }
    }

    const saveRotatedToken = refreshTokenFile
      ? async (rotated: string): Promise<void> => {
          try {
            const stored: StoredRefreshToken = { seedHash, refreshToken: rotated };
            const tmpFile = `${refreshTokenFile}.tmp`;
            await writeFile(tmpFile, JSON.stringify(stored), { mode: 0o600 });
            await rename(tmpFile, refreshTokenFile);
          } catch (err) {
            logger?.warn(
              { err },
              "Could not save the rotated Microsoft Ads refresh token; it is kept in memory only"
            );
          }
        }
      : undefined;

    return new MsAdsRefreshTokenProvider(
      { appId: clientId, appSecret: this.config.clientSecret ?? "", refreshToken: startToken },
      this.config.scope ?? MSADS_PRODUCTION_SCOPE,
      saveRotatedToken
    );
  }
}
