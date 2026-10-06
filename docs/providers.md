# Selling through AgentPay: the provider guide

A provider is anyone who sells a paid tool, an API or an agent's work to other people's agents. You register as a provider on the dashboard (Provider tab), list a tool, and AgentPay sends you requests from paying agents.

## What a request looks like

AgentPay `POST`s JSON to your endpoint.

**Body:**
```json
{ "callId": "4c1f…", "input": { "topic": "solar panels" } }
```
For quoted tools the body also has `quote: { id, ref }`, and for async tools it has `callbackUrl`.

**Headers:**

| Header | Meaning |
|---|---|
| `x-agentpay-phase` | `call`, or `quote` for a price request |
| `x-agentpay-id` | The call id, or the quote request id. Use it to make your handling idempotent |
| `x-agentpay-tool` | Your tool's slug |
| `x-agentpay-held-cents` | Cents AgentPay holds for this call. You're paid up to this, minus the 10% platform fee, when it succeeds |
| `x-agentpay-agent` | A stable id for the paying agent |
| `x-agentpay-test` | `true` for test keys: the money is pretend and you won't be paid. Return sample data if you like |
| `x-agentpay-timestamp`, `x-agentpay-key-id`, `x-agentpay-signature` | The signature (below) |
| `authorization` | The header you set when listing the tool, if any |

## Verify every request

AgentPay signs each request with Ed25519. Verify it before doing any work. That tells you:
- the request came from AgentPay
- which agent is paying
- that the money is held
- that nothing was changed on the way

```ts
import { fetchAgentPayKeys, verifyAgentPayRequest } from "@winsley-jeune/agentpay-verify";

const keys = await fetchAgentPayKeys("https://your-agentpay-server");
const call = verifyAgentPayRequest({ headers: req.headers, rawBody, keys, expectedTool: "my-tool" });
```

How to use it:
- **Use the raw body,** byte for byte as received.
- **Old requests are rejected:** more than 5 minutes is refused by default.
- **Key rotation:** cache the keys, and refetch when you see an unknown key id.

**What's signed,** one line each, in this order:

```
agentpay-v1
<phase>
<id>
<tool>
<heldCents>
<agentId>
<timestamp>
<sha256 of the body, hex>
```

The signature is base64url Ed25519 over that text. The public keys (PEM) are at `/.well-known/agentpay-keys.json`.

## Pricing

| Type | How the price is set |
|---|---|
| `per_call` | A fixed price per call |
| `per_unit` | Price × the `unitsField` in the input. Answer with an `X-AgentPay-Units` header if you used fewer, and you're paid for those |
| `quoted` | You set a price per task, up to the `priceCents` you list as the maximum |

### Quoted tools

Before calling, the buying agent asks for a price. You get a request with `x-agentpay-phase: quote` and this body:

```json
{ "phase": "quote", "quoteRequestId": "…", "input": { … } }
```

Answer with the price:

```json
{ "priceCents": 300, "description": "3 logo drafts", "expiresInSeconds": 900, "ref": "your-own-id" }
```

What happens next:
- **Validity:** the quote is good once, for the same input, until it expires (60 seconds to 1 hour; 15 minutes by default).
- **Price limit:** a price above your listed maximum is refused.
- **The call:** when the agent calls, the body includes `quote: { id, ref }` and exactly the quoted price is held. The agent's owner may have to approve the price first.

## Answering later: async jobs

List the tool with mode **async** (`"mode": "async"`, optionally `"maxJobSeconds"`: 60 to 86400, default 3600).

1. Your endpoint answers **`202 Accepted`** quickly. The request includes `callbackUrl` and an `x-agentpay-job-token` header. Keep the token secret.
2. The money stays **held** while you work. The agent sees `running` and checks with `get_job`.
3. When you're done, post the result:

   ```
   POST <callbackUrl>/complete
   Authorization: Bearer <job token>
   { "result": { … }, "units": 3 }
   ```

   You're charged out at the held amount, or fewer units for per-unit tools.
4. If you can't do it:

   ```
   POST <callbackUrl>/fail
   Authorization: Bearer <job token>
   { "error": "…" }
   ```

   The money goes back to the buyer.
5. **No answer by `maxJobSeconds`** means the hold is released and a late `/complete` is refused. Answer within the time you listed.

An async tool may also answer `200` with the result straight away, and it's settled like a normal call.

## Getting paid

**Earnings:** a successful call adds the charge minus the platform fee to your provider balance (dashboard, Provider tab).

**Payouts:**
- **Connect Stripe first.** On the Provider tab, choose **Connect Stripe**. Stripe collects and checks your details and bank account; AgentPay never sees them.
- **Paying out:** **Pay out** transfers your earnings to your Stripe account, and Stripe pays them to your bank on your payout schedule. You can also be paid automatically whenever earnings reach an amount you choose.
- **If something goes wrong:** a transfer that fails, or that Stripe reverses, goes back to your earnings.

## What you can't sell

Tools in restricted categories can't be listed or called:
- adult content
- medicine and pharmacies
- weapons
- drugs
- alcohol
- tobacco
- gambling
- gift cards, crypto and money transfers

See `src/policy.ts`.
