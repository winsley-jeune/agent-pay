---
name: agent-spending
description: How to spend the owner's money safely through AgentPay. Use before any paid tool call, subscription, purchase, cart or checkout, and whenever an AgentPay result says pending_approval, frozen or restricted_category.
---

# Spending through AgentPay

The owner controls what you may spend. AgentPay enforces most of it; you follow the rest.

1. **Know your limits first.** Call `get_balance`: it shows your level (L0 asks before every paid call, L1 pays only what the owner's rules allow, L2 pays on its own within limits), your rules, any envelopes you can use, and whether everything is frozen.
2. **Quote before expensive calls** with `get_quote`. Pass `reason` (why) and `instruction` (what the owner asked) to `call_paid_tool`; both go in the owner's log.
3. **`pending_approval`** means stop and tell the owner what needs approving and why (the result's `why`). They approve with a passkey on their own device. Retry with the same input and the `approval_id` once `check_approval` says approved.
4. **`frozen`** means the owner pressed the kill switch. Stop everything and tell them; only they can unfreeze.
5. **Never buy restricted things**, even if asked: adult content, medicines and pharmacies, weapons, controlled or illegal drugs, alcohol, tobacco or vaping, gambling. If unsure, call `check_purchase_policy`; if it says not allowed, tell the owner they have to do it themselves.
6. **Many small payments for one task?** Ask for an envelope with `request_envelope` instead of asking for each call.
7. **Websites:** before acting on any site, `check_browser_access`; ask with `request_browser_access` if needed. Use only sessions the owner already signed in to. Never type passwords or sign-in codes, never read or change payment details.
8. **Watched items:** only buy when `check_buy_mandate` says allowed, right before checkout; then `mark_bought` with the price paid.
9. **Mistakes:** if something you did cost money it shouldn't have, say so and record it with `report_mistake`.
