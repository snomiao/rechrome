# Relay fix: Storage.getCookies over the tab debugger session

Source change (in the snomiao/playwright fork, `packages/playwright-core/src/tools/mcp/`):

- `browserModel.ts`: add `anyAttachedSessionId()` returning any attached tab's sessionId.
- `cdpRelayV2.ts` `handleCDPCommand`: intercept `Storage.getCookies` with no sessionId and
  forward it to that tab session (`this._model.sendCommand(tabSessionId, 'Storage.getCookies', params)`).

The extension bridge exposes only page-level CDP; Playwright's `context.cookies()` sends
browser-level `Storage.getCookies` (no sessionId), which the tab debugger can't do — so
`read-cookie` failed with "could not read the cookie". Routing it to a page session returns the
context-wide cookie jar (HttpOnly included).

This PR ships the rebuilt `vendor-src/playwright-core.tgz` (the deploy artifact; its
`lib/coreBundle.js` carries the two edits). The fork commit still needs pushing by someone with
snomiao/playwright write access, then the submodule pin bumped.
