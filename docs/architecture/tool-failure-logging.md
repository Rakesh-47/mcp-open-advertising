# Tool Failure Logging

Reference for this subsystem. [CLAUDE.md](../../CLAUDE.md) keeps a short summary and links here.

Every tool invocation is captured by `InteractionLogger` (`packages/shared/src/utils/interaction-logger.ts`). On failure, the entry adds the upstream HTTP trail (method, URL, status, redacted request/response bodies, per-attempt durations) recorded by `executeWithRetry` via `http-request-recorder.ts`.

Record shape (JSONL): `{ type: "tool_failure", ts, sessionId, requestId, tool, platform, params (redacted), errorCode, errorMessage, errorData, upstream: [{ method, url, status, attempt, durationMs, requestBodyRedacted, responseBodyRedacted, requestHeadersRedacted, responseHeadersRedacted }] }`

Destination is chosen by `INTERACTION_LOG_MODE`:

| Mode     | When                                                     | Storage                                                            |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| `gcs`    | Hosted Cloud Run (default when `GCS_BUCKET_NAME` is set) | Instance-unique JSONL in GCS, flushed every 5s                     |
| `file`   | Self-host default                                        | Rotating JSONL at `~/.cesteral/interactions/`                      |
| `stdout` | Self-host with external log pipeline                     | Pino `info`/`error` line per entry — ship via any stdout log agent |

Hosted data is queryable in BigQuery via a JSON external table over `gs://<bucket>/<server-name>/interactions/*.jsonl`.

Redaction lives in **`secret-redaction.ts`**, shared by `http-request-recorder.ts` (which adds header redaction: Authorization, TTD-Auth, DeveloperToken, etc.) and `mcp-errors.ts`. The body/URL patterns cover bearer tokens plus `access_token`/`refresh_token`/`client_secret`/`api_secret`/`developer[_-]?token`/`password`/`assertion`/`id_token` in **both** JSON (`"k":"v"`) and form-urlencoded / query (`k=v`) shapes — the OAuth2 token-exchange and refresh bodies are `x-www-form-urlencoded`, which a `":"`-anchored pattern misses entirely. Response bodies are truncated at 8 KB.

The two used to be separate copies that drifted, and `mcp-errors.ts` held the weaker one: JSON-quoted keys only, no `=` form, no hyphen spelling, no URL handling — one of the four shapes the fleet's clients actually produce (sweep 2026-07-25, 02-F6/F7). `InteractionLogger.logFailure` also redacts `errorMessage` itself rather than trusting callers: `errorData` arrived sanitized while the message beside it, built by interpolating the failing URL or response body, did not (02-F5). **Add new patterns to `secret-redaction.ts` only** — a second copy is how this drifted the first time.
