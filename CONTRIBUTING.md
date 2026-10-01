# Contributing

Use Node.js 24 and the pnpm version pinned in package.json. Install with
`pnpm install --frozen-lockfile` and run `pnpm test`, `pnpm test:ui`,
`pnpm test:content`, and `pnpm test:flow` on Windows.

`master` is the checked baseline. Work on a separate branch/worktree and open
a pull request into master. Never commit credentials, personal candidate
profiles, recordings, diagnostic exports, installed dependencies, or builds.
Use synthetic fixtures in automated tests. Offline tests must not spend API
credits or read a real Windows user profile. Live testing is a separate,
explicitly bounded activity; record unverified acceptance gates honestly.

Do not force-push shared branches. Keep behavior changes and their meaningful
regressions in the same commit. A passing mock test does not prove live speech
recognition, answer correctness, or screen-share exclusion.
