# AgentPay request verification

AgentPay signs every request it sends to a paid tool, or to an agent that sells its work. This small library checks a request really comes from AgentPay before you start work. It tells you:
- which agent is paying
- how much is held for the call
- that the body wasn't changed

```sh
npm install @winsley-jeune/agentpay-verify
```

```ts
import express from "express";
import { fetchAgentPayKeys, verifyAgentPayRequest } from "@winsley-jeune/agentpay-verify";

const keys = await fetchAgentPayKeys("https://your-agentpay-server"); // cache; refetch on "unknown_key"
const app = express();
app.post("/my-tool", express.raw({ type: "application/json" }), (req, res) => {
  const call = verifyAgentPayRequest({ headers: req.headers, rawBody: req.body, keys, expectedTool: "my-tool" });
  // call.heldCents is held for you; call.agentId identifies the paying agent; call.test means pretend money.
  const { input } = JSON.parse(req.body.toString());
  res.json({ answer: 42 });
});
```

Verify against the **raw body** exactly as received; re-serialized JSON won't match. Requests older than 5 minutes are rejected.

For the full provider guide (async jobs, prices quoted per task), see [docs/providers.md](https://github.com/winsley-jeune/agent-pay/blob/master/docs/providers.md).

MIT licensed.
