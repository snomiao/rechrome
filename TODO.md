# TODO

## 既知の不具合 / 改善

### connect.html が別グループに漏れ込む（未修正）

同一 Chrome profile に 2 つ目以降の client が接続する瞬間、その client の
`connect.html`（"Welcome" タブ）が、本来削除されるべきところを **先に存在する
別 client の tab group に取り込まれてしまう**。

- 症状: 先行 session の `tab-list` に余分な `chrome-extension://<id>/connect.html?...`
  タブが 1 枚残る。URL に token が含まれるため軽微な情報露出にもなる。
- 原因: bootstrapping の競合。新しい connect ページ（新規タブ）を、既存の
  `ConnectedTabGroup` のグローバル `chrome.tabs` リスナーが、新 client の group が
  確保するより先に自グループへ取り込む。
- 影響: 小。8 タブ並走（2 profile × 2 identity × 2 tab）のアクセス自体には影響なし。
  concurrent multi-tab / tab group 命名は正常動作。
- 関連: `lib/playwright/packages/extension/src/connectedTabGroup.ts`,
  `background.ts`（branch `multitab-concurrent`）。
- 方針: 今回は未修正のまま記録。別 follow-up で対応する。
