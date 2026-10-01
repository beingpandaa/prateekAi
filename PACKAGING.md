# Building prateekAi for Windows

Use Windows x64, Node.js 24, and pnpm 11.19.0. The lockfile pins the Electron runtime and build dependencies. The installed application includes its runtime; end users do not need Node.js or pnpm.

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm test:profile-compat
pnpm test:ui
pnpm test:content
pnpm test:flow
pnpm package:portable
```

The default destination is `dist/prateekAi-win32-x64`. Packaging refuses an existing destination. To create another build, give it a new directory:

```powershell
node package-portable.cjs .\dist\prateekAi-review-2
```

The build stages fresh files, sets Windows executable version information and icons using the pinned `resedit` development dependency, verifies the metadata, and renames the completed staging directory into place. It never updates a running installation. Application assets are explicitly allowlisted; user profiles, credentials, tests, logs, and development dependencies are excluded. `build-manifest.json` records source hashes and runtime/build versions.

The executable is unsigned after its resources are changed. A distributable signed release requires signing the finished executable with the publisher's own certificate. Electron license notices remain in the portable folder. The original icon has editable SVG source, checked-in PNG/ICO files, and a deterministic generator: `pnpm build:icon`.

## Existing settings and credentials

The profile resolver selects, in order:

1. `PRATEEKAI_DATA_DIR`, when supplied as an absolute path.
2. The legacy `CALLSIDE_DATA_DIR` override.
3. `%APPDATA%\prateekAi` if its `settings.json` exists.
4. `%APPDATA%\Callside` if its `settings.json` exists.
5. `%APPDATA%\prateekAi` for a new installation.

An empty new directory does not hide an old setup. Existing profiles stay in place, including the encryption context and saved OAuth identities; there is no automatic copy, token extraction, or reauthorization. Close older running versions before opening the new build. A failed read or decryption disables saving so the original file remains recoverable. Unexpected external changes also block a stale write. Restore a valid profile and restart to recover; do not delete a profile merely to resolve an error.

`pnpm test:profile-compat` uses real Windows encrypted storage with synthetic credentials in an isolated temporary profile. It changes the application name between writing and reading, checks preserved identity/preferences, and removes only that test profile. It never opens a user's real saved credentials and makes no provider requests.

The runtime continues to support `CALLSIDE_TEST_OUT` as a compatibility alias where integrated with `PRATEEKAI_TEST_OUT`. Development and CI must always provide an isolated data directory before launching smoke tests. Never include an AppData profile in an archive or repository.

Repository: https://github.com/beingpandaa/prateekAi
