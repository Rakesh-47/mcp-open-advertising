import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MsAdsRefreshAuthStrategy } from "../../src/auth/msads-refresh.js";
import type { MsAdsAuthAdapter } from "../../src/auth/msads-auth-adapter.js";

vi.mock("@cesteral/shared", async () => {
  const actual = await vi.importActual("@cesteral/shared");
  return {
    ...actual,
    fetchWithTimeout: vi.fn(),
  };
});

import { fetchWithTimeout } from "@cesteral/shared";
const mockFetch = vi.mocked(fetchWithTimeout);

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

const config = {
  clientId: "app-client-id",
  clientSecret: "app-client-secret",
  refreshToken: "seed-refresh-token",
  developerToken: "dev-token",
};

const accountHeaders = {
  "x-msads-customer-id": "cust-1",
  "x-msads-account-id": "acct-1",
};

// basis: MicrosoftDocs authentication-oauth-get-tokens.md, "Refresh token request details":
// the response carries a new access_token and a new refresh_token.
function tokenResponse(refreshToken = "rotated-refresh-token"): Response {
  return {
    ok: true,
    json: async () => ({
      access_token: "ms-access-token",
      expires_in: 3600,
      refresh_token: refreshToken,
    }),
  } as Response;
}

// basis: MicrosoftDocs customer-management-service/getuser.md Response JSON.
const getUserResponse = {
  ok: true,
  json: async () => ({ User: { Id: 777, UserName: "spike" }, CustomerRoles: [] }),
} as Response;

function mockTokenThenUser(refreshToken?: string): void {
  mockFetch.mockImplementation(async (url) =>
    String(url) === TOKEN_URL ? tokenResponse(refreshToken) : getUserResponse
  );
}

function tokenRequestBodies(): URLSearchParams[] {
  return mockFetch.mock.calls
    .filter(([url]) => String(url) === TOKEN_URL)
    .map(([, , , options]) => new URLSearchParams(String(options?.body)));
}

describe("MsAdsRefreshAuthStrategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes via Microsoft identity and validates the user", async () => {
    mockTokenThenUser();
    const strategy = new MsAdsRefreshAuthStrategy(config);

    const result = await strategy.verify(accountHeaders);

    expect(result.authInfo.authType).toBe("msads-refresh");
    expect(result.authInfo.clientId).toBe("777");
    expect(result.credentialFingerprint).toHaveLength(32);

    const [body] = tokenRequestBodies();
    expect(body!.get("grant_type")).toBe("refresh_token");
    expect(body!.get("refresh_token")).toBe("seed-refresh-token");
    expect(body!.get("client_id")).toBe("app-client-id");
    expect(body!.get("client_secret")).toBe("app-client-secret");
    expect(body!.get("scope")).toBe("https://ads.microsoft.com/msads.manage offline_access");

    const [userUrl, , , userOptions] = mockFetch.mock.calls[1]!;
    expect(userUrl).toContain("/User/Query");
    const headers = userOptions?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ms-access-token");
    expect(headers.DeveloperToken).toBe("dev-token");
  });

  it("uses the configured scope and omits an unset client secret", async () => {
    mockTokenThenUser();
    const strategy = new MsAdsRefreshAuthStrategy({
      ...config,
      clientSecret: undefined,
      // basis: BingAds Python SDK authorization.py SCOPE[(SANDBOX, MSA_PROD)].
      scope: "https://si.ads.microsoft.com/msads.manage offline_access",
    });

    await strategy.verify(accountHeaders);

    const [body] = tokenRequestBodies();
    expect(body!.get("scope")).toBe("https://si.ads.microsoft.com/msads.manage offline_access");
    expect(body!.has("client_secret")).toBe(false);
  });

  it("returns an adapter scoped to the requested account", async () => {
    mockTokenThenUser();
    const strategy = new MsAdsRefreshAuthStrategy(config);

    const result = await strategy.verify(accountHeaders);
    const adapter = result.platformAuthAdapter as MsAdsAuthAdapter;

    expect(adapter.customerId).toBe("cust-1");
    expect(adapter.accountId).toBe("acct-1");
    expect(await adapter.getAccessToken()).toBe("ms-access-token");
  });

  it("shares one token across sessions", async () => {
    mockTokenThenUser();
    const strategy = new MsAdsRefreshAuthStrategy(config);

    await strategy.verify(accountHeaders);
    await strategy.verify({ "x-msads-customer-id": "cust-2", "x-msads-account-id": "acct-2" });

    expect(tokenRequestBodies()).toHaveLength(1);
  });

  it("opens a tools-only session without account headers", async () => {
    mockTokenThenUser();
    const strategy = new MsAdsRefreshAuthStrategy(config);

    const result = await strategy.verify({});
    const adapter = result.platformAuthAdapter as MsAdsAuthAdapter;

    // Credentials are still validated; no account is selected.
    expect(result.authInfo.clientId).toBe("777");
    expect(adapter.customerId).toBe("");
    expect(adapter.accountId).toBe("");
  });

  it("throws when only one of the account headers is sent", async () => {
    const strategy = new MsAdsRefreshAuthStrategy(config);

    await expect(strategy.verify({ "x-msads-customer-id": "cust-1" })).rejects.toThrow(
      "X-MSAds-Account-Id"
    );
    await expect(strategy.verify({ "x-msads-account-id": "acct-1" })).rejects.toThrow(
      "X-MSAds-Customer-Id"
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when server credentials are not configured", async () => {
    const strategy = new MsAdsRefreshAuthStrategy({ developerToken: "dev-token" });

    await expect(strategy.verify(accountHeaders)).rejects.toThrow("MSADS_REFRESH_TOKEN");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reports an expired refresh token as needing re-authorization", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    } as Response);
    const strategy = new MsAdsRefreshAuthStrategy(config);

    await expect(strategy.verify(accountHeaders)).rejects.toThrow("invalid_grant");
  });

  it("fingerprints by account, independent of the token", async () => {
    const strategy = new MsAdsRefreshAuthStrategy(config);

    const fp1 = await strategy.getCredentialFingerprint(accountHeaders);
    const fp2 = await strategy.getCredentialFingerprint(accountHeaders);
    const other = await strategy.getCredentialFingerprint({
      "x-msads-customer-id": "cust-1",
      "x-msads-account-id": "acct-2",
    });

    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(other);
  });

  describe("refresh token file", () => {
    let dir: string;
    let refreshTokenFile: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "msads-refresh-"));
      refreshTokenFile = join(dir, "refresh-token.json");
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("saves the rotated token and uses it after a restart", async () => {
      mockTokenThenUser("rotated-1");
      await new MsAdsRefreshAuthStrategy({ ...config, refreshTokenFile }).verify(accountHeaders);

      await vi.waitFor(async () => {
        const stored = JSON.parse(await readFile(refreshTokenFile, "utf8"));
        expect(stored.refreshToken).toBe("rotated-1");
      });

      // A new process (new strategy) starts from the saved token, not the seed.
      mockFetch.mockClear();
      mockTokenThenUser("rotated-2");
      await new MsAdsRefreshAuthStrategy({ ...config, refreshTokenFile }).verify(accountHeaders);

      expect(tokenRequestBodies()[0]!.get("refresh_token")).toBe("rotated-1");
    });

    it("ignores a saved token once MSADS_REFRESH_TOKEN is replaced", async () => {
      mockTokenThenUser("rotated-1");
      await new MsAdsRefreshAuthStrategy({ ...config, refreshTokenFile }).verify(accountHeaders);
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(refreshTokenFile, "utf8")).refreshToken).toBe("rotated-1");
      });

      mockFetch.mockClear();
      mockTokenThenUser("rotated-new");
      await new MsAdsRefreshAuthStrategy({
        ...config,
        refreshToken: "new-seed-after-reconsent",
        refreshTokenFile,
      }).verify(accountHeaders);

      expect(tokenRequestBodies()[0]!.get("refresh_token")).toBe("new-seed-after-reconsent");
    });
  });
});
