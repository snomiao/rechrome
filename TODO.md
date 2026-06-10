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
- 無害の裏付け: 漏れた connect.html を閉じても接続は切れない（WebSocket は
  service worker 側が保持）。45 秒放置（MV3 SW idle timeout 超）でも両 session 生存を確認。
- なぜ簡単に直せないか: connect ページは「捨てて良い孤児」のときと「所有 group の
  seed タブ」のときがあり、タイミング依存。connect.html を一律 eject / remove すると
  後者を壊し、no-eviction / named-groups テストが落ちる（実測で確認）。foreign 限定の
  eject も再グループ化の競合で漏れが残る。非競合な修正には connect ページのライフ
  サイクル自体の見直しが要る。
- 再現テスト: `lib/playwright/tests/extension/concurrent-clients.spec.ts` の
  `test.fixme('... connect.html does not leak ...')`（現状コードで fail する repro）。
- 関連: `lib/playwright/packages/extension/src/connectedTabGroup.ts`,
  `background.ts`（branch `multitab-concurrent`）。
- 方針: cosmetic かつ無害のため deferred。専用の follow-up で connect ページの
  ライフサイクルを設計し直して対応する。
