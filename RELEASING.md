# Releasing

This repository ships to users through GitHub (pnpm `github:` spec); there is no npm publish step.

1. Bump `version` in `package.json` (the build marker in `lib/index.js` reads it automatically) and keep
   `locale/zh.json` / `locale/en.json` keys in sync (the test suite enforces it).
2. Add an entry to `CHANGELOG.md`.
3. Run `npm test` (or `node test/index.test.mjs` directly).
4. Commit and push to `main`.
5. Tag and push the tag:

   ```bash
   git tag v1.0.3
   git push origin v1.0.3
   ```

6. Create a GitHub Release for the tag, pasting the CHANGELOG entry as notes.
   Pinned installs then work:

   ```bash
   dsh plugin --profile web add github:MMMichelsa/dsh-plain-approvals#v1.0.3
   ```

Keep the layout intact: the package entry must stay at `lib/index.js`, tests at `test/index.test.mjs`,
and the bundle patch at `cordis.patch.yml` (declared in `package.json` under `dsh.bundle.patch`).
