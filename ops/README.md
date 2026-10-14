# Operations

The deployment runbook, the test network's price publisher, and the tools that open the test
network's markets. Every tool that writes to a chain is rehearsed on a fork first, and a broadcast is
refused unless a rehearsal of the same commit passed.

## Events

`events/<chain>.json` lists the earnings announcements a network trades, one event per issuer and
four conditions per event. Its `rules` say how every number in it is derived:

- **Thresholds.** The primary threshold is the consensus; the others are the consensus minus `m`,
  plus `m` and plus `2m`. A condition is met only if the reported figure is strictly above it.
- **Opening chance.** `1 / (1 + exp(1.1 k))` with `k = (threshold - consensus) / m`, to the cent, kept
  within `[0.05, 0.95]`. It is the yes-dollar's opening price.
- **Announcement.** After-close issuers announce at 16:00 New York time, 20:00Z until 1 November and
  21:00Z from 2 November; before-open issuers at 08:00 New York time.
- **Terms.** Rendered by `cuspate-shared`'s `renderTerms`, never written by hand; a unit test checks
  every condition's terms against the renderer and the 600-byte limit.

An event whose date the issuer has not confirmed (`dateSource.confirmed: false`) is never due, so no
window opens it until the manifest records the confirmation.

### Re-reading the consensus

Right before a window is opened, each of its events' consensus is read again from the source the
manifest names, and recorded:

```sh
node ops/src/consensus.ts                                  # every event, its consensus and its source
node ops/src/consensus.ts set tsla-q3-2026 0.45 2026-10-20 # moves the thresholds, keeping m
```

An event with a recorded market is sealed, so its consensus can no longer move. A re-read is committed
before the window's rehearsal: a broadcast seals what the manifest says at its commit.

## Opening a window

`src/open-markets.ts` opens every confirmed event announced in a window. For each condition it seals
the threshold from the sealer's Safe, creates the market, mints the treasury's collateral, and from the
treasury's Safe, in one batch through `MultiSendCallOnly`, registers the market with the hook, opens
its three pools at the feed's price and the opening chance, splits the collateral and mints the
liquidity positions, which the treasury's Safe owns. Each market is recorded under `markets` in the
network's record, from its receipts, as soon as it is open; a rerun skips what is already on chain.

```sh
# 1. a fork of the test network: prices mirrored, the window opened, its gas measured, the gate run
DEPLOY_NETWORK=testnet_rehearsal node ops/src/open-markets.ts --from <iso> --to <iso>
# 2. the window's prices on the test feed, if the publisher has not posted them yet
MONAD_RPC_URL=... MONAD_TESTNET_RPC_URL=... PUBLISHER_KEYSTORE=... PUBLISHER_PASSWORD_FILE=... \
  node ops/src/publisher.ts --symbols TSLA,META
# 3. the test network itself, from the same clean commit
DEPLOY_NETWORK=monad_testnet MONAD_TESTNET_RPC_URL=... \
  DEPLOY_KEYSTORE=~/.foundry/keystores/<deployer> DEPLOY_PASSWORD_FILE=<file> \
  node ops/src/open-markets.ts --from <iso> --to <iso> --broadcast
```

A window whose stocks have no price on the test feed from the last four days is refused before
anything is sent. The rehearsal's gate checks every market against its receipts and the chain, has a
user with only the faucet enter and exit one through the router, and indexes the rehearsal's blocks
with the network's indexer configuration, comparing every market, leg and pool with the chain. It
refuses when the deployer cannot pay the window plus a fifth, or the publisher or the keeper cannot
pay a week.

The windows, each opened after the previous one freezes, so the publisher posts as few symbols as it
can:

| Window | Events | `--from` | `--to` |
|---|---|---|---|
| 1 | TSLA, META | 2026-10-13T00:00:00Z | 2026-10-22T00:00:00Z |
| 2 | HOOD, MSFT, GOOGL | 2026-10-22T00:00:00Z | 2026-10-29T00:00:00Z |
| 3 | AAPL, AMD, WMT | 2026-10-29T00:00:00Z | 2026-11-20T00:00:00Z |

## MON

Measured on rehearsals of the three windows at 102 gwei. Monad charges the gas limit, so every figure
is limits. The deployer pays every seal, creation, mint and batch; the publisher posts every quarter
hour of the regular session, for the symbols with an unfrozen market only; the keeper's figure is a
budget of one correction a week per open market, not a measurement.

| Window | Transactions | Gas | MON |
|---|---|---|---|
| 1 (2 events) | 40 | 54.4M | 5.55 |
| 2 (3 events) | 60 | 82.1M | 8.37 |
| 3 (3 events) | 60 | 81.9M | 8.36 |

| Week (Mon-Sun) | Deployer | Publisher | Keeper budget |
|---|---|---|---|
| 12-18 Oct: window 1 opens | 5.55 | 1.2 (TSLA, META) | 1.2 |
| 19-25 Oct: TSLA, META freeze; window 2 opens | 8.37 | 2.4 | 1.8 |
| 26 Oct-1 Nov: HOOD, MSFT, GOOGL freeze; window 3 opens | 8.36 | 2.7 | 1.8 |
| 2-8 Nov: AAPL, AMD freeze | 0 | 1.7 | 1.8 |
| 9-15 Nov | 0 | 1.2 (WMT) | 0.6 |
| 16-22 Nov: WMT freezes | 0 | 0.9 | 0.6 |
| Total | 22.3 | 10.1 | 7.8 |

A post costs about 22k gas plus 66k per symbol. The publisher's balance covers its first two weeks; it
is topped up before each window's rehearsal, which refuses otherwise.

## Services

```sh
DEPLOY_NETWORK=monad_testnet MONAD_TESTNET_RPC_URL=... node ops/src/services.ts [--overwrite]
```

Generates, from the network's record and its sealed events:

- `indexer/config.<chain>.yaml`: the network's deployment from its first block, through HyperSync
  (`ENVIO_API_TOKEN`), with no endpoint read for history. Run with `ENVIO_CONFIG=config.<chain>.yaml`.
- `keeper/markets/<chain>.json`: every market with its event and its symbol, for the keeper's
  `KEEPER_MARKETS_FILE` with `KEEPER_CHAIN=<chain>`.
- `cre/resolver-proposer/config.<chain name>.json`: every event, its terms and announcement read from
  the registry's seal, delivered to the receiver, or to the report probe until the receiver exists.

A generated file that differs from what is committed is never replaced without `--overwrite`.
