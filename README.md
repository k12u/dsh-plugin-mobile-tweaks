# dsh-plugin-mobile-tweaks

DSH Web GUI のモバイル UX を、**インストール済みの本体ファイルを一切改変せずに** カスタマイズ・上書きするためのローカルプラグインです。ホスト側とブラウザ側の 2 つのコンポーネントで構成されます。

| コンポーネント | 注入・提供する機能 | 変更の反映方法 |
| --- | --- | --- |
| host 側 (`lib/index.js` + `styles/*.css`) | 配信される `index.html` への `<style>` / `<meta>` タグの注入 | **編集 → ページ再読み込み**（ビルド・再起動不要） |
| browser 側 (`lib/client.js`, `dsh.client`) | コンポーネントの振る舞いパッチ（DOM・イベント・ビューポート制御） | **編集 → ページ再読み込み**（同上） |

いずれも `@deepseek-ai/*` などの本体ファイルを直接変更しないため、DSH 本体をアップデートしても影響を受けにくく、確認が必要なのはプロファイルへの組み込み設定（配線）と本プラグインのパッチ内容のみです。

## 仕組み

```
styles/*.css ──(毎回読み直し)──┐
                              ▼
dsh-plugin-mobile-tweaks (host 側)
  ├─ webServer.tapIndex()      … 配信される <head> の末尾に
  │                              <style id="dsh-mobile-tweaks"> を注入
  │                              （既存 stylesheet より後 = 同詳細度で勝つ）
  ├─ viewport meta をマージ    … 既定で viewport-fit=cover を追加
  ├─ 任意の head マークアップ  … config.headHtml
  └─ GET /dsh-mobile-tweaks.css … 同じ CSS を配信（確認・差し替え用）

dsh-plugin-mobile-tweaks (browser 側, dsh.client)
  └─ patches[] を <html> 上で実行
       ├─ pointer  … data-dsh-mt-pointer / hover / orientation
       ├─ viewport … --dsh-mt-viewport-height / --dsh-mt-keyboard-inset
       │              data-dsh-mt-keyboard と dsh-mobile-tweaks:keyboard イベント
       └─ sidebar  … モバイルで会話を選んだら ctx.layout.toggleSidebar() で
                      左カラムを畳み、会話を全幅近くに戻す
```

- 上書き処理は `<style>` 要素 1 つ、viewport `<meta>` タグ、および `<html>` 要素への属性付与のみにとどまるため、万が一パッチの適用に失敗しても GUI 全体が破損することはありません（CSS の読み込みに失敗した場合は、`<style>` 内に `PROBLEM:` コメントを出力して処理を継続します）。
- browser 側で動的に注入される一般的なスタイルはモジュールシステムによって管理され、プラグインの無効化時や HMR 時に自動で削除されます。一方、本パッケージの CSS は host 側（HTTP 配信層）で注入されるため、クライアントモジュールシステムのライフサイクルには影響されません。

## ファイル構成

| パス | 役割 |
| --- | --- |
| `styles/00-base.css` | 追加専用の CSS カスタムプロパティ定義層（既存レイアウトへの影響なし） |
| `styles/20-input-zoom.css` | 入力系要素のフォントサイズ下限（16px）設定（iOS のフォーカス時自動ズーム対策） |
| `styles/90-mobile.css` | モバイル向けスタイル上書き層（具体的なレイアウト微調整を記述） |
| `lib/inject.js` | HTML 変換・CSS 読み込みの純粋関数（ユニットテスト対象） |
| `lib/index.js` | Cordis ホスト側プラグイン。`webServer` に `tapIndex` と確認用ルートを登録 |
| `lib/client.js` | ブラウザ側スクリプト（手書きバンドル・ビルド不要）。振る舞いパッチの本体 |
| `scripts/profiles.mjs` | プロファイル組み込み（配線）の共通ユーティリティ |
| `scripts/install.mjs` | プロファイルへの配線（リンク登録・`cordis.patch.yml` 追記）／解除／確認スクリプト |
| `scripts/status.mjs` | 配線状態・CSS 配信・ブラウザ側バンドル配信の整合性チェック |
| `test/inject.test.mjs` | HTML/CSS 変換処理のユニットテスト |
| `test/client.test.mjs` | ブラウザバンドルの契約（id / factory / exports）テスト |
| `test/styles.test.mjs` | スタイル層のポリシーテスト（16px 下限の維持など） |

## 初回導入

```sh
cd ~/deepseek-harness/dsh-plugin-mobile-tweaks

# テスト実行（ホスト不要）
node --test

# プロファイルへの組み込み（$DSH_PROFILE_DIR、未指定時は $DSH_HOME/profiles/web が対象）
node scripts/install.mjs
# 明示する場合:
#   node scripts/install.mjs --profile-dir ~/.dsh/profiles/web
#   node scripts/install.mjs --dsh-home ~/.dsh --profile web

# 反映確認（稼働中ホストと styles/ および client.js の整合性を照合）
node scripts/status.mjs
```

`install.mjs` が実行するのは以下の 2 つの処理のみであり、冪等性があるため何度実行しても安全です。

1. 対象プロファイルのディレクトリで `pnpm add link:~/deepseek-harness/dsh-plugin-mobile-tweaks` を実行
2. プロファイルの `cordis.patch.yml` に、マーカー付きの loader エントリを追記

```yaml
# >>> dsh-plugin-mobile-tweaks (managed by scripts/install.mjs) >>>
- insert:
    - id: mobile-tweaks
      name: dsh-plugin-mobile-tweaks
# <<< dsh-plugin-mobile-tweaks <<<
```

web プロファイルには `patchReload: live` が設定されているため、host 側の変更はプロセスの再起動なしで即座に有効化されます。
ただし、**`dsh.client`（ブラウザ向けバンドル定義）の宣言はホストプロセス内にキャッシュされる**ため、browser 側を新規追加した場合や `dsh.client` 定義を変更した初回のみ、プロセスの再起動が 1 回必要です（`status.mjs` のブラウザ側配信チェックが 404 になる場合は再起動待ちの状態です）。

```sh
systemctl --user restart dsh-web   # この GUI を配信しているユニット
```

## 日常のメンテナンス

### スタイル

1. `styles/*.css` を編集する（ファイル名の昇順がそのまま CSS カスケードの適用順となります。`00-`, `90-` などの数値接頭辞で優先度を制御します）。
2. ブラウザを再読み込みする。
3. 配信内容を確認する: `node scripts/status.mjs`

- 新しいスタイル層を追加したい場合は、`styles/20-....css` のように連番を挟んだファイルを配置するだけでよく、JS 側のコード変更は不要です。
- 特定のファイルを一時的に無効化したい場合は、拡張子を `.css.off` などに変更します（`*.css` のみが読み込み対象です）。
- CSS 内に `</style` の文字列が含まれると、注入先の `<style>` タグが不正に閉じられてしまうため、読み込み時に明示的にエラーとなります。

### 振る舞い

1. `lib/client.js` の `patches` 配列に対象のパッチ関数を追加する（後述）。
2. ブラウザを再読み込みする。バンドルのリビジョンハッシュはファイルの mtime / ctime / サイズから自動算出されるため、`pnpm run dev:web` などのファイル監視ウォッチャーが動作していなくても、ブラウザの再読み込みだけで変更が反映されます（ウォッチャーが動作している環境では、ページリロードなしで即座に差し替わります）。
3. `node scripts/status.mjs` を実行し、更新されたバンドルが正常に配信されていることを確認する。

#### パッチの書き方

`lib/client.js` の `patches` 配列に `{ id, apply }` を追加するだけで利用できます。`apply` 関数は共通の `api` オブジェクトを受け取ります。リソースの後始末（クリーンアップ）は自動化されており、プラグインの無効化時や HMR 時に `api.dispose()` が自動実行されます。

```js
/** 例: タップ時のハイライトを消す（実際に使うなら styles 側でも可） */
function tapHighlightPatch(api) {
	api.listen(document, "touchstart", () => api.setAttr("data-dsh-mt-touched", "1"), { passive: true, capture: true });
}

const patches = [
	{ id: "pointer", apply: pointerPatch },
	{ id: "viewport", apply: viewportPatch },
	{ id: "tap-highlight", apply: tapHighlightPatch },   // ← 追加
];
```

利用可能な `api` ヘルパー:

| ヘルパー | 用途 |
| --- | --- |
| `setAttr(name, value)` / `removeAttr(name)` | `<html>` 要素の属性を設定・削除（CSS 側との状態連携用） |
| `setVar(name, value)` / `removeVar(name)` | CSS カスタムプロパティ（`--dsh-mt-*`）を設定・削除して CSS に公開 |
| `listen(target, type, handler, options)` | イベントリスナーを登録（プラグイン破棄時のリスナー解除も自動） |
| `watchMedia(query, onChange)` | `window.matchMedia` を監視（登録時に現在の評価結果で 1 回即座に呼び出される） |
| `onCleanup(fn)` | カスタムの後始末処理（タイマー解除など）を登録 |
| `inject(names, setup)` | 指定した Cordis サービスが揃った段階で `setup(scopedCtx)` を実行（例: `["layout", "uiWorkspace"]`） |
| `emit(type, detail)` | `<html>` 要素上で `dsh-mobile-tweaks:<type>` カスタムイベントを発火 |
| `keyboardThreshold` | ソフトウェアキーボード展開判定のしきい値（px。config で変更可能） |

デバッグ用に `globalThis.__dshMobileTweaks`（`version` / `patches` / `api`）をグローバル公開しています。

#### 可能なこと・不可能なこと

- **可能なこと**: DOM 属性やクラスの操作、イベント委譲、`MutationObserver` による DOM 監視、`visualViewport` の計測、`ctx.sessions` などの Cordis サービスの購読（例: `dsh-client-ui-pending-sound`）。
- **不可能なこと**: 各 UI プラグイン（`@deepseek-ai/dsh-client-ui-*`）内部の React コンポーネント自体の差し替え。これらは外部向けに `apply` メソッドのみを公開しており、コンポーネントツリー内部を直接操作することはできません。コンポーネント自体を書き換える必要がある場合は、ビルド済みバンドルに対する直接パッチ（`apply-local-patches.py` 方式）が必要となりますが、DSH 本体のアップグレード耐性は大幅に低下します。

## 設定（任意）

`cordis.patch.yml` のエントリに `config` を指定することで、プラグインの挙動をカスタマイズできます（すべての項目は省略可能です）。
ここでの設定値は host 側と browser 側の両方に渡されます。

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `stylesDir` | パッケージ内の `styles/` | 読み込む CSS ディレクトリ。パッケージルートからの相対パスまたは絶対パス |
| `route` | `"/dsh-mobile-tweaks.css"` | CSS 確認用 HTTP ルート。`false` で無効化 |
| `viewport` | `{ "viewport-fit": "cover" }` | `<meta name="viewport">` に追加・マージする属性オブジェクト。`false` で無効化 |
| `headHtml` | `""` | `</head>` 直前に追加する任意の HTML マークアップ（meta タグ等） |
| `behavior` | `true` | `false` を指定すると browser 側のパッチ適用を完全に無効化 |
| `keyboardThreshold` | `120` | ソフトウェアキーボードの展開と判定するビューポートの収縮しきい値（px） |

設定例:

```yaml
- insert:
    - id: mobile-tweaks
      name: dsh-plugin-mobile-tweaks
      config:
        viewport:
          viewport-fit: cover
          interactive-widget: resizes-content
        headHtml: '<meta name="theme-color" content="#000000" />'
        keyboardThreshold: 150
```

> [!NOTE]
> `interactive-widget: resizes-content` を追加すると、Chrome for Android ではレイアウトビューポート自体が縮小するため、`--dsh-mt-keyboard-inset` によるキーボード判定値が 0 に近くなります。要件に応じて実機で動作を確認しながら設定してください。

## 動作確認

```sh
node --test                                  # ユニットテスト（ホスト起動不要）
node scripts/install.mjs --check             # 配線状態の確認（JSON 出力）
node scripts/status.mjs                      # 配線状態・CSS 配信・ブラウザ側バンドル配信の総合確認
curl -s http://127.0.0.1:3081/dsh-mobile-tweaks.css | head
```

ブラウザ上では、開発者ツール（DevTools）の Elements タブから `<style id="dsh-mobile-tweaks">`、`<meta name="viewport" … viewport-fit=cover>`、`<html data-dsh-mt-pointer="…">` が正常に適用されていることを確認できます。
なお、`index.html` の取得には認証が必要なため、ヘッダーなしの `curl` による `index.html` へのリクエストは 401 Unauthorized になります（CSS やスクリプトバンドルのエンドポイントは静的アセットと同様に公開されています）。

実ブラウザでの自動確認（この環境では `~/.agent-browser` の Chrome を使用）:

```sh
agent-browser open 'http://127.0.0.1:3099/?token=<起動時に表示された token>'
agent-browser wait --load networkidle
agent-browser eval 'JSON.stringify({ pointer: document.documentElement.dataset.dshMtPointer, keyboard: document.documentElement.dataset.dshMtKeyboard, api: typeof globalThis.__dshMobileTweaks })'
```

## アンインストール（配線解除）

```sh
node scripts/install.mjs --remove
# 必要に応じてプロセスの再起動
systemctl --user restart dsh-web
```

## モバイルでのドロワー（サイドバー）自動折りたたみ

「モバイル環境で左の一覧から会話を選択しても、メニュー開閉ボタンを明示的に押すまで会話画面に切り替わらない（サイドバーが開いたまま会話が極小エリアに押し込まれる）」という課題に対し、本プラグインでは以下の 2 つの公式プラグインの状態を組み合わせて自動折りたたみを実現しています。

| 役割 | 関連公式プラグイン | 利用する API / 状態 |
| --- | --- | --- |
| 選択中セッションの監視 | `@deepseek-ai/dsh-client-ui-workspace` | `ctx.uiWorkspace.selection`（スナップショットストア。`replaceMain()` が `{ sessionId }` を設定。`getSnapshot()` / `subscribe(fn)` で監視） |
| サイドバーの開閉操作 | `@deepseek-ai/dsh-client-ui-layout` | `ctx.layout.toggleSidebar()`（内部の `layoutInfo.narrowExpanded` を `viewportWidth < 1024` の場合のみ反転） |

- 画面幅 1024px 未満は「narrow（狭幅画面）」と判定され、サイドバー展開フラグに応じて `sidebarCollapsed = !narrowExpanded` となります。サイドバーが開いている状態では左カラムが 280px を占有するため、会話エリアは `画面幅 - 280px` に圧縮されてしまいます（例えば 390px 幅のスマートフォンではわずか 110px になります）。
- 本パッケージでの実装は [lib/client.js](lib/client.js) の `sidebarPatch` および純粋関数 `shouldAutoCollapse(previousId, nextId, narrow, collapsed)` です。「セッション ID が変更され、かつ narrow 状態であり、かつサイドバーが現在開いている」場合のみ `true` を返し、自動でサイドバーを折りたたみます。
- 会話の切り替えは、`replaceMain()` を経由するすべての動線で検知可能です（セッション一覧のクリック、ワークスペース接続、サブエージェントへのドリルダウン、セッション復元など）。また、`clearMain()`（新規セッションの初期画面）も `selection` を `{}` にリセットするため、同様の経路で折りたたまれます。
- サイドバーが開いているかどうかの判定は、AppFrame が折りたたみ時にのみ付与する `data-sidebar-collapsed` 属性を参照しています。公式側で属性名等の仕様変更があった場合でも、「折りたたまない（現状維持）」ようにフォールバックする安全側の設計です。
- すでに選択されているセッションを再度タップした際にもサイドバーを折りたたみたい場合は、`shouldAutoCollapse` 内の `nextId === previousId` のガード条件を解除してください（この場合、`selection` が再設定されるたびに折りたたみ処理が走ります）。

## チャット入力欄のフォーカス時自動ズーム対策（iOS）

**症状**: モバイル（iOS Safari）でチャットの入力欄をタップすると画面全体が自動ズームし、レイアウトが画面幅をはみ出して横スクロールが発生してしまう。

**原因**: iOS Safari には「フォーカスされた入力要素の `font-size` が 16px 未満」の場合に画面を自動拡大する仕様があります。DSH のチャット入力欄（composer）は `div[contenteditable="true"][role="textbox"]` で構成されており、自身のスタイルは `font-size: inherit`、親コンテナから 14px が継承されていました（モバイル幅での実測値 14px。なおアプリ本体側には `user-scalable` / `maximum-scale` や `visualViewport` によるズーム抑止処理は含まれていません）。

**対策**: [styles/20-input-zoom.css](styles/20-input-zoom.css) により、入力系要素のフォントサイズに 16px の下限を設定しています。

- `font-size: max(16px, 1em)`: `font-size` の `em` は親からの継承値を参照するため、すでに 16px 以上で指定されている要素には影響せず、16px 未満の要素のみが 16px に引き上げられます。
- 適用条件の分岐: CSS ではメディアクエリと Feature クエリ（`@supports`）を単一のルール内で OR 結合できないため、同じセレクタ一覧を意図的に 2 箇所に分けて記述しています（セレクタを追加・修正する際は両方のブロックを更新してください）。
  1. `(pointer: coarse)`（実機のタッチ操作端末。デスクトップ表示モードでも合致）および `(max-width: 820px) and (hover: none)`（pointer 判定が正確でない環境向けの保険。マウスが接続された幅の狭いデスクトップウィンドウには合致せず、14px のまま維持されます）。
  2. `@supports (-webkit-overflow-scrolling: touch)`: 外付けキーボードやトラックパッドを接続した iPad では `pointer: fine` と判定され、1 の条件をすり抜けてしまうため、iOS / iPadOS 固有の Feature クエリで確実に捕捉します。Blink 系（Chrome 152 等）では `CSS.supports` が false となることを確認済みのため、デスクトップ環境の Chrome や Firefox には適用されず 14px が維持されます。
- `maximum-scale=1` や `user-scalable=no` によるメタタグ制御は**意図的に採用していません**。iOS 10 以降の Safari ではアクセシビリティ担保のためユーザーによるピンチズームが強制的に許可されており、入力時の自動ズーム抑制としては効果がないうえ、通常のズーム操作を阻害する副作用のみが残るためです。

**実測値（393x852 タッチエミュレーション環境、ステージング :3081）**: 対策前 14px → 対策後 16px。
`scrollWidth === innerWidth === 393` は前後で変化せず、composer の寸法も 294x52 を維持。同一ページ上で本対策スタイルのみ `sheet.disabled = true` に切り替えて比較検証し、再度有効化すると 16px に戻ることを確認済み。`CSS.supports("-webkit-overflow-scrolling", "touch")` はデスクトップ Chrome で false を返す（＝ iPad 向けルールがデスクトップに誤適用されない）ことを確認済み。

**iPhone 実機での確認手順**:
（本環境では Chrome のタッチエミュレーションによる検証を行っているため、最終的な動作は実機でご確認ください）

1. iPhone の Safari で対象 GUI を開きます（`maximum-scale` などのメタタグ変更はないため、Safari のタブを一度閉じて開き直すだけで最新の CSS が反映されます）。
2. チャットの入力欄をタップした際、画面が勝手にズーム（拡大）しないことを確認します（手動のピンチズーム操作は通常通り行えます）。
3. 設定画面など、他の入力フォーム（従来 14px だった箇所）でも同様に自動ズームが発生しないことを確認します。
4. もし特定画面でズームが発生する場合は、対象の画面名および要素（入力欄の種類など）を記録・報告してください。

16px の文字サイズを変更したい場合は `styles/20-input-zoom.css` の値を調整してください（ただし iOS Safari のズーム抑止しきい値が 16px のため、16px 未満に設定すると自動ズームが再発します）。

## 注意点

- host 側の処理は **サーバーから配信される `index.html`**（`dsh web` の served 構成）に対して適用されます。static worker 構成など `tapIndex` を経由しない配信形態は対象外です。
- `index.html` のアクセス認証は `dsh-host-frontend-static` および `dsh-client-connection` が管轄しています。本プラグインはその認証機構やオリジンポリシーを変更しません。
- CSS ルートおよびスクリプトバンドルのルートは、他の静的アセットと同様に認証なしで公開されます。機密情報やシークレットを CSS やスクリプト内に含めないでください。
- 端末側のブラウザキャッシュ（PWA キャッシュや bfcache 等）が残っている場合、古いバージョンの CSS が適用されることがあります。その場合はブラウザ側でハードリロード（キャッシュクリア）を実行してください。
