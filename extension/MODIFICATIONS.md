# Rechrome extension modifications

Derived from microsoft/playwright, Apache-2.0. Upstream extension baseline:
`bb6c00957` (extension 0.2.1); audited fork revision: `62472742d`.

Modified by rechrome contributors:

- `manifest.json`: version and tab-group permission for the fork.
- `src/background.ts`, `src/connectedTabGroup.ts`, `src/pendingConnection.ts`,
  `src/relayConnection.ts`: concurrent clients, client tab groups, shorter titles,
  and recovery from stalled relay connections.
- `src/ui/connect.tsx`: client name forwarding on token-bypass connections and
  recovery from a stalled extension service worker.
- `vite.config.mts`, `vite.sw.config.mts`: ship licensing documents and retain
  modification notices in generated bundles through `licensePlugin.ts`.

Generated JavaScript and the manifest in the shipped extension incorporate these
changes. Upstream copyright and license notices remain applicable. Rechrome's
root MIT license does not replace the Apache-2.0 terms for inherited code.
