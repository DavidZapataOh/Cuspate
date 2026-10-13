# Resolution workflow

`resolver-proposer` is a Chainlink CRE workflow that proposes an event's figure to the resolver. It reads
the issuer's earnings release from SEC EDGAR, agrees on the figure across the network's nodes, and has the
network deliver a signed report to `CreProposer`, a receiver contract that posts the bond and proposes.

It is an additional proposer, never the only one. Anyone may still propose, dispute and settle under the
resolver's rules, and an event nobody resolves expires invalid on its own. The workflow proposes figures
only: it cannot see the fallback source, so it cannot know that no source has the figure.

## What one run does

1. Reads the event from the resolver and its registry, at the last finalized block. It goes on only if
   the event is sealed by the resolver's sealer under exactly the configured terms, can be public, and
   has no open proposal, no pending arbitration and no disputed proposal of this workflow's own.
2. Reads the issuer's 8-K feed and, earliest first, at most 3 filings under item 2.02 (results) from the
   day before the announcement, the first release that reports the configured quarter is read. Each node
   does this itself; the nodes must agree on the outcome.
3. Writes the report `(eventId, figure, decimals)` to the receiver with a gas limit of 500,000. Delivery
   was measured at about 332,000 on a fork of the production chain; the network charges the limit, so
   it is not padded further.

Every run logs one result, `resolver-proposer: <result>`, and returns it.

| Result | Meaning |
|---|---|
| `proposed:<figure>:<tx>` | The figure was proposed; the transaction hash follows. |
| `abstain:not-deployed` | The configuration names no resolver yet. Nothing is read. |
| `abstain:not-sealed` | The event is not sealed by the resolver's sealer. |
| `abstain:terms-mismatch` | The sealed terms are not the configured terms, byte for byte. |
| `abstain:too-early` | The announcement has not happened yet. |
| `abstain:proposed` | The open round already has a proposal. |
| `abstain:arbitration` | The event waits for the arbiter. |
| `abstain:own-disputed` | The open round follows this workflow's own disputed proposal; a person decides. |
| `abstain:not-filed` | No results filing is listed yet. Expected between the announcement and the filing. |
| `abstain:exhibit-not-found` | The filing's index names no single press release. |
| `abstain:unavailable` | EDGAR did not answer with the document: an error status, a rate limit, a timeout or a response over the size limit. |
| `abstain:period-not-found` | No listed release reports the configured quarter. |
| `abstain:figure-not-found` | The quarter's highlights state no non-GAAP figure. |
| `abstain:ambiguous` | The release's statements of the figure disagree, or nothing confirms it. |
| `abstain:precision` | The figure has more decimals than the threshold; comparing it would need rounding. |

An abstention costs nothing and the next run tries again. A run that throws, a write the receiver
refused, is a failure to look at.

## Schedule

Every ten minutes (`0 */10 * * * *`). Before the announcement a run makes four chain reads and stops;
after it, a run makes at most seven requests to EDGAR per node, far inside the platform's fifteen and
EDGAR's fair-access rate. The release is usually filed a few hours after the announcement, so the first
proposal comes within ten minutes of the filing.

## Configuration

`resolver-proposer/config.json`, validated when the workflow starts:

- `chainSelectorName`: the chain the resolver is on.
- `resolver`, `receiver`, `eventId`, `terms`: the deployed contracts, the event, and its terms exactly as
  sealed. Zero until deployment; the workflow abstains until they are set.
- `cik`, `period`: the issuer's SEC Central Index Key and the fiscal quarter the terms name.
- `userAgent`: a name and a reachable contact address. The SEC refuses requests that do not identify
  their sender. The committed address is a placeholder and must be a real contact before deployment.

The threshold's decimals and the earliest filing date are read from the chain, not configured.

## Secrets

None. EDGAR needs no credentials, so the workflow has no secrets file. The RPC endpoint is read from
`MONAD_RPC_URL` in the environment and never committed. A paid source would need a secret, and would be
added here.

## The receiver

`CreProposer` trusts one forwarder and one workflow, by its owner and name.

- **Forwarder.** The production KeystoneForwarder, which verifies the network's signatures. Never the
  simulation forwarder: anyone can route any report through it, so a receiver over it must not hold a
  bond worth taking or propose to a resolver that settles markets.
- **Funding.** The receiver posts each bond from its own balance, approving exactly one bond per
  proposal. Keep it funded for the proposals expected.
- **Sweep.** Anyone may call `sweep()` to send the bonds the resolver has credited to the receiver to the
  treasury. The balance kept for bonds stays.
- **Recover.** Only the treasury may call `recover(token, amount)` to take back the balance kept for bonds,
  when the workflow stops, or anything sent to the receiver by mistake.

## Redeploying and rotating keys

The receiver checks the workflow's owner and name, never its id, which changes with every update.

- **A new version** of the workflow, deployed under the same name by the same owner, is accepted by the
  same receiver.
- **The owner** is a multisig or smart account (`workflow-owner-address` in the project settings), so its
  signers rotate without the owner address changing.
- **A new owner or name** needs a new receiver.

## Building and testing

```
pnpm --filter cuspate-cre run build   # type-checks and compiles the workflow to WebAssembly
pnpm --filter cuspate-cre run test    # against EDGAR's documents, recorded under resolver-proposer/fixtures
```

Simulating against the network (`cre workflow simulate`) and deploying need a CRE account.
