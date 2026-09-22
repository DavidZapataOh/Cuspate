# Cuspate — working rules

## Language
Everything in this repository is written in English: code, identifiers, comments, tests, documentation, and commit messages.

## Comments
Minimal. Code explains what it does; a comment explains why, and only when the why is not obvious. Follow the documentation standard of the language in use (NatSpec on every external and public Solidity symbol, TSDoc on exported TypeScript symbols). No commented-out code, no changelogs in headers, no restating the line below.

## Follow upstream, do not invent
Implementations must read as though the upstream team wrote them. Before integrating anything — Monad, Uniswap v4, Chainlink CRE, Envio, wallet and funding providers — read that project's current documentation and reference repositories, and follow their conventions, naming and recommended patterns. Where upstream ships an example, match it. Verify against the documentation rather than from memory; these platforms change quickly.

## No over-engineering
Build what the product needs and nothing more. No speculative abstraction, no configuration nobody sets, no layers with a single implementation. Prefer deleting code to adding it. DRY and YAGNI both apply.

## No mocks in shipped code
Mocks and fakes exist only inside tests. Every path a user can reach is backed by real contracts, real networks and real data.

## Quality bar
Working is not the bar. Code must be clean, minimal and fast: measured gas budgets on contracts, measured load budgets on the interface, no dead code, no silent failure, typed errors, and tests that would catch the regression rather than merely cover the line.

## Git
Never run `git commit`, `git push`, or any command that writes to history. Prepare the change, then hand over a commit message in English.
