# Product feedback

Answers to the five Devpost product feedback questions, for every developer tool, API and SDK DocSaathi uses.
The detailed problems, with steps to reproduce and suggestions, are in the [friction log](FRICTION_LOG.md).

## 1. Which developer tools, APIs, and SDKs did you use and for what?

> **Status of the AWS parts (23 Oct, before the deadline):** both are live on our account. Amazon Bedrock is the brain: Claude
> returned "not available for this account", so DocSaathi uses `openai.gpt-oss-120b` through Bedrock's OpenAI-compatible endpoint,
> signed with the same IAM key. Amazon Polly's Kajal voice speaks Hindi and English. The demo video was recorded earlier, with the
> Groq brain and the browser voice.

| Tool, API or SDK | What DocSaathi uses it for |
|---|---|
| **Alexa+ MCP Toolkit documentation** (overview, quickstart, authentication, account linking, certification, local inspector) | The rules DocSaathi is built to: Streamable HTTP, protocol 2025-11-25, OAuth 2.1 account linking with PKCE, the service token, tool latency under 500 ms. The toolkit itself is invite-only, so Alexa+ is simulated in our web app, as the rules allow. |
| **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`, `client`, `express`, `node`) | The DocSaathi MCP server (15 tools). One endpoint serves spec 2025-11-25 (what Alexa+ speaks) and 2026-07-28 through the SDK's era routing. Bearer-token checks (`verifyBearerToken`), RFC 9728 metadata, DNS-rebinding guards. The simulator's "Alexa" is an MCP client over Streamable HTTP. |
| **MCP Apps** (`@modelcontextprotocol/ext-apps`) | The Echo Show screen: doctor cards, free times, the confirm card, the booking, reminders and the emergency card, in a double-iframe sandbox (`AppBridge`). The map picture is an app-only tool (`visibility: ["app"]`). |
| **Amazon Bedrock** (Claude through Anthropic's Bedrock SDK; `openai.gpt-oss-120b` through Bedrock's OpenAI-compatible endpoint, SigV4-signed) | The AI brain that understands Hindi, English and Hinglish and chooses DocSaathi's MCP tools, with Claude Haiku 5.5 and Haiku 4.5 as its backup. Our own safety rules stay outside the model. |
| **Amazon Polly** (`@aws-sdk/client-polly`, voice **Kajal**, neural) | Alexa's voice in the simulator: Kajal speaks both Hindi and Indian English. Answers are cached, with a daily character limit. |
| **AWS account, IAM and Billing** | A new AWS account in India, the hackathon credit, and the setup guide for an IAM user limited to Bedrock and Polly ([AWS_SETUP.md](AWS_SETUP.md)). |
| **Groq API** (OpenAI-compatible chat with tool calling) | A second AI brain for development and a fallback when Bedrock cannot answer. |
| **Google Maps Platform** (Geocoding, Places Text Search, Distance Matrix, Static Maps, Directions; legacy web services) | Real clinics, hospitals, chemists, labs and Jan Aushadhi shops near the family; live travel times and the "leave by" time; map pictures. |
| **Chrome Web Speech API** (SpeechRecognition `hi-IN` and `en-IN`, speechSynthesis) | Listening in the simulator, hands-free mode, "roko" to interrupt, and the voice when Polly is off. |
| **UHI specifications** (India's Unified Health Interface, NHA, core 0.7.1) | Signed search, select, init, confirm and status messages (ed25519 over a BLAKE2b-512 digest) to a local UHI test network of clinics. |
| **Node.js 24** (built-in `node:sqlite`), **Express 5**, **Zod 4**, **TypeScript** | The server, the family's memory and records, input checks. |
| **Vite + vite-plugin-singlefile**, **Vitest**, **Playwright** (with the installed Chrome) | Single-file pages for the MCP Apps sandbox, unit tests, and browser checks of every screen. |

## 2. What worked well?

- **MCP SDK era routing.** `createMcpHandler(factory, { legacy: 'stateless' })` let one `/mcp` endpoint serve both the 2025-11-25 clients Alexa+ uses and 2026-07-28 clients. We test both in `npm run smoke`.
- **MCP Apps.** Following the `basic-host` example, the double-iframe sandbox worked on the first try. App-only tools (`visibility: ["app"]`) are a clean way to let a screen fetch a map picture without the AI ever seeing the tool.
- **The Alexa+ add-on guidance for screens** (readable across the room, everything on the commit screen, confirm before acting) gave clear design rules, and our screens follow them.
- **Tool calling with structured results.** Returning `structuredContent` next to a short spoken line let the same tool result drive Alexa's voice, the screen and our own safety checks.
- **Amazon Polly's Kajal voice** fits Indian families on paper: one voice for Hindi and for Indian English.
- **IAM policies can be scoped to two services**, and the zero-spend budget template, so an app can get AWS access without fear of a large bill.
- **Google's legacy web services** (Geocoding, Places Text Search, Distance Matrix) gave good data for Indian addresses and areas.

## 3. What needs work?

- **Bedrock model access is a guessing game.** On our new account, Claude Haiku 4.5 returned *"not available for this account"* with
  no reason and no link, and Claude Haiku 5.5 *"does not exist"* under the documented ID. Open-weight `openai.gpt-oss-120b` worked at
  once through the OpenAI-compatible endpoint. A clear page that says which models an account can use, and why not, would save hours.
- **Kajal, Polly's Indian voice, is not offered in Mumbai (ap-south-1),** and `DescribeVoices` with `LanguageCode=hi-IN` hides her
  unless `IncludeAdditionalLanguageCodes` is set, because her first language is Indian English. Both cost us time on deadline night.

- **Alexa+ authentication docs contradict each other** in four places (only authorization code vs a client-credentials service tier; refresh tokens always vs never; a 401 with or without `WWW-Authenticate`; client authentication method). We supported every reading. Details: friction log entry 8.
- **No public Alexa+ test path.** The MCP Toolkit, the CLI and the Local Inspector need preview access, and the account-linking redirect URIs are only in the Developer Hub. A public sandbox, or even a published redirect URI pattern, would let every entrant test against the real thing. (Friction log entry 5.)
- **Which MCP spec Alexa+ speaks.** The docs say 2025-11-25; the current SDK speaks 2026-07-28, where elicitation is deprecated. A version matrix and guidance on confirmations ("Shall I book it?") for add-ons would help. (Entries 1 and 2.)
- **Alexa+ in India.** Alexa+ launched in India on 16 Sep 2026 with Hindi, but the developer toolkit, its docs and its examples are US-only. An India sandbox and Hindi examples would bring Indian developers in.
- **Bedrock for Claude: which key and which permission.** The docs and the SDK disagree on Bedrock API keys versus IAM keys and on the IAM action for the new endpoint. (Entry 9.)
- **Polly's Node client defaults to HTTP/2**, which failed behind some networks; forcing HTTP/1.1 fixed it. (Entry 10.)
- **AWS onboarding for a new account in India** took about two weeks: the account was suspended until documents were verified, and some regional sign-in endpoints timed out on a home connection. A **Free plan account cannot redeem the hackathon credit** until it is upgraded to the paid plan, which entrants learn only when the code is refused.
- **Google Maps:** an existing key returns 403 for the new Places and Routes APIs until each is enabled separately. (Entry 4.)
- **Web Speech in Hindi:** recognition stops after short silences and phones cannot listen while the page speaks, so "roko" (stop) works only on desktop.

## 4. How was your onboarding experience (zero to hello world)?

- **MCP SDK:** about an hour from `npm install` to a tool answering over Streamable HTTP. The v2 package split (server, client, express, node) took a little reading.
- **MCP Apps:** about half a day to the first screen inside a sandboxed iframe, mostly understanding the host-to-sandbox handshake.
- **Alexa+:** we never reached "hello world" on a real Echo, because the toolkit is invite-only. We built to the documentation and simulated Alexa+ in a web page.
- **AWS:** slow for a new account in India because of the identity checks (about two weeks); after that, IAM, Budgets and the Polly console were quick. Bedrock model access for partner models depends on the account plan, which is not obvious from the console.
- **Groq and Google Maps:** minutes.

## 5. Would you build with these devices and services again?

**Yes.** MCP with MCP Apps is the right shape for Alexa+ add-ons: one server, a voice answer and a screen, testable with any MCP client. We would put DocSaathi on a real Echo Show the day the Alexa+ toolkit opens to developers in India. We would keep Amazon Bedrock as the brain and Amazon Polly's Kajal voice, because Indian families talk in Hindi, English and both at once.
