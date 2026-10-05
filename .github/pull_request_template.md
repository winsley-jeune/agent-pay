## What and why

## Checklist
- [ ] `npm run typecheck` and `npm test` pass
- [ ] Money paths keep the ledger balanced (tests check `ledgerTotal(db) === 0`)
- [ ] Anything that gives an agent more authority needs a passkey approval, with `describeApproval` and `approvalTerms`
- [ ] New agent actions write to the why log
- [ ] README / docs updated
