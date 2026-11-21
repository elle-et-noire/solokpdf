# SolokPDF 設計レビューと作業計画

2026-11-21。基準は `solokpdf-dev` の `c75f0b75c`。Win32 製品の利用者操作から、共通層・両 PDF エンジン・配布・検証までを追った静的レビュー。以下の 32 件はこの調査で根拠を特定できた指摘と提案である。全ソースの監査や実機での不具合再現は行っていない。

## 今回の確認順

1. R20 — 設定変更と複数ウィンドウの更新
2. R23・R24 — 再着色とサムネイルキャッシュ
3. R13・R14・R21・R22 — PDF の初回表示、検索キャッシュ、ロック競合。R12 の再現有無も調べた。
4. R25 — 複数ページ画像出力中の UI 応答
5. R26・R27・R28 — ビルドと配布

判定と検証結果は [backlog.md](backlog.md) からたどれる。修正前の失敗確認、全件テスト、性能測定は今回省いた。

### 判断と引き継ぎ

- **優先度**　高＝別文書や予期しない内容の出力、部分失敗の見落とし、作業対象外への副作用。中＝利用者操作の一貫性、不要な仕事、変更時に崩れやすい契約。低＝変更機会や測定結果に応じて採用する提案。
- **種類**　「差」はコードで分岐または出力差を確認。「調査」は影響・発生条件を再現して決定。「提案」は現行仕様でも成立する保守改善。観察した構造と実害を分ける。差についても実機再現の成否を記録する。
- **出力仕様の作業仮定**　開いているタブから作る派生文書は、操作開始時に指定したタブの確定済み編集を含む。ツールが意図的にディスク上のファイルを扱う場合は入力を画面で識別できること。ファイルを選び足す Merge、元バイトのコピー、変換で保持できない署名等を一律に同じ意味にしない。既存の明示仕様と衝突した行は二案と影響を記録し、独立項目を先行する。
- **記録**　開始時に対象 ID、現在の HEAD、対象の入口と既存テストを記入。終了時は `ID / 採用・現状維持・保留 / 根拠 / 実行した検証・結果 / commit / 次のID` を backlog からたどれるようにする。保留には再開条件を一つ書く。再開時は現行コードで解消済みなら変更せず確認結果を残す。
- **実装単位**　挙動を変える項目、境界の整理、計測は別々に検証できる単位にする。修正後は影響を受ける既存テストを優先する。計測は同じ Debug バイナリ条件、文書、操作、キャッシュ状態で変更前後を反復し、件数・分布・ばらつきを併記する。単発の時間差で採用しない。

## 1. 製品仕様と出力

**R01 完了。** [ページ範囲出力の未保存編集](history.md#r01-unsaved-edits-in-page-range-output)

**R02 完了。** [ツール出力の適用済み墨消し](history.md#r02-applied-redactions-in-tool-output)

**R03 完了。** [「名前を付けて保存」の入力選択](history.md#r03-save-as-input-selection)

**R04 完了。** [ページ画像の保存失敗](history.md#r04-page-image-export-failures)

## 2. 操作対象・一時ファイル・保存境界

**R05 完了。** [PDF ツールの実行対象](history.md#r05-pdf-tool-source-tabs)

**R06 完了。** [PDF ツールの入力確定](history.md#r06-pdf-tool-pending-input)

**R07 完了。** [一時入力の後始末](history.md#r07-r08-r29-pdf-tool-output)

**R08 完了。** [完成した出力の公開](history.md#r07-r08-r29-pdf-tool-output)

## 3. 文書・エンジンの責務

**R09 完了。** [署名照会の入力](history.md#r09-r10-signature-lookup-and-redacted-page-bounds)

**R10 完了。** [墨消し後のコンテンツ境界](history.md#r09-r10-signature-lookup-and-redacted-page-bounds)

**R11 完了。** [墨消し済み文書の印刷元とサムネイル](history.md#r11-r12-r16-r17-print-reads-and-input)

**R12 現状維持。** ホバーと描画は競合時に取得を見送る。PDFium のリンク一覧は最初の取得時に解析し、ページ単位で保持する。[判断](history.md#e157-closure)

**R13 現状維持。** ラベル付き文書では、論理ページ数とラベルによる移動に必要な一覧を初回表示前に作る。[判断](history.md#e157-closure)

**R14 完了。** PDFium のページ寸法と回転を判定するため、32 MiB 以上でも描画用の MuPDF 解析を使う。[判断](history.md#e157-closure)

## 4. ウィンドウ・編集・設定の状態

**R15 完了。** [自動再読み込みの通知](history.md#r15-r30-r31-r32-reload-ci-and-decrypt)

**R16 完了。** [未確定入力の検出と確定](history.md#r11-r12-r16-r17-print-reads-and-input)

**R17 現状維持。** [キーの配送先と実フォーカスの役割](history.md#r11-r12-r16-r17-print-reads-and-input)

**R18 完了。** [スマートタブの候補収集](history.md#r18-r19-palette-and-trimmed-pages)

**R19 完了。** [トリミング保存の可否](history.md#r18-r19-palette-and-trimmed-pages)

**R20 完了。** ウィンドウ更新の重複を除き、外部設定再読込でもメニューバー表示を反映する。[設定変更と複数窓](history.md#r20-settings-across-windows)

## 5. 描画・検索・応答性

**R21 完了。** 置き換えたテキストは、借用が有効なエンジン破棄まで保持する。[検索キャッシュの寿命](history.md#r12-r13-r14-r21-r22-pdf-open-and-reads)

**R22 現状維持。** PDFium の呼び出しを直列化し、操作に必要なページ読み取りでは競合する描画の中断を試みる。[判断](history.md#e157-closure)

**R23 完了。** Home の色付きサムネイルは色設定と補正値を値で比較する。[再着色](history.md#r23-r24-recoloring-and-thumbnail-publication)

**R24 完了。** Home の中立 PNG に色データを含め、1 回のファイル置換で公開する。[サムネイルの公開](history.md#r23-r24-recoloring-and-thumbnail-publication)

**R25 完了。** ページ画像の描画と保存をワーカーに移し、処理中もダイアログを閉じて中止できる。[判断](history.md#e157-closure)

## 6. フォーク・ビルド・配布

**R26 現状維持。** 現行の製品構成は PDFium 対応を含み、実行時にどちらのエンジンを選んでも SolokPDF の製品方針が適用される。[製品構成](history.md#r26-r27-r28-build-and-distribution)

**R27 完了。** 配布フォルダーから、前回管理したファイルのうち今回の配布対象外になったものを取り除く。[配布の検証](history.md#r26-r27-r28-build-and-distribution)

**R28 完了。** アプリ、埋め込み資材、配布を検証する Debug 手順を明記した。[テスト手順](testing.md#choose-a-debug-build) · [確認結果](history.md#r26-r27-r28-build-and-distribution)

## 7. 検証の設計・結果の読み方

**R29 完了。** [出力内容と失敗時の回帰検証](history.md#r07-r08-r29-pdf-tool-output)

**R30 完了。** [CI のタイムアウトとプロセス分離](history.md#r15-r30-r31-r32-reload-ci-and-decrypt)

**R31 完了。** [CI のスキップ集計](history.md#r15-r30-r31-r32-reload-ci-and-decrypt)

**R32 完了。** [復号の入口と出力](history.md#r15-r30-r31-r32-reload-ci-and-decrypt)

## 検証・終了条件

リポジトリルートで実行する。以下は R01 の回帰テストを両エンジンで実行する例。テスト自身がエンジンを切り替える場合は二重に回さない。

```powershell
. ./tools/solokpdf/env.ps1
bun cmd/solok-build.ts -quick
$env:SOLOKPDF_ENGINE = 'pdfium'
bun tools/solokpdf/run-hidden.ts -- bun tests/pdf-tools-encrypted.ts --no-build
$env:SOLOKPDF_ENGINE = 'mupdf'
bun tools/solokpdf/run-hidden.ts -- bun tests/pdf-tools-encrypted.ts --no-build
Remove-Item Env:SOLOKPDF_ENGINE
```

- ローカルでアプリを起動するテストは [hidden desktop 手順](testing.md#local-windows-runs) に従う。手動起動時は `-for-testing`。環境変数の例は専用シェルで実行する。対象の寿命・解放を変える場合は [ASan 手順](testing.md#asan-builds) の該当ケースを追加。ローカル Release と無関係な全件テストは実行しない。
- [agents.md](../../agents.md) に従い、変更した C/C++ をビルド前に clang-format、TS はリポジトリの formatter、Markdown は Prettier で整形する。検証済みの作業単位を現在の upstream に通常 push する。共有ファイルを触る時も対象製品は Win32。凍結済み ng、サイト全体、配布方針の変更は [対象外の一覧](backlog.md#not-planned) に従う。
- 受け入れは各 ID の観測結果で決める。出力ならファイルを開き直した結果、対象固定なら別タブに副作用がなかった結果、性能なら比較値が必要。専用環境がなければ「未確認」と明記し、合格扱いにしない。仕様変更は features／limitations、責務変更は architecture、実行結果は history に反映する。
- 全 ID に判定・根拠・検証・残件が付いた時点で総括する。保留を完了に数えない。既存のプロジェクト方針どおり、解決済みの結果を履歴に移し、現役の計画と backlog へのリンクを整理する。
