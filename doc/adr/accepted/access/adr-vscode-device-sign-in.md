# ADR — VS Code sign-in with device tokens

Status: Accepted

## Context

The PAODO Workspaces VS Code extension must reach an instance whatever its UI login is: `basic`, or any identity-aware proxy (Cloudflare Access, Google IAP, oauth2-proxy…). None of the existing credentials fits. The CLI key is admin-level and cannot start runs. A workspace key covers a single agent. The browser login cannot be scripted, and behind a proxy VS Code cannot reach the UI host at all. The extension is a public client, so it cannot keep a secret of its own.

## Decision

The extension signs in with the OAuth authorization code flow and PKCE, approved in the browser behind the instance's usual login. It receives a pair of device tokens, kept in the same credential store as every other PAODO-issued key.

- **Approval**: the extension listens on `127.0.0.1` on a port the OS picks, then opens `/connect/vscode?code_challenge=…&code_challenge_method=S256&state=…&port=…` on the UI host. The page relies only on the request gate's UI login, whichever mode, and reads no proxy-specific claim. One **Authorize** click calls `POST /api/connect/authorize` (UI login only, CSRF-checked), which returns `http://127.0.0.1:<port>/callback?code&state&api`: the loopback redirect of RFC 8252, with host and path fixed by the app and only the port (1024–65535) from the request. **Cancel** sends `error=access_denied` to the same callback. The listener checks `state`, sends the browser to the app's home page and closes. No machine name is sent or stored.
- **Probe**: before opening the browser, the extension calls `GET /api/connect/vscode` on the UI host with no credential. The route is exempt from the UI login and answers only `{ "paodo": true }`, so a mistyped address is reported in VS Code, not on a "Not found" page. A login in front (401/403, or a redirect to another origin) cannot be told apart, so the browser opens as before. A 5xx is reported as the instance being down.
- **API host**: `api` is `WORKSPACE_API_DOMAIN`, or the UI origin when none is set. Everything VS Code calls goes there, never through the UI proxy. Behind an identity-aware proxy, the instance therefore needs an API host for VS Code to connect.
- **Code**: 32 random bytes, kept in memory as a SHA-256 hash, single use, valid 60 s, bound to an S256 challenge (`plain` is refused). A wrong verifier burns the code. A second redemption revokes the device the first one produced (`lib/infra/security/connectCodes.ts`).
- **Tokens**: `POST /api/connect/token` accepts `grant_type` `authorization_code` or `refresh_token` and answers with OAuth field names. The access token (`dat_<deviceId>_…`) lives 8 hours. The refresh token (`drt_<deviceId>_…`) is replaced on every use. A device ends 30 days after its approval, whatever its use, and the extension warns 3 days before.
- **Two windows refreshing at once**: the refresh token just replaced answers `409` with `reason: "superseded"` for 60 s, without revoking anything, and the extension reads back the tokens the other window saved. Replayed after that grace, it depends on whether the new pair was ever used: if not, its answer was lost on the way (network drop, sleep), so this is the same VS Code retrying and it gets a fresh pair, once only: the undelivered pair becomes the one just replaced, so the old token is spent and the undelivered one, presented after the fresh pair was used, revokes the device; if it was, the old token can only be a copy, so the device is revoked. The first use of each pair is saved, so a restart does not forget it. This is refresh-token rotation with reuse detection as RFC 9700 describes it, with the lost-response allowance identity providers use.
- **Storage**: `kind: "device"` in `credentialStore.ts`, one `device:<id>` record per signed-in VS Code, holding only hashes and expiry times. The `device` record with no subject is the instance-wide switch, "Allow VS Code connections", off by default. Turning it off deletes every device record, which signs out every VS Code; while it is off, the connect page, the token exchange and every device token are refused.
- **Gate**: a `dat_` bearer token is checked against `deviceAccessPolicy.ts`, a deny-by-default list kept separate from the CLI key's. So far it holds `GET` and `DELETE /api/connect/session`, `GET /api/connect/events` (a live stream of change signals, ids only, for the pickers and running LEDs; it checks the device again at every 15-second keepalive and ends once the sign-in is gone), `GET /api/workspaces` for the workspace picker, `GET` and `POST /api/workspaces/{id}/conversations` for the session picker and New Chat, and for one conversation `GET /api/workspaces/{id}/conversations/{convId}` (its transcript), `POST /api/workspaces/{id}/chat` (send a message, or re-attach to a run in progress, as the web app does; like the events stream, it checks the device at every keepalive and detaches once the sign-in is gone, leaving the run going) and `POST /api/workspaces/{id}/conversations/{convId}/stop`. Pull and Push add `GET` and `PUT /api/workspaces/{id}/files/transfer` (the CLI's tar transfer), and `DELETE /api/workspaces/{id}/files/content` (what a push deletes). A conversation id must be lowercase hex and dashes, as a UUID is, which keeps `conversations/initial` out. A `drt_` token is never accepted as a bearer. A refused `dat_` token does not count toward the per-IP lockout shared with the UI login: it is a lost sign-in (expired, revoked, access off), not a guess, since its secret is 256 random bits. `POST /api/connect/token` is exempt, because its body is the credential, and it is rate limited per IP (`connectToken`). The Caddyfile forwards the session, token and events routes, New Chat and the three conversation routes, with no read deadline on the events and chat streams; the two pickers and the three file routes are already forwarded for the CLI, and `gatewayAllowlist.test.ts` compares the gateway with both policies.
- **Settings**: one switch, `GET`/`PATCH /api/settings/vscode-access`, UI only. There is no device list: the switch is the way to sign everyone out.

## Consequences

- Works with any UI login and any proxy in front of it, and in every VS Code build: no `vscode://` link, so no browser or VS Code prompt, only the one Authorize click.
- Only a 60-second, single-use code crosses the browser, and it is useless without the verifier, which never leaves VS Code.
- A stolen access token works for at most 8 hours. A stolen refresh token is detected as soon as either party uses it after the other. Every device ends 30 days after sign-in, and turning the switch off signs out every VS Code at once.
- Device records share `.credentials.json` with the other keys and are excluded from backups like them.
- Codes are lost on restart; only sign-ins that were mid-way are affected.
- Does NOT stop: someone with the unlocked machine and its keychain using the tokens until the device is revoked or expires.
- VS Code running remotely or in a browser (SSH, vscode.dev, code-server) cannot receive the loopback redirect; a page showing a code to paste would cover it later.

## Alternatives considered

- **A long-lived token that expires after 30 days without use**: simpler, but a stolen token in regular use never expires.
- **The CLI key, or CLI key plus workspace keys**: admin-level, or one key per agent.
- **A token pasted from Settings**: the same server work, but clumsier, and the token passes through the clipboard.
- **Device code flow**: works in browser-based VS Code, but the user types a code, which is easier to social-engineer. Kept as a fallback.
- **Reusing the proxy's browser cookie**: tied to one proxy.

## Notes

- Related: [adr-unified-credential-store.md](adr-unified-credential-store.md), [adr-platform-cli-access-policy.md](adr-platform-cli-access-policy.md), [adr-ui-authentication-edge-gate.md](adr-ui-authentication-edge-gate.md).
- Standards: RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), RFC 8252 (native apps), RFC 9700 (security best current practice: refresh-token rotation, exact redirects).
- Next steps widen `deviceAccessPolicy.ts` (and the Caddyfile) for workspace details, messages, chat and files.
