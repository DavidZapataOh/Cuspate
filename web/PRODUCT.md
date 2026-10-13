# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js (App Router) with wagmi and viem for the chain, and Privy for sign-in, embedded wallets and sponsored gas.
Lives in `web/` of this pnpm workspace; contracts, the resolution workflow, the indexer and the keeper are sibling
workspaces the interface reads from and writes to.

## Users

Primary: anyone, in any country, who holds dollars on chain (USDC) and wants to buy a stock only if something
specific happens, for example that the company beats its earnings, without an options account and without knowing
derivatives. Most retail investing apps in the world offer no listed options, and where they exist they require
approval and jargon. This person has never traded an option; the product must make sense to them in one read.

Secondary: hackathon judges and technical traders who evaluate the mechanism. They read the precise version in the
documentation, never in the product itself.

## Product Purpose

Cuspate lets a person buy a stock only if a condition is met. They put in dollars before a scheduled event. If the
condition is met, they own the shares; if it is not, they get their dollars back. Until the announcement they can
undo the decision and take their dollars out.

Success: a first-time visitor understands what they are buying, what each outcome pays, what it costs and how to
undo it, without being told, and completes a position with one signed action.

## Positioning

A conditional purchase of a real tokenized stock, settled on chain: the shares in one world, the dollars in the
other, both priced live and adding up to the real price. It is not a bet that pays a fixed amount and not an option
with a premium and a strike: the holder ends with the actual shares or their own dollars. The condition is sealed on
chain before the event, so nobody can move it afterwards.

## Operating Context

- Chain: Monad mainnet. The first underlying is Micron (aMU, a tokenized share issued by Anchored); the first event is
  its fiscal Q1 2027 earnings. Settlement asset: USDC on Monad.
- Sign-in with email creates an embedded wallet; people who already have a wallet can connect it. Gas for calls to
  Cuspate's own contracts is sponsored, within a per-user daily cap and a monthly budget; other transactions are paid
  by the user.
- Funding from other chains: USDC or USDT from the major chains arrives as USDC on Monad through an intents service,
  inside the app.
- Lifecycle of a market: the threshold is sealed publicly; positions open; trading freezes at the announcement; the
  figure is proposed on chain (an automated Chainlink workflow is one proposer) and can be challenged during a window;
  then holders redeem. A market that cannot be settled resolves invalid and returns each holder's share pro rata.
- Each market has a fixed size cap, set at creation; raising it means a new market.

## Capabilities and Constraints

- Market view with both outcomes side by side and their sum checked against the real price; an order ticket in plain
  language for both cases; a position view with the countdown and the undo; resolution and redemption; funding;
  disclosures; an advanced page for splitting and merging; a comparison against the equivalent listed option.
- Undo is possible until the freeze, which is the announcement time; the copy states that exact time.
- Fees: no product fee. The fee shown is what the quote actually pays (the pools' fee), computed, in the same place
  as the benefit.
- The comparison never republishes exchange option prices without a licence: it cites a published implied move with
  its source and offers a calculator for a price the user brings; a licensed live source may replace this later.
- Interface language: English only.
- Plain language everywhere in the product. Banned in the interface: conditional token, split, merge, AMM, liquidity,
  oracle, leg, derivative, leverage, APY. The one exception is the advanced split and merge page, which may use the
  precise terms after a plain explanation.
- Every number shown is read from the chain or the indexer and recomputed on load; nothing is hard-coded.

## Brand Commitments

- Name: Cuspate in running text, CUSPATE only in the wordmark. Domain: cuspate.xyz. Contact: ops@cuspate.xyz.
- Tagline: "Buy it only if."
- Mark: a solid disc cut by a thin line of negative space, off centre 72/28 and tilted about 12 degrees; never 50/50
  (a symmetric cut reads as a coin toss). One colour per use. The wordmark is a wide-tracked geometric capital
  grotesque whose A has no crossbar and is cut by the same line. Both are to be redrawn as exact SVG.
- Motion as the distinctive asset: entering a position slides the small part of the disc along the cut (320ms,
  ease-out); undoing slides it back (320ms, ease-in-out) and settles by 1px; resolving fades the losing part out in
  600ms. No confetti, glows or bursts. Reduced motion: opacity only.
- Dark, warm ground; cream text, never pure white. Obsidian #14110E, cream #F2E9DC (text at 80-85%), one accent
  amber #C8873F reserved for the brand and the primary action, stone #A79B8F as the warm neutral.
- The two outcomes are two states of one object: cream for "if they beat", stone for "if they don't". Never red and
  green, and amber never marks an outcome.
- Banned: purple or violet, mint or neon green, mesh gradients, glassmorphism, glows, particle fields, the dark
  background with a single neon accent. No Inter or Space Grotesk; monospace only for addresses and hashes. One sans
  family for the interface, body at 17-18px minimum, tabular figures for prices, amounts and countdowns. Starting
  candidate to validate with real renders: Schibsted Grotesk.
- Voice: disarming clarity. Calm and explanatory, for someone who has never traded an option. Precise, not dense;
  warm; reversible. Copy promises nothing the product does not do end to end today, states fees beside the benefit,
  says how every decision is undone, and never uses hype ("to the moon", rocket emoji) or private-banking horizons.

## Evidence on Hand

- Deployed and tested contracts, the resolution workflow, the indexer and the keeper in this repository. The
  resolution workflow has read the real figure from the issuer's filing (Q4 FY2026 non-GAAP diluted EPS, 33.42) in a
  simulation under production limits.
- No users, testimonials, trading volume or press yet. Do not invent any.
- The mark and wordmark exist only as raster direction; no vector yet.

## Product Principles

1. Understood in one read: the two outcomes, what each pays and the cost are visible before any action.
2. Nothing hidden: the sealed threshold and when it was sealed, the freeze countdown, who resolves and how long a
   challenge lasts, and the risks are on screen, not in fine print.
3. Every decision says how it is undone, and until when.
4. The sum must add up: the two outcomes are shown summing to the real price, which is the proof there is no trick.
5. Plain words in the product, precise words in the documentation.

## Accessibility & Inclusion

WCAG 2.2 AA at minimum; the brand palette's text contrasts are 6:1 or better on the ground. Outcomes are never told
apart by colour alone. Errors always carry an icon and text. Motion respects reduced-motion preferences. Body text
17-18px minimum.
