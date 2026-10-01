# Cuspate

## Commands

```sh
pnpm install
pnpm build
pnpm test
pnpm fmt
pnpm lint
```

```sh
tools/ci.sh                 # every gate, exactly as the pipeline runs them
tools/ci.sh <gate>          # one gate
tools/test.sh <selection>   # unit, fuzz, invariant or fork
```

Building and testing require no secret and no credential. The fork selection reads a public
endpoint, so the full test command needs network access; every other gate runs without it.
