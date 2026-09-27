# dsh-plugin-mobile-tweaks

DSH Web GUI のモバイル UX を、**インストール済みファイルを書き換えずに** 上書きし続けるための
ローカルプラグインです。2 つの半分からなります。

| 半分 | 何を差し込むか | 変更の反映 |
| --- | --- | --- |
| host (`lib/index.js` + `styles/*.css`) | 配信される index への `<style>` / meta 注入 | **編集 → ページ再読み込み**（リビルド・再起動不要） |
| browser (`lib/client.js`, `dsh.client`) | コンポーネントの振る舞い（DOM・イベント・viewports） | **編集 → ページ再読み込み**（同上） |

どちらも `@deepseek-ai/*` のファイルを触らないので、DSH 本体をアップグレードしても
再確認するのは「プロファイル配線」と「CSS/パッチの内容」だけです。

## 仕組み

```
styles/*.css ──(毎回読み直し)──┐
                              ▼
dsh-plugin-mobile-tweaks (host half)
  ├─ webServer.tapIndex()      … 配信される <head> の末尾に
  │                              <style id="dsh-mobile-tweaks"> を注入
  │                              （既存 stylesheet より後 = 同詳細度で勝つ）
  ├─ viewport meta をマージ    … 既定で viewport-fit=cover を追加
  ├─ 任意の head マークアップ  … config.headHtml
  └─ GET /dsh-mobile-tweaks.css … 同じ CSS を配信（確認・差し替え用）

dsh-plugin-mobile-tweaks (browser half, dsh.client)
  └─ patches[] を <html> 上で実行
       ├─ pointer  … data-dsh-mt-pointer / hover / orientation
       ├─ viewport … --dsh-mt-viewport-height / --dsh-mt-keyboard-inset
       │              data-dsh-mt-keyboard と dsh-mobile-tweaks:keyboard イベント
       └─ sidebar  … モバイルで会話を選んだら ctx.layout.toggleSidebar() で
                      左カラムを畳み、会話を全幅近くに戻す
```

- 上書きは `<style>` 1 要素 + viewport meta + `<html>` の属性だけなので、失敗しても GUI は壊れません
  （CSS 読み込みに失敗した場合は `<style>` 内に `PROBLEM:` コメントを出して継続）。
- browser 側が注入する `<style>` はモジュールシステムが所有し、無効化・HMR で自動的に外れます。
  このパッケージのスタイルは host 側が出すので、その管理下には入りません。

## ファイル構成

| パス | 役割 |
| --- | --- |
| `styles/00-base.css` | 追加専用のカスタムプロパティ層（レイアウト変更なし） |
| `styles/20-input-zoom.css` | 入力系要素の 16px 下限（iOS のフォーカス自動ズーム対策） |
| `styles/90-mobile.css` | モバイル上書き層。ここに実際の調整を書く |
| `lib/inject.js` | 純関数（HTML 変換・CSS 読み込み）。テスト対象 |
| `lib/index.js` | Cordis ホスト側。`webServer` に tap とルートを登録 |
| `lib/client.js` | ブラウザ側バンドル（手書き。ビルド不要）。振る舞いパッチの本体 |
| `scripts/profiles.mjs` | プロファイル配線の共通処理 |
| `scripts/install.mjs` | 配線（link + `cordis.patch.yml` 追記）／解除／確認 |
| `scripts/status.mjs` | 配線状態・CSS 配信・ブラウザ側バンドルの配信を照合 |
| `test/inject.test.mjs` | HTML/CSS 変換のユニットテスト |
| `test/client.test.mjs` | ブラウザバンドルの契約（id / factory / exports）テスト |
| `test/styles.test.mjs` | スタイル層のポリシーテスト（16px 下限の維持など） |

## 初回導入

```sh
cd ~/deepseek-harness/dsh-plugin-mobile-tweaks

# テスト（ホスト不要）
node --test

# 配線（$DSH_PROFILE_DIR、無ければ $DSH_HOME/profiles/web が対象）
node scripts/install.mjs
# 明示する場合:
#   node scripts/install.mjs --profile-dir ~/.dsh/profiles/web
#   node scripts/install.mjs --dsh-home ~/.dsh --profile web

# 反映確認（稼働中のホストと styles/ / client.js を照合）
node scripts/status.mjs
```

`install.mjs` が行うのは次の 2 つだけで、どちらも再実行安全です。

1. プロファイルで `pnpm add link:~/deepseek-harness/dsh-plugin-mobile-tweaks`
2. プロファイルの `cordis.patch.yml` に、マーカー付きの loader エントリを追記

```yaml
# >>> dsh-plugin-mobile-tweaks (managed by scripts/install.mjs) >>>
- insert:
    - id: mobile-tweaks
      name: dsh-plugin-mobile-tweaks
# <<< dsh-plugin-mobile-tweaks <<<
```

web プロファイルは `patchReload: live` なので、host 側は再起動なしで有効になります。
ただし **`dsh.client` の宣言はホストプロセスごとにキャッシュ**されるため、browser 側を
新しく足したとき・`dsh.client` を変更したときだけは 1 回再起動が必要です
（`status.mjs` のブラウザ側チェックが 404 なら再起動待ち）。

```sh
systemctl --user restart dsh-web   # この GUI を配信しているユニット
```

## 日常のメンテ

### スタイル

1. `styles/*.css` を編集する（ファイル名順 = カスケード順。`00-`, `90-` の接頭辞で並べる）。
2. ブラウザを再読み込みする。
3. 配信内容を確認する: `node scripts/status.mjs`

- 新しい層を足すときは `styles/20-… .css` のように番号を挟むだけで、コード変更は不要です。
- 一時的に無効化したいファイルは拡張子を `.css.off` にする（`*.css` だけが読まれます）。
- CSS 内に `</style` を含めると注入タグを閉じてしまうため、読み込み時に明示エラーになります。

### 振る舞い

1. `lib/client.js` の `patches` に関数を足す（下記）。
2. ブラウザを再読み込みする。バンドルのリビジョンはファイルの mtime / ctime / size から
   決まるので、`pnpm run dev:web` のウォッチャが無くても再読み込みだけで反映されます
   （ウォッチャがあればページリロードなしで差し替わります）。
3. `node scripts/status.mjs` でバンドルが配信されていることを確認する。

#### パッチの書き方

`lib/client.js` の `patches` に `{ id, apply }` を足すだけです。`apply` は共有 `api` を受け取り、
後始末は自動です（エントリの無効化・HMR で `api.dispose()` が走る）。

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

`api` で使えるもの:

| ヘルパー | 用途 |
| --- | --- |
| `setAttr(name, value)` / `removeVar` 系 | `<html>` の属性・CSS カスタムプロパティを設定（CSS 側と受け渡す） |
| `setVar(name, value)` | `--dsh-mt-*` を公開して CSS から使う |
| `listen(target, type, handler, options)` | リスナー登録（解除も自動） |
| `watchMedia(query, onChange)` | `matchMedia` を監視。登録時に 1 回呼ばれる |
| `onCleanup(fn)` | 独自の後始末（タイマー等） |
| `inject(names, setup)` | Cordis サービスが揃った時点で `setup(scopedCtx)` を実行（例: `["layout", "uiWorkspace"]`） |
| `emit(type, detail)` | `<html>` に `dsh-mobile-tweaks:<type>` の CustomEvent を発火 |
| `keyboardThreshold` | ソフトキーボード判定のしきい値(px)。config で変更可 |

デバッグ用に `globalThis.__dshMobileTweaks`（`version` / `patches` / `api`）を公開しています。

#### できること・できないこと

- できる: DOM の属性・クラス操作、イベント委譲、`MutationObserver`、`visualViewport` 計測、
  `ctx.sessions` など Cordis サービスの購読（例: `dsh-client-ui-pending-sound`）。
- できない: 各 UI プラグイン（`@deepseek-ai/dsh-client-ui-*`）の React コンポーネント内部の差し替え。
  それらは `apply` しか公開しておらず、内部へは触れません。必要な場合は出荷バンドルへの
  パッチ（`apply-local-patches.py` 方式）になりますが、アップグレード耐性は大きく落ちます。

## 設定（任意）

`cordis.patch.yml` のエントリに `config` を足すと挙動を変えられます（すべて省略可）。
config は host / browser 両方の半分に渡されます。

| キー | 既定 | 意味 |
| --- | --- | --- |
| `stylesDir` | パッケージ内 `styles/` | 読み込むディレクトリ。パッケージ相対 or 絶対パス |
| `route` | `/dsh-mobile-tweaks.css` | 確認用ルート。`false` で無効化 |
| `viewport` | `{ "viewport-fit": "cover" }` | viewport meta に必ず足すフラグ。`false` で無効化 |
| `headHtml` | `""` | `</head>` 直前に足す任意のマークアップ（meta 等） |
| `behavior` | `true` | `false` で browser 側のパッチを全部止める |
| `keyboardThreshold` | `120` | ソフトキーボードとみなす viewport 収縮量(px) |

例:

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

> 注意: `interactive-widget: resizes-content` を足すと Chrome Android では layout viewport も
> 縮むため、`--dsh-mt-keyboard-inset` によるキーボード判定が 0 に近づきます。どちらを使うかは
> 実機で決めてください。

## 動作確認

```sh
node --test                                  # ユニットテスト（ホスト不要）
node scripts/install.mjs --check             # 配線状態（JSON）
node scripts/status.mjs                      # 配線 + CSS 配信 + ブラウザ側バンドル配信
curl -s http://127.0.0.1:3081/dsh-mobile-tweaks.css | head
```

ブラウザ側では DevTools の Elements で `<style id="dsh-mobile-tweaks">`、
`<meta name="viewport" … viewport-fit=cover>`、`<html data-dsh-mt-pointer="…">` を確認できます。
index は認証必須なので `curl` での index 確認は 401 になります（CSS / バンドルのルートは公開）。

実ブラウザでの自動確認（この環境では `~/.agent-browser` の Chrome を使用）:

```sh
agent-browser open 'http://127.0.0.1:3099/?token=<起動時に表示された token>'
agent-browser wait --load networkidle
agent-browser eval 'JSON.stringify({ pointer: document.documentElement.dataset.dshMtPointer, keyboard: document.documentElement.dataset.dshMtKeyboard, api: typeof globalThis.__dshMobileTweaks })'
```

## 解除

```sh
node scripts/install.mjs --remove
# 必要なら
systemctl --user restart dsh-web
```

## この環境での検証記録（2026-09-25, dsh 0.1.7-rc.1）

- `node --test` … 21 件すべて pass
- host 側（staging :3081）: link + loader エントリで **再起動なし** に自動マウント。
  `GET /dsh-mobile-tweaks.css` は 200 でローカル `styles/` とバイト一致。
  認証付きで取得した実 index に `<style id="dsh-mobile-tweaks" data-dsh-mobile-tweaks="2">` が
  既存 stylesheet より後・`</head>` 直前に 1 つだけ入り、viewport は
  `width=device-width, initial-scale=1, viewport-fit=cover` にマージ済み。
  CSS を書き換えると配信バイトが即追従。
- browser 側: プロファイルを複製したコールドスタートホスト（:3099）で検証。
  ブートグラフに `{"id":"dsh-plugin-mobile-tweaks","immediately":true,...}` の行が出て、
  コンボ URL が 200 でバンドルを配信。ヘッドレス Chrome で実際に実行され、
  `data-dsh-mobile-tweaks="runtime"` / `data-dsh-mt-pointer` / `data-dsh-mt-orientation` /
  `data-dsh-mt-keyboard="closed"` / `--dsh-mt-viewport-height` が設定され、
  `globalThis.__dshMobileTweaks.patches` は `["pointer","viewport","sidebar"]`。
  ビューポートを 390x844 に変えると `data-dsh-mt-orientation` が `portrait` に追従（再読み込み不要）。
  `lib/client.js` を書き換えるとリビジョンが変わり、再読み込みで新しいコードが実行されることを確認。
- ライブの :3081 は `dsh.client` メタデータをプロセス内にキャッシュ済み（host 半分だけ導入済み）
  のため、browser 半分の有効化には 1 回の再起動が必要（2026-09-27 実施済み）。
- モバイルのドロワー自動折りたたみ（`sidebar` パッチ）: 390x844 の実機幅で、左カラムを開いた状態
  （サイドバー 280px / 会話 110px）から会話を選ぶと、サイドバー 56px / 会話 334px に自動で切り替わり、
  `dsh-mobile-tweaks:sidebar-auto-collapsed` が 1 回発火することを確認。1280x800 では発火しない
  （会話を選んでもサイドバーは 280px のまま）。

## モバイルのドロワー挙動（どこを触るか）

「モバイルで左の一覧から会話を選んでも、メニュー開閉ボタンを押すまで会話に切り替わらない」問題は、
次の 2 つの既存プラグインの状態を組み合わせて直しています。

| 役割 | 実装場所 | 使う API / 状態 |
| --- | --- | --- |
| 選択中セッション | `@deepseek-ai/dsh-client-ui-workspace` | `ctx.uiWorkspace.selection`（snapshot store。`replaceMain()` が `{ sessionId }` を書く。`getSnapshot()` / `subscribe(fn)`） |
| サイドバー開閉 | `@deepseek-ai/dsh-client-ui-layout` | `ctx.layout.toggleSidebar()`。内部の `layoutInfo.narrowExpanded` を `viewportWidth < 1024` のときだけ反転する |

- 幅 1024px 未満が「narrow」で、そのとき `sidebarCollapsed = !narrowExpanded`。
  開いた状態では左カラムが 280px、会話は `viewport - 280` に圧縮されます（390px 端末で 110px）。
- このパッケージの実装は [lib/client.js](lib/client.js) の `sidebarPatch` と純関数
  `shouldAutoCollapse(previousId, nextId, narrow, collapsed)` です。判定は
  「セッション ID が変わり、narrow で、まだ開いている」ときだけ `true`。
- 会話の切り替えは `replaceMain()` 経由ならどの導線でも拾えます（一覧クリック、workspace 接続、
  サブエージェントへのドリル、resume）。`clearMain()`（新規セッションの空ページ）も
  `selection` を `{}` にするので同じ経路です。
- 開いた状態の判定は AppFrame が折りたたみ時だけ出す `data-sidebar-collapsed` 属性で行っています。
  上流で名前が変わった場合は「畳まない」= 現状維持に倒れます。
- 同じセッションをもう一度タップしたときも畳みたい場合は、`shouldAutoCollapse` の
  `nextId === previousId` 判定を外してください（その場合は `selection` が再設定されるたびに畳みます）。

## チャット入力のフォーカスズーム（iOS）

**症状**: モバイルでチャットの入力欄に触れるとページが自動ズームし、レイアウトが画面幅を超えて
横にずれる。

**原因**: iOS Safari は「フォーカスされた入力要素の `font-size` が 16px 未満」のとき自動ズームする。
composer は `div[contenteditable="true"][role="textbox"]` で、自身のルールは `font-size: inherit`、
親コンテナが 14px を渡していた（モバイル幅での実測値 14px。アプリ側に `user-scalable` /
`maximum-scale` / `visualViewport` を扱うコードは無い）。

**対策**: [styles/20-input-zoom.css](styles/20-input-zoom.css) で入力系要素に 16px の下限を置く。

- `font-size: max(16px, 1em)` … `font-size` の `em` は継承値なので、既に 16px 以上ある要素は
  その大きさのまま。16px 未満の要素だけが 16px に上がる。
- 適用範囲は 2 つ。媒体クエリと機能クエリは 1 つのルールで OR できないため、
  同じセレクタ一覧を意図的に 2 回書いています（片方を直したらもう片方も直すこと）。
  1. `(pointer: coarse)`（実機のタッチ端末。デスクトップサイト表示でも一致する）と
     `(max-width: 820px) and (hover: none)`（pointer 判定が信用できない環境向けの保険。
     マウス付きの狭いデスクトップ窓はどちらにも一致せず 14px のまま）。
  2. `@supports (-webkit-overflow-scrolling: touch)` … iPad にキーボード/トラックパッドを
     付けると `pointer: fine` になり 1 をすり抜けるための iOS/iPadOS 限定の判定。
     Blink（Chrome 152）で `CSS.supports` が false であることを確認済みなので、
     デスクトップの Chrome / Firefox は 14px のまま。
- `maximum-scale=1` / `user-scalable=no` は **採用しない**。iOS 10 以降の Safari は
  アクセシビリティのためピンチズームを許可しており効果がなく、副作用だけが残る。

**実測（393x852・タッチ相当エミュレーション、ライブ :3081）**: 対策なし 14px / 対策あり 16px。
`scrollWidth == innerWidth == 393` は前後で変わらず、composer の寸法も 294x52 のまま。
同じページで対策レイヤーだけ `sheet.disabled = true` にして比較し、再度有効化すると 16px に戻る。
`CSS.supports("-webkit-overflow-scrolling", "touch")` は Chrome で false（＝ iPad 用ブロックは
デスクトップでは効かない）。

**iPhone での確認手順**（この環境では Chrome のタッチ相当エミュレーションまでの確認のため、
最後は実機で）:

1. iPhone の Safari でこの GUI を開き直す（`maximum-scale` 等は使っていないので、
   キャッシュ回避はタブを閉じて開き直すだけで十分）。
2. チャットの入力欄をタップ → 自動ズームしないこと。ピンチアウトしても元の倍率に戻ること。
3. 設定画面などの他の入力欄（従来 14px だったもの）でも同様にズームしないこと。
4. まだズームする場合は、どの画面のどの要素か（入力欄か、それ以外か）を控えておくと
   次の調査が速い。

16px が大きすぎる・小さくしたい場合は `20-input-zoom.css` の値を調整してください
（iOS のしきい値は 16px なので、これ未満にすると再発します）。

## 注意点

- host 半分は **配信される index.html**（`dsh web` の served 構成）に効きます。
  static worker 構成は `tapIndex` を通らないため対象外です。
- index の認証は `dsh-host-frontend-static` / `dsh-client-connection` が所有します。
  このプラグインはその認証・オリジン方針を変更しません。
- CSS ルートとバンドルルートは static asset と同じく公開です。秘密情報を書かないでください。
- 既存の GUI キャッシュ（PWA / bfcache）が効いている場合、古い CSS が見えることがあります。
  その場合はハードリロードしてください。
