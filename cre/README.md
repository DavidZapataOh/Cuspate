# Resolution workflow

`resolver-proposer` is a Chainlink CRE workflow that proposes an event's figure to the resolver. It reads
the issuer's earnings release from SEC EDGAR, agrees on the figure across the network's nodes, and has the
network deliver a signed report to `CreProposer`, a receiver contract that posts the bond and proposes.

It is an additional proposer, never the only one. Anyone may still propose, dispute and settle under the
resolver's rules, and an event nobody resolves expires invalid on its own. The workflow proposes figures
only: it cannot see the fallback source, so it cannot know that no source has the figure.

## What one run does

1. Finds the issuers with an event due: announced, and announced less than 14 days ago. Nothing due, no
   read at all. When more than one issuer is due, each run serves one, and the next run the next.
2. Reads the issuer's events from the resolver and its registry, at the last finalized block: two reads
   for the resolver's registry and sealer, then two per event. An event goes on only if it is sealed by
   the resolver's sealer under exactly the configured terms and announcement, can be public, and has no
   open proposal, no pending arbitration and no disputed proposal of this workflow's own.
3. If any event is open, reads the issuer's 8-K feed and, earliest first, at most 3 filings under item
   2.02 (results) from the day before the announcement; the first release that reports the configured
   quarter is read, once for all of the issuer's events. The filing's index page names each document's
   type, and the press release is the one typed `EX-99.1`, whatever the filer named the file. Each node
   does this itself; the nodes must agree on the outcome. Every request accepts a gzip answer and the
   workflow decompresses it: the platform refuses a response body over 250 KB, and a release is larger.
   Measured on 2026-10-13 in a simulation under the production limits, Micron's fourth-quarter release
   is 357,009 bytes, refused uncompressed, and about 17 KB compressed; the largest of the issuers'
   recorded releases is 36 KB compressed. Decompression stops at 2 MB, several times any release, so a
   small body cannot expand without bound.
4. For each open event, scales the figure to the event's threshold and writes the report
   `(eventId, figure, decimals)` to the receiver with a gas limit of 500,000. Delivery was measured at
   about 332,000 on a fork of the production chain; the network charges the limit, so it is not padded
   further.

An issuer carries at most 6 events, so a run stays within the platform's fifteen chain reads (two, then
two per event) and its ten writes; it makes at most seven requests to EDGAR, of the fifteen allowed.

Every run logs its outcome, `resolver-proposer: <result>`, one line per event of the issuer it served,
written `<ticker> <eventId>: <result>`, and returns them.

| Result | Meaning |
|---|---|
| `proposed:<figure>:<tx>` | The figure was proposed for the event; the transaction hash follows. |
| `idle:nothing-due` | No configured event is due. Nothing is read. |
| `abstain:not-deployed` | The configuration names no resolver yet. Nothing is read. |
| `abstain:not-sealed` | The event is not sealed by the resolver's sealer. |
| `abstain:terms-mismatch` | The sealed terms or announcement are not the configured ones, byte for byte. |
| `abstain:too-early` | The announcement has not happened yet. |
| `abstain:proposed` | The open round already has a proposal. |
| `abstain:arbitration` | The event waits for the arbiter. |
| `abstain:own-disputed` | The open round follows this workflow's own disputed proposal; a person decides. |
| `abstain:not-filed` | No results filing is listed yet. Expected between the announcement and the filing. |
| `abstain:exhibit-not-found` | The filing's index names no single document typed `EX-99.1`. |
| `abstain:unavailable` | EDGAR did not answer with the document: an error status, a rate limit, a timeout, a response over the size limit, or a compressed body that does not decompress within 2 MB. |
| `abstain:period-not-found` | No listed release reports the configured quarter: its own label for the quarter and the quarter's end date are not both there. |
| `abstain:figure-not-found` | The release does not state the figure where the issuer's reader reads it. |
| `abstain:ambiguous` | The release's statements of the figure disagree, or nothing confirms it. |
| `abstain:precision` | The figure has more decimals than the threshold; comparing it would need rounding. |

An abstention costs nothing and the next run tries again. A run that throws, a write the receiver
refused, is a failure to look at.

## Schedule

The workflow runs every 10 minutes (`0 */10 * * * *`), which is also the rotation step. The release
is usually filed a few hours after the announcement, so the first proposal comes within ten minutes of
the filing, or within twenty when two issuers report the same day.

## Issuers

Each issuer has a reader: where its release states the figure, and a second place in the same release
that must agree. Issuers that publish an adjusted EPS settle on it, because it is the figure their
results are compared with; issuers that publish none settle on the GAAP figure, and their markets never
claim to measure an expectation.

| Issuer | Ticker | Figure | Read from | Confirmed by |
|---|---|---|---|---|
| Tesla, Inc. | TSLA | non-GAAP diluted EPS | the financial summary, in the column headed by the quarter | the same row in the reconciliation |
| Meta Platforms, Inc. | META | GAAP diluted EPS | the quarter's financial highlights | the income statement |
| Robinhood Markets, Inc. | HOOD | GAAP diluted EPS | the highlights bullet | the income statement |
| Microsoft Corporation | MSFT | non-GAAP diluted EPS | the quarter's GAAP to non-GAAP table | the constant-currency table |
| Alphabet Inc. | GOOGL | GAAP diluted EPS | the highlights bullet | both diluted net income per share rows |
| Apple Inc. | AAPL | GAAP diluted EPS | the opening paragraph | the income statement |
| Advanced Micro Devices, Inc. | AMD | non-GAAP diluted EPS | the non-GAAP sentence | the non-GAAP reconciliation |
| NVIDIA Corporation | NVDA | non-GAAP diluted EPS | the GAAP and non-GAAP sentence | the non-GAAP reconciliation row |
| Walmart Inc. | WMT | non-GAAP diluted EPS (adjusted EPS) | the headline | the reconciliation for the quarter's three months |
| Micron Technology, Inc. | MU | non-GAAP diluted EPS | the quarter's highlights | the reconciliation |

A release whose layout changes so that a reader no longer finds both places abstains; a person can
still propose the figure under the resolver's rules, and the reader is updated against the new release.

## Configuration

`resolver-proposer/config.json`, validated when the workflow starts:

- `chainSelectorName`, `isTestnet`: the chain the resolver is on, by the platform's name for it, and
  whether it is a test network.
- `resolver`, `receiver`: the deployed contracts. Zero until deployment; the workflow abstains until
  they are set.
- `issuers`: the events, grouped by issuer: its ticker, the fiscal quarter its events name, and each
  event's id, terms and announcement, copied from the chain once sealed, never re-rendered. The issuer's
  CIK and the figure its markets settle on come from its profile.
- `dueWindowSeconds`: how long after its announcement an event stays due, 14 days unless set.
- `userAgent`: a name and a reachable contact address. The SEC refuses requests that do not identify
  their sender. It is the project's own address, `ops@cuspate.xyz`, a monitored mailbox; a test keeps
  the committed sender on the project's domain, never a person's address.

Each threshold's decimals and the earliest filing date are read from the chain, not configured.

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
- **The owner** is the address linked to the CRE organization that deploys the workflow. Its key is kept
  by the operator and used only for the workflow registry.
- **A new owner or name** needs a new receiver.

## The test network

The workflow runs on the test network under the `monad-testnet` target, against the test network's
resolver, with the configuration `ops/src/services.ts` generates from the network's record:
`resolver-proposer/config.monad-testnet.json`. The receiver is fixed to the workflow's owner and name
at construction, so it is created only after a real delivery has shown them:

1. **The probe.** The test network's deployment includes `TestnetReportProbe`, a receiver that only
   records what a forwarder delivers: who delivered it, and the workflow's id, owner, name and report
   id as the forwarder packs them. Until the receiver exists, the generated configuration delivers to
   the probe.
2. **Deploy the workflow** from the CRE organization's linked owner, which registers it on the
   Workflow Registry and is a transaction on Ethereum mainnet:
   `cre workflow deploy resolver-proposer --target monad-testnet`.
3. **Read the first delivery.** The workflow reports only for an event that is due and whose figure it
   found, so the first delivery follows the first announcement. The probe's `ReportReceived` log
   carries the owner and the name; the forwarder must be the test network's KeystoneForwarder,
   `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`.
4. **Create the receiver.** Set `creProposer.workflowOwner` in the test network's manifest to the owner
   the probe recorded, and run the deployment runbook: it creates `CreProposer` and mints it fifty bonds
   in test dollars. Regenerate the configuration, which now delivers to the receiver, and redeploy the
   workflow. Events still unproposed are proposed on its next run.

The end-to-end run checks the same path on a local chain with the test network's id, through its
simulation forwarder: the probe records the simulator's owner and name, and the receiver fixed to them
proposes.

## Building and testing

```
pnpm --filter cuspate-cre run build   # type-checks and compiles the workflow to WebAssembly
pnpm --filter cuspate-cre run test    # against EDGAR's documents, recorded under resolver-proposer/fixtures
pnpm --filter cuspate-cre run e2e     # the whole path, against a local chain and EDGAR itself
CRE_E2E_NETWORK=testnet pnpm --filter cuspate-cre run e2e TSLA   # the same, on the test network's id
```

The end-to-end run starts a local chain whose id is the production chain's, copies the production
chain's simulation forwarder onto it, deploys the registry, the resolver and a receiver that trusts the
simulator's workflow owner, and seals, for each issuer's pinned release, two thresholds on its figure
and one event whose configured terms differ. It then runs the compiled workflow with
`cre workflow simulate --broadcast` against that chain and reads the outcome from the chain alone: both
thresholds proposed by the receiver at the release's figure, two bonds posted, and nothing for the
third event. The simulator reports success even when a receiver reverts, so its log is never taken as
evidence. The run needs a CRE account key in `CRE_API_KEY`, Foundry, and the contracts built; without
the key it skips, and in CI it fails as not evaluated. A pinned release that has left the issuer's feed
fails the run with a request to update the pin in `e2e/pinned.ts`.

Deploying needs a CRE account with deploy access and the workflow owner's key.
