# Contributing

Thanks for helping. AgentPay handles money, so changes are held to a careful standard. This page explains how to make one.

## Set up

Needs Docker and Node 20+.

```sh
npm install
npm run db:up        # Postgres on localhost:5433 (also creates the test database)
cp .env.example .env
npm run seed         # demo provider, tools and an owner with $20 test credits
npm run dev          # http://localhost:8787
```

Before opening a pull request:

```sh
npm run typecheck
npm test             # needs the database running
```

## Rules for changes that touch money

- **Amounts are integer cents.** Every balance comes from the append-only, double-entry ledger (`src/ledger.ts`). Never store a balance.
- **Every spend takes the owner's wallet lock first**, then any envelope's. Keep that order.
- **Every new path that holds money settles it before returning.** Tests should check that `ledgerTotal(db) === 0`.
- **Anything that gives an agent more authority needs a passkey approval.** That covers funding an envelope, a buy mandate, unfreezing and unlocking the vault. Anything that only takes authority away doesn't: denying, freezing, closing, revoking.
- **Approvals:** a new approval kind needs a `describeApproval` line and `approvalTerms`. Both are what the owner signs.
- **New kinds of agent action** should write to the why log (`src/audit.ts`).
- **Restricted categories** (`src/policy.ts`) can be widened. Narrowing them needs a strong reason in the pull request.

## Style

Match the surrounding code: small modules, plain SQL, short comments that explain why. Owner-facing wording should be plain and specific.

## Licensing

By contributing, you agree that your contribution is licensed under the license of the files you change. That's AGPL-3.0-only by default, and MIT for `packages/mcp`, `plugins/agentpay` and files with an MIT SPDX header. See [LICENSING.md](LICENSING.md).

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
