# Extension licensing and release preparation

The Playwright extension is Apache-2.0, independently of rechrome's MIT license.
The extension distribution includes `LICENSE`, upstream attribution in `NOTICE`,
`MODIFICATIONS.md`, and `THIRD_PARTY_NOTICES.txt` with full MIT texts for bundled
React, React DOM, and Scheduler. These dependencies were checked against the
installed packages and the Vite module graph for both UI and service-worker builds.

The vendored extension's `licensePlugin.ts` emits these documents on both builds,
adds modification banners to JavaScript, and fails if a bundled npm dependency is
unreviewed or its version/license no longer matches the notice file. After a
dependency update, review its license and refresh the notice text before building.
Keep the legal files when copying `packages/extension/dist/` into `extension/`.

Before a Chrome Web Store release:

- Commit and push the vendored fork changes, then update the rechrome submodule pin.
- Replace upstream-facing names and logos with rechrome branding; acknowledge
  Playwright without implying Microsoft endorsement. Apache-2.0 grants no trademark license.
- Obtain our own store listing ID/key and update client/relay defaults consistently.
  The existing manifest key identifies the upstream Playwright extension.
- Rebuild and verify the extension, including the isolated token-bypass tests.
- Review store permissions, privacy disclosures, and the final uploaded archive.

The licensing changes alone do not publish the extension or complete store review.
