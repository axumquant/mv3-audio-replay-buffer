# Contributing

Thanks for considering a contribution! This library was extracted from a production Chrome extension that needed durable audio buffering across MV3 service-worker restarts. The reliability bar is high — please respect that.

## Ground rules

1. **No plaintext audio on disk.** Encryption is on by default; disabling it requires `{ encrypt: false }` and is for testing only.
2. **No breaking changes to the public API without a major bump.** Storage layout (`dbName`, `frameStoreName`, schema versions) is part of the API — bumping `dbVersion` is a breaking change.
3. **Every behavior change needs a Vitest test.** `fake-indexeddb` is configured in `tests/setup.ts`.
4. **No new dependencies without discussion.** This library has zero peer deps deliberately.

## Dev setup

```bash
git clone https://github.com/axumquant/mv3-audio-replay-buffer.git
cd mv3-audio-replay-buffer
npm install
npm run build       # tsc — outputs to dist/
npm test            # vitest run
```

## Useful commands

```bash
npx tsc --noEmit                  # typecheck src
npx tsc -p examples/tsconfig.json # typecheck examples against the public API
npx vitest run                    # one-shot tests
npx vitest                        # watch mode
```

## Reporting issues

Open a GitHub issue with:

- Browser + version (Chrome canary / stable / Edge / etc.)
- Whether the bug is reproducible on a freshly-created buffer or only after restart
- A `console.log` of `await buffer.status()` at the point of failure
- Anything from the offscreen-document DevTools error tab

For **security issues**, see [SECURITY.md](./SECURITY.md) — don't open a public issue.

## Pull requests

1. Fork, branch from `main`.
2. Write a failing test FIRST.
3. Implement the fix.
4. Verify: `npx tsc --noEmit && npx vitest run` must both pass.
5. Add a `[Unreleased]` line to `CHANGELOG.md`.
6. Tag `@JUNX-10010` for review.

## Code style

- TypeScript strict mode. `any` requires a `// reason: ...` comment.
- All public types live in `src/types.ts`.
- Buffer logic is in `src/buffer.ts` and MUST NOT import from `chrome.*`. The point of this library is to be testable in Node.
- Storage/crypto layers are split (`src/indexeddb.ts`, `src/crypto.ts`) so they can be replaced independently.
