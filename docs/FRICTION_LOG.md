# DocSaathi: Friction Log

Real problems we hit while building an Alexa+ MCP add-on for the Build, Ship, Shape hackathon.
Format per entry: task · steps · expected vs actual · severity · workaround · suggestion.

Severity: **High** = blocked or likely to ship a bug · **Medium** = cost real time · **Low** = annoyance.

---

## 1. Which MCP spec version does Alexa+ actually speak?
- **Task:** Pick an MCP SDK version for a self-hosted Streamable HTTP server that Alexa+ can call.
- **Steps:** Read the hackathon rules ("2025-11-25 or later") and the Alexa+ MCP Toolkit overview ("supports the 2025-11-25 version"). Installed the current TypeScript SDK (`@modelcontextprotocol/server` 2.2.0).
- **Expected:** The current SDK targets the same version Alexa+ supports.
- **Actual:** SDK v2 implements spec **2026-07-28**, which removes sessions and the `initialize` handshake and replaces server-initiated elicitation with multi-round-trip results. The Alexa+ docs only mention 2025-11-25, so it was unclear whether a v2 server would work with Alexa+.
- **Severity:** High. A mismatch would silently break the integration.
- **Workaround:** Used `createMcpHandler(factory, { legacy: 'stateless' })` so one endpoint serves both eras. We verified it with a 2025-11-25 client and a 2026-07-28 client in `scripts/smoke.ts`.
- **Suggestion:** State the supported protocol versions (and whether 2026-07-28 is on the roadmap) on the Alexa+ MCP Toolkit overview page, and give an SDK/version matrix in the hackathon resources.

## 2. Confirm-before-booking pattern differs between spec versions
- **Task:** Ask the user "Shall I book it?" before making a real booking.
- **Steps:** Looked at MCP elicitation (`ctx.mcpReq.elicitInput`).
- **Expected:** One way to ask for confirmation that works for Alexa+.
- **Actual:** In SDK v2, `elicitInput` is deprecated and throws on 2026-07-28 requests. The replacement (`inputRequired`) does not exist for 2025-11-25 clients, and in stateless legacy mode elicitation is limited.
- **Severity:** Medium.
- **Workaround:** A two-step tool design that works for every client: `book_appointment` holds the slot and returns a confirm card, then `confirm_appointment(hold_id)` books it.
- **Suggestion:** Publish Alexa+ guidance on confirmations for bookings and purchases in MCP add-ons: whether Alexa+ asks natively, supports elicitation, or expects a two-step tool.

## 3. `toNodeHandler` + `express.json()` loses the request body
- **Task:** Mount the MCP handler in an Express app that also needs JSON bodies for other routes.
- **Steps:** `app.use('/mcp', toNodeHandler(handler))` after `app.use(express.json())`.
- **Expected:** Works like other Express middleware.
- **Actual:** Express's JSON parser has already drained the request stream. `toNodeHandler` ignores Express's third argument (`next`), so it never receives the parsed body.
- **Severity:** Medium. It is easy to miss, and the failure is confusing.
- **Workaround:** `app.all('/mcp', auth, (req, res) => nodeHandler(req, res, req.body))`.
- **Suggestion:** Show this exact pattern in the `@modelcontextprotocol/node` README Express example, or accept `req.body` automatically when present.

## 4. Existing Google Maps key: new Places API and Routes API return 403
- **Task:** Real travel times and real nearby clinics for "leave by" and "call to book".
- **Steps:** Tested Places API (New) `places:searchText` and Routes API `computeRoutes` with an existing project key.
- **Expected:** The same key works for the newer APIs.
- **Actual:** HTTP 403 for both. Legacy Geocoding, Places Text Search/Details and Distance Matrix work.
- **Severity:** Low (not Amazon's API, but it affects any Alexa+ add-on that needs maps).
- **Workaround:** Used the legacy web services, with offline distance estimates as a fallback.
- **Suggestion (Alexa+):** A location/travel-time capability for add-ons ("how far is this address from the customer's home?") would remove the need for every add-on to bring its own maps key.

## 5. No way for small providers to test against a real Alexa+ simulator
- **Task:** Show the add-on working "on the device it was built for".
- **Steps:** Read the MCP Toolkit docs (`alexa-ai deploy`, simulator) and the hackathon FAQ.
- **Expected:** A test path for hackathon entrants.
- **Actual:** The Category SDK, MCP Toolkit, CLI and Web Simulator are "in preview and available to select partners only".
- **Severity:** Medium.
- **Workaround:** Built our own Echo Show-style web host that renders the same MCP App screens.
- **Suggestion:** A time-boxed hackathon sandbox of the Alexa+ Web Simulator (even text-only) would let entrants prove real Alexa+ compatibility.

## 6. Stateless legacy MCP endpoints make browser hosts log red 405 errors
- **Task:** Build an MCP Apps host page (Echo Show simulator) that connects to our server from the browser.
- **Steps:** Browser `Client` with default version negotiation (`'legacy'`) against `createMcpHandler(..., { legacy: 'stateless' })`.
- **Expected:** A clean console.
- **Actual:** After `initialize`, the client opens the optional GET SSE stream, and on close it sends DELETE. The stateless legacy leg answers `405`, which the SDK handles correctly, but Chrome prints `Failed to load resource: 405` as a console **error**. This looks like a bug to anyone reviewing the page.
- **Severity:** Low.
- **Workaround:** The browser host pins the modern era (`versionNegotiation: { mode: { pin: '2026-07-28' } }`), which has no GET/DELETE session calls.
- **Suggestion:** Let legacy clients skip the GET stream when a server has advertised statelessness, or document this expected 405 in the client README.

## 7. npm 11 blocks esbuild's install script by default
- **Task:** `npm install -D tsx vitest`.
- **Expected:** Clean install.
- **Actual:** `npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts: esbuild`. Everything still worked, but the warning is alarming for beginners.
- **Severity:** Low.
- **Workaround:** None needed. We noted it here.
- **Suggestion:** Starter templates could include the `allowScripts` entry for esbuild.

## 8. The Alexa+ authentication pages contradict each other
- **Task:** Add account linking (OAuth 2.1) so Alexa+ can call DocSaathi's tools for one family.
- **Steps:** Read the MCP Toolkit Quickstart, Authentication, Account Linking and Certify pages, then built an authorization server to match.
- **Expected:** One clear list of what Alexa+ sends and expects.
- **Actual:** The pages disagree in four places:
  1. **Grant types.** Authentication describes two tiers: a `client_credentials` service token (scope `mcp:service`) for `initialize` and `tools/list`, then authorization code + PKCE for user tools. Account Linking says "Alexa+ add-ons support only the Authorization Code Grant."
  2. **Refresh tokens.** Account Linking says the token endpoint "must return a refresh token alongside every access token". Authentication says it "MUST NOT issue a refresh_token for client credentials grants".
  3. **The 401.** The Quickstart wants `401 Unauthorized` without a `WWW-Authenticate` header, and Authentication lists that header as "not supported". The MCP authorization spec says servers MUST send it, so following Amazon makes a server less standard for other MCP clients.
  4. **Token endpoint authentication** (`client_secret_basic` or `client_secret_post`) is given only for client credentials, not for the authorization code exchange. The redirect URIs are only in the Developer Hub, which hackathon entrants without preview access cannot open.
- **Severity:** High. A server built from one page can fail on the next.
- **Workaround:** DocSaathi supports every reading. Both grants work. Refresh tokens come with family tokens, never with service tokens. A service token can list tools but gets a plain 401 on `tools/call`, which is Alexa's cue to link. The 401 has no `WWW-Authenticate` header, and the protected resource metadata is at both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, so standard MCP clients still find it. Both client authentication methods are accepted, and redirect URIs come from `ALEXA_REDIRECT_URIS`. `npm run smoke:oauth` checks all of this, playing the part of Alexa+.
- **Suggestion:** Merge the auth rules into one checklist page that the others link to. Say whether the service-token tier is required, and publish the account-linking redirect URI pattern publicly so entrants can test without the Developer Hub.

## 9. Claude on Bedrock's new endpoint: which key, which permission, which fields?
- **Task:** Use Claude on Amazon Bedrock as the AI brain, with Anthropic's official SDK (`AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`, endpoint `bedrock-mantle.{region}.api.aws/anthropic`), from Mumbai (ap-south-1).
- **Steps:** Read the "Claude on Amazon Bedrock" page in Claude's docs and its legacy page, then the SDK's source code.
- **Expected:** One place that says which keys work with this endpoint, the IAM permission to grant, and how to get access to each model.
- **Actual:**
  1. **Keys.** The page shows Bedrock API keys only with the plain `Anthropic` client and a custom `baseURL`, and says "SigV4 signing requires `AnthropicBedrockMantle`". `AWS_BEARER_TOKEN_BEDROCK` appears only on the legacy page. Yet the `AnthropicBedrockMantle` source accepts `apiKey` and reads `AWS_BEARER_TOKEN_BEDROCK` itself (sent as `Authorization: Bearer`).
  2. **Permission.** The IAM action is `bedrock-mantle:CreateInference`, a different service prefix from the `bedrock:InvokeModel` that the classic Bedrock API and most tutorials use, so a policy copied from a tutorial does not cover it.
  3. **Access.** Claude Haiku 4.5 is "Open", but Claude Haiku 5.5 says only "See Access". Mumbai is listed with the "Global" endpoint only.
  4. **Fields.** The page does not say whether newer request fields, such as `output_config.effort`, work on this endpoint.
- **Severity:** Medium. A first-time AWS user can lose an evening to a 403 or a 404 with no hint which part is wrong.
- **Workaround:** DocSaathi accepts an IAM access key (preferred, since Polly needs it too) or a Bedrock API key. [docs/AWS_SETUP.md](AWS_SETUP.md) gives the exact policy. `npm run check:aws` makes one real call per model and turns 401, 403, 404, 429 and network errors into plain next steps. A model without access rests and the next one answers (Haiku 5.5, then Haiku 4.5, then Groq, then the rules). If Bedrock rejects an optional field, the request is sent again without it.
- **Suggestion:** One table on the page: endpoint, client class, key types, environment variables, IAM action, regions, and what "See Access" means and how to request it.

## 10. The Amazon Polly client for Node speaks HTTP/2 by default
- **Task:** Test Alexa's Polly voice (Kajal) without an AWS bill, against a pretend Polly server on this computer.
- **Steps:** `new PollyClient({ region })` from `@aws-sdk/client-polly` v3, with `AWS_ENDPOINT_URL_POLLY` pointing at a local HTTP server.
- **Expected:** Plain HTTP/1.1 requests, like the other AWS SDK v3 clients we used.
- **Actual:** "Protocol error". The Polly client is built with an HTTP/2 request handler (it has a streaming operation), so it cannot talk to an HTTP/1.1 server, and the error does not say why. Some office and campus networks block HTTP/2 too.
- **Severity:** Low.
- **Workaround:** `requestHandler: new NodeHttpHandler({ connectionTimeout: 4000, requestTimeout: 10_000 })` from `@smithy/node-http-handler`. After a failure, the voice also rests for 5 minutes, so the browser voice answers at once instead of waiting for Polly to time out again.
- **Suggestion:** State the HTTP/2 default in the Polly client README, or use HTTP/1.1 for the commands that do not stream.
