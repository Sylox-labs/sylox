# web/

An npm workspace holding the JS/TS side of the repo, separate from the Rust/Soroban contracts at the repository root.

- `web/landing` — the marketing landing page (Next.js, static export).
- `web/shared/ui` — the design system (tokens, fonts, risk-band/contrast helpers, and shared components) that `web/landing` and future app code both import from.

Both are declared as workspaces in the repo-root `package.json`. Install and run everything from the repo root, not from inside `web/landing`:

```bash
npm install
npm run build -w web/landing
npm run dev -w web/landing
```

## Deployment (Railway)

`sylox-landing` on Railway serves `web/landing` at `sylox.xyz` / `www.sylox.xyz`. Build/deploy settings live in the repo-root `railway.json` (config-as-code), not only in the Railway dashboard:

- **Root Directory:** cleared (the service builds from the repo root, not a subdirectory) — this has to stay cleared for `npm run build -w web/landing` to resolve the workspace at all. `web/landing` is no longer a Railway root directory in its own right.
- **Build command:** `npm run build -w web/landing`
- **Start command:** `npm run serve -w web/landing` — not `npm run start`. `start` runs `next start`, which only works for server-mode Next.js; this app builds with `output: "export"` (a static site), which `next start` explicitly refuses to serve. `serve` runs `serve out -p ${PORT:-3000}` (the `serve` package), the correct way to serve a static export.
- **Watch paths:** `/web/landing/**`, `/web/shared/ui/**`, `/package.json`, `/package-lock.json`, `/railway.json`, `/railpack.json` — a push that only touches contracts, docs, or other repo paths won't trigger a redeploy.

### Why Root Directory has to be cleared

Before the design-system extraction, `web/landing` was a fully standalone Next.js app with its own `package-lock.json`, and Railway's Root Directory was set to `web/landing` so the build ran as if that directory were the whole repo. Once `web/landing` became an npm workspace member (its dependency on `@sylox/ui` is resolved via the root `package.json`'s `workspaces` field and the root lockfile), a build rooted inside `web/landing` can no longer see the workspace graph — `npm run build -w web/landing` needs to run from somewhere that actually has a `workspaces` field to resolve `-w` against. Clearing Root Directory makes Railway check out the full repo and run the build from there instead.

A leftover `web/landing/railway.json` from the pre-workspace setup (old `NIXPACKS` builder, a bare `npm run build` with no workspace flag) is deleted as of this change — it was dead config that no longer matched how the service actually deploys, and its presence made the real root-cause of a broken deploy harder to find.

### Why there's also a root-level `railpack.json`

Clearing Root Directory has a second consequence: Railway's builder (Railpack) now scans the *entire* repo to auto-detect what kind of project this is, and the repo root also has `rust-toolchain.toml` for the Soroban contracts. Railpack picked Rust over Node, built a Rust-only environment with no npm installed at all, and the build failed with `npm: not found`. `railpack.json` at the repo root (`{"provider": "node"}`) forces the Node provider explicitly instead of relying on auto-detection, which Railpack's own build log confirms (`Using provider Node from config`).
