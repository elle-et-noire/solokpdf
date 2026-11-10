# SolokPDF 構造・コードレビュー結果

2026-11-10、初回 `7c67b529f`、継続 `0046373df`。計画の基準 `32d95cef7` から `src/`・`cmd/`・`tests/` の差分はない。
E23–E25 は計画の範囲で完了。E25 の優先順位・依存関係・残件は末尾の再点検結果にまとめた。
初回は約30分の点検。以下の関数名は調査した経路を示し、全分岐の精読を意味しない。継続点検は末尾に分けて記録する。
以下の指摘はレビュー時点の記録。E26 は修正済み（[検証結果](history.md#e26-automatic-reload-2026-11-10)）。
優先順位・実施順は [E25 再点検](#e25-再点検)、現在の残件は [backlog](backlog.md) を参照する。

不具合は 11 件。R1–R4・R8 は両エンジンで再現、R5–R6・R10–R11 はコード上の指摘、R7/E33 は PDFium の取得失敗注入で再現した。
R9/E34 は保存対象の切替を Debug・ASan で再現し、Reload 中の終了再入も ASan 診断を保存した。E32 は終了待ちの契約問題として残す。
R1・R2 のデータ損失を最優先とする。初回の再現入力・プローブのソース・出力・実行条件は
[検証データ](data/full-review-2026-11-10.json)に保存した。

## E23: 入口と実装

`premake5.files.lua` の `sumatrapdf_files`・エンジン登録と `--with-pdfium` の追加ソースを照合した。
Win32 は `src/solokpdf/EnginePdfium.cpp` と `src/shared/` のエンジン・表示処理を使う。
`cmd/helper/ng-shared.ts` は共有ファイルを列挙し、`ng-targets.ts` の仮想パスへステージする。
列挙された `src/ng/EngineMupdf.cpp` 等を、存在する別実装と取り違えない。

| 操作                     | 入口 → 主要実装                                                                                                                                                                                                  | 対応する既存テスト                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 開く・読み取り・移動     | `StartLoadDocument` / `LoadDocument` → `CreateControllerForEngineOrFile` → `CreateEngineFromFile` / `CreateEngineFromData` → PDFium `Load`・`LoadWithPassword`。検索は `TextSearch` → `EngineBase::ReadPageText` | `ad-hoc-pdfium-password`、`ad-hoc-pdfium-try-reads`、`ad-hoc-pdfium-source-lifetime`                          |
| 描画・表示変更           | `UpdateDocumentColors` / `MainWindowRerender` → `RenderCache` → `RenderViewPage` → PDFium `RenderPage` → `DrawPage` / `DrawMupdf`。F12・サイドバーは `PageThumbnailsCtrl`、Home は `ColoredThumbnail`            | `theme-pdfium-cache`、`theme-render-cancel`、`theme-annotation-failure`、`ad-hoc-pdfium-thumb-theme`          |
| 入力・コマンド・画面状態 | `MaybeTranslateAccelerator` → `GetKeyTarget`・`VimKeysPreTranslate`・`FindAcceleratorsForHwnd` → `WndProcFrame` のコマンド処理。マウスは `WndProcCanvas` → 選択・フォーム・注釈操作                              | `keyboard-input-targets`、`ad-hoc-vim-keys`、`find-history-alt-down`                                          |
| 編集・Undo/Redo          | `CommitFormFieldEdit` / 注釈コマンド → `AnnotationEditor` → `AnnotEngineMupdf` → `Annotation.cpp`・MuPDF journal。署名は `SignDocumentWnd::DoSign` → `EngineMupdfSignDocument`                                   | `ad-hoc-pdfium-form-js`、`ad-hoc-pdfium-document-js`、`ad-hoc-pdfium-signing`、`ad-hoc-pdfium-redaction-undo` |
| 保存・複製・再読み込み   | `OnMenuSaveAs`・`SaveAnnotationsToExistingFile`・`SaveAnnotationsToMaybeNewPdfFile` → `SaveFileAs` / `EngineMupdfSaveUpdated`。watcher → `ReloadTab` → Canvas timer → `ReloadDocument`                           | `ad-hoc-pdfium-source-lifetime`、`ad-hoc-pdfium-saveas`、`ad-hoc-pdfium-forms`                                |
| 閉じる・終了             | `CloseTab` / `CloseWindow` → `MaybeSaveAnnotations` → `WindowTab` 破棄 → `DeleteControllerAsync` → `DisplayModel` 破棄。終了時に `WaitForPendingControllerDeletes`                                               | `theme-render-cancel`、`sidebar-thumbnails-close`、`close-tab-during-placement`                               |

## E24: 読んだ経路と確認範囲

### 開く・読み取り・移動

`EngineCreate.cpp` のファイル・データ両 factory、`ApplyEngineSettings`、CBX のメモリ化・ローカルコピー、
PDFium の `Load`・`ReadBlock`・`ReadIntoMemory`・`LoadWithPassword`・`AnnotationEditor`・`Clone` を確認した。
文書全体の MuPDF フォールバックと、描画だけの代替は別の判断である。
パスワード中止の `Final` は同じ PDF の MuPDF 再試行を止める。添付・Print Replica・p7m の入力コピーも追った。

読み取りは `TextLocked`・`ExtractText`・`TryExtractPageText`・`ElementsLocked`・`TryGetElements`・
`GetElements`・`GetElementAtPos`・`LoadLinks`・`GetToc`・`ReadBookmarks`・`GetNamedDest`、
共通の `ReadPageText`・`TextCacheEntry::StoreText`・`InvalidateTextForPage` と
`GetSearchPageText`、`KeyboardLinkFollowingRecompute` の利用条件を確認した。
Try 要素取得は利用可能な部分集合であり、`true` を全件完了として保存していない。
テキストの partial は blocking 取得で置き換えるが、編集済み値の無効化は R4 が残る。

非 PDF は factory の分岐、`EngineImages::GetFileData`・`SaveFileAs`、`EngineCbx::CreateFromFile`・`Clone` を追った。
PDFium の元入力保持を全エンジン共通の保証にはできない。CBX コピーの再利用には R5 がある。
CHM・Markdown の browser controller 選択と固定ページへの代替は確認したが、WebView2 内部は精読していない。

### 描画・表示変更

PDFium の `PrepareRenderRoute`・`PrepareTheme`・`DrawPage`・`DrawMupdf`・`RenderPage`・`TileMatrix`、
MuPDF の `NewPdfRenderProbe`・`PdfPageRenderRouteMupdf`・`PdfThemePageMupdf`・`PdfRenderMupdf`、
`RenderViewPage`・`ApplyViewPageAdjust`・`GetPageColorPass` を確認した。
借用 BGRA、alpha の乗算、変換済み色、失敗・中止時の解放と結果公開の条件を照合した。
注釈合成失敗では本文だけを成功結果にせず、null を返す。

`RenderCache::Render`・`GetNextRequest`・`Add`・`SetViewColors`・`Invalidate`・`KeepForDisplayModel`・
`RenderCacheRunOne`・`DisplayModel::RenderFinishedAsync` / `RenderFinished` を追った。
色入力と世代の公開、要求取得、挿入は request → cache の順で保護する。
旧世代の完了を捨てる処理と、表示補正で変換 PDF を作り直さない処理は維持できる。

F12・サイドバーは `StartRendering`・`RenderThumbnailsInBackground`・`FinishThumbnailRender`・
`FinishThumbnailWorker`・`DetachThumbnailCache`・`RefreshPage` と `BgJob` を確認した。
エンジン参照と UI 世代を別に保持し、切り離した結果は解放する。
Home は `ColoredThumbnail`・`ReadColorData`・`FreeThumbnailData` の中立 PNG と表示用コピーを確認した。
Merge PDF の補正なしの色入力、印刷の `PrintData` と Win11 `Initialize` の Clone / AddRef も照合した。

### 入力・コマンド・画面状態

`GetKeyTarget`、`MaybeTranslateAccelerator`、`FindAcceleratorsForHwnd`、Vim/count の入口、
注釈配置・選択・フォーム・サムネイルのキー優先処理を確認した。
文書 HWND と実フォーカスは別に判定する。edit・tree のテーブルと、モード固有の配送を統一し直す根拠はない。
`Canvas::OnTimer` の再読み込みは別の文書置換入口であり、保存確認を共有していない点が R1 につながる。

`ClearMouseState`、`CloseDocumentInCurrentTab` の選択・配置・フォーム解除と、
`RefHoverScheduleLink`・`RefHoverHide`・`RefHoverRequestRender`・`RefHoverRenderThread`・`RefHoverRenderDone` を追った。
hover は要求にエンジン参照を持たせ、UI 側で生存と世代を確認する。
通知の全種類、全コマンド、全ポップアップは対象経路以上に列挙していない。

### 編集・Undo/Redo

`AnnotEngineMupdf`・`AnnotationEditor` の生成・失敗記憶と atomic な公開、
`AnnotationIsLive`・`SetWidgetValue`・`ToggleFormButton`・`UpdateFormFieldPage`・`MarkNotificationAsModified`、
`EngineMupdfBeginOperation` / `EndOperation`・`SyncPagesAfterUndoRedo`・`ResyncWrapperList` を確認した。
UI の描画更新と、エンジン内の文字列・要素の無効化は同じ操作ではない。R4 はこの境界の欠落である。

墨消しは `RedactAllPages`・`RecordRedactedPages`・`RecomputeRedacted`・`SyncRedacted`・
`EngineMupdfPageRedacted`・`EngineMupdfRedactedEngine` と PDFium の `RedactedEditor` を照合した。
本文・検索・複製の参照先を、Undo 位置から切り替える必要がある。
適用済みページを元入力から複製しない設計は維持する。

文書 JS の `LoadDocumentJs`・MuPDF の `pdf_enable_js`、フォーム操作の base context 利用、
権限値の取得と標準ビルドのポリシーを確認した。
権限テストは「禁止を必ず強制する」試験ではなく、禁止情報を読み、標準ビルドと同じ印刷・フォーム方針を確認する。
署名は `BuildSignArgs`・`DoSign`・`EngineMupdfSignDocument` の入力検証、変更、失敗、保存まで追い、R3 を再現した。

### 保存・複製・再読み込み

`SaveFileAs`・`GetFileData` と `SaveAnnotationsToExistingFile`・`SaveAnnotationsToMaybeNewPdfFile`、
`EngineMupdfSaveUpdated`・`WhyNotSaveFromMemory`、`ReloadDocument`・`ReplaceDocumentInCurrentTab` を確認した。
元データコピーと編集内容の保存は別の API。大きい PDFium 入力は出力切り詰め前に実体比較する。
保存ダイアログ後はエンジン参照と現在タブを再確認する。
watcher による自動置換には未保存編集の判定がなく、R1 が残る。

通常 Clone が未保存注釈を含まないことは既存の明示された制約である。
印刷・F12 の挙動変更として扱うべきで、元データ取得 API を編集済みシリアライズへ変える案は採らない。
シリアライズには保存・journal の副作用があるためである。
実機印刷・スプーラー・配布・DLL 登録は検証していない。

### 閉じる・終了

`MaybeSaveAnnotations`・`CloseTab`・`CloseWindow`、`WindowTab::~WindowTab`、
`DeleteControllerAsync`・`WaitForRendersThenDelete`・`DeleteControllerFinish`・`WaitForPendingControllerDeletes`、
`DisplayModel::Retire` / デストラクターと `RenderCache::AbortRendering`・`CancelRenderingBlocking`・デストラクターを確認した。
タブを切り離し、新規要求を止め、描画終了を別スレッドで待ち、UI で解放する通常経路は維持できる。
スレッドの HANDLE 解放には R6 がある。
検索終了とのロック競合がある場合の待機まで、一律に非同期化する案は採らない。

サムネイルと hover はキャッシュ・要求側がエンジン参照を保持する。
終了時は pending controller の UI 投稿を処理してから render cache を破棄する。
`RenderCache` の 5 秒 join 失敗後は、スレッド停止を証明せず破棄を続ける。
通常のモデル終了待ちを通る試験ではこの分岐を検証できず、停止不能ワーカーの障害注入は未実施。
ここは R6 修正時の寿命検証と分け、停止処理の追加点検対象として E32 に残す。

## 評価観点ごとの判断

| 観点             | 判断・根拠                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 責務・依存       | UI → 共通編集 API → MuPDF の境界を維持する。文書置換の保存判定・対象検証は UI、編集の確定変更と無効化は共通編集層、停止後の解放判断は所有者へ置く（R1・R2・R4・R9–R11・E32）。                        |
| API 契約・正しさ | 元入力・編集内容・部分取得を区別する。署名・フォームの失敗と変更有無、墨消しの部分成功を別に返す必要がある（R3・R8・R10・R11）。Try の全件取得・全エンジン非待機化は保証しない。                      |
| 状態・寿命       | 元入力と編集参照の寿命は source-lifetime で照合。未保存状態は R1–R3・R10、取得済みテキストは R4/R7、thread HANDLE は R6、ダイアログ対象は R9、停止後の解放は E32。                                    |
| 非同期・同期     | 通常のタイル挿入、サムネイル世代、文書破棄の終了待ちは維持。E32 は停止確認前の解放を禁止する所有者側の境界を選んだ。停止不能時の実行検証は修正時に行い、通常系通過から保証しない。                    |
| 構造・保守性     | 全面分割より、文書置換の保存判定と変更時の無効化の集約を優先する。PDFium 全体を汎用 backend 群へ分割すると、ページ・入力・ロックの引数と寿命境界が増える。                                            |
| データ整合性     | 元入力保持・同一ファイル判定・墨消しの参照先は維持。編集通知漏れと部分成功は R10/R11。非 PDF の保存・Clone は形式ごとに元パス依存を確認し、一律の入力保持へ変更しない。                               |
| 性能・応答性     | Try hover、UI 外での描画終了待ち、テーマ変換 PDF の再利用を維持。MuPDF 代替描画はタイルごとに context/document を開くが、共有化は同期・保持量を増やすため測定前に変更しない。                         |
| 検証可能性       | 過去の対象テストと今回の8構成は分けて記録した。保存確認を省く Quit、事前キャッシュなしのフォーム保存、成功する Undo は途中失敗を保証しない。不足する失敗分岐は E32・E36・E37 の回帰試験条件を定めた。 |

## E25: 指摘と最小変更案

E24 で確認した指摘と変更候補。継続点検の R7–R11・E32 と合わせた実施順は末尾に記録した。

### R1 / E26 — P1: 自動再読み込みが未保存編集を捨てる

E26 で修正済み。自動更新は未保存・入力中に保留し、更新待ちを保持する。
手動 Reload は入力確定後の保存確認を通す。以下は修正前の指摘。

- **不具合・変更する。** [Canvas.cpp:4999](../../src/Canvas.cpp#L4999) → [ReloadDocument](../../src/SumatraPDF.cpp#L2410) は、dirty を確認せず controller を置換する。
- フォームを `NEWWORD` に変更し、別プロセスから元 PDF を `DISKWORD` の PDF で上書きすると、確認なしに `modified=0`・`canUndo=0` となる。両エンジンで各 2 回再現した。
- 既存の source-lifetime は watcher を無効化している。form-js は保存後の値だけを確認する。
- 最小案は `ReloadDocument` の自動更新入口で未保存時の置換を保留し、変更通知を残すこと。タイマー側だけの防止ではタブ再選択の経路を漏らす。手動 Reload は破棄の確認を通す。
- 回帰試験は watcher 有効で編集→外部置換→タブ切替。編集・Undo を保持し、保存または明示破棄後に更新できることを確認する。保存直後の intentional reload は clean のまま通す。

### R2 / E27 — P1: 元パス消失時に保存確認を省略する

- **不具合・変更する。** [MaybeSaveAnnotations](../../src/SumatraPDF.cpp#L5294) は `file::Exists` が false なら、未保存判定前に閉じることを許す。
- 小さい PDF のフォーム編集後に元ファイルを移動し、`WM_CLOSE` を送ると確認なしで exit 0。同じ編集で元ファイルを残す対照例は保存確認を表示する。両エンジンで再現した。
- source-lifetime / saveas はコピー可能性を確認するが、終了時の保存確認は検証しない。`client.quit()` は先に全タブを discard するため、この条件の検証には使えない。
- `EngineMupdfHasUnsavedAnnotations` は既存編集のフラグを読むだけなので、パスの存在より先に判定できる。最小案は dirty 時に確認を残し、元入力を保持する場合は新規 PDF 保存を提示すること。元ファイルを失った mmap 文書の実アクセスまで無条件に許す変更は避ける。
- small / handle / メモリ添付、rename / delete、SaveNew / Cancel / 保存失敗で検証する。ng の `AnnotationsNeedSavePrompt` にも同じ存在判定がある。共通の判定を変える場合はその呼び出し側も照合する。

### R3 / E28 — P2: 署名の途中失敗が未保存とされない変更を残す

E28で修正済み。[実装・検証記録](history.md#e28-signature-rollback-2026-11-10)。以下は修正前の指摘。

- **不具合・変更する。** [PdfSign.cpp:298](../../src/shared/PdfSign.cpp#L298) は新規 widget を作り、`Prepare signature` を確定した後に画像を読む。画像エラー時は rollback せず false を返し、成功時だけ dirty を立てる（同ファイル 325–364 行）。
- 有効な使い捨て PFX と壊れた既存 PNG を指定してページ上に配置すると、エラー後も署名の配置候補が 1→2、`canUndo=1`・`modified=0` となる。両エンジンで UI 経由で再現した。
- `ad-hoc-pdfium-signing` は成功・再開封・署名検証、`ad-hoc-sign-document` の失敗は変更前の誤パスワードを確認する。この途中失敗は未検証。
- 最小案は画像等の失敗し得る入力を文書変更前に読むこと。その上で field 作成・Lock/Certify 設定・署名準備を一つの取り消せる操作にする。失敗時だけ dirty を立てる案は、失敗した操作の残骸を利用者へ渡すため採らない。
- 新規・既存 field、壊れた画像、署名準備中の失敗で field 数・Lock/Certify・Undo 位置・dirty の不変を確認する。既存の署名検証テストも通す。共有 `PdfSign.cpp` なので ng の呼び出し側にも同じ契約を適用する。

### R4 / E29 — P2: フォーム編集後の検索が旧値を使う

**E29 で修正済み。** フォーム setter の試行後と Undo/Redo で全取得済みページを無効化し、
PDFium は editor の世代を追従する。検索の継続・件数・snippet・選択も更新する。
受理や dirty の変更検出は E35/E36 に残し、E29 は拒否時も保守的に無効化する。
[検証記録](history.md#e29-form-text-cache-2026-11-10)。以下は修正前の指摘。

- **不具合・契約の欠落・変更する。** [SetWidgetValue](../../src/shared/Annotation.cpp#L626) → [MarkNotificationAsModified](../../src/shared/EngineMupdf.cpp#L13852) は表示リストを無効化するが、`EngineBase` のテキストを無効化しない。PDFium 側も独立したキャッシュを持つ。
- `cached-text` で `OLDWORD` を取得してからフォームを `NEWWORD` に変更すると、値と view/print 画素は変わるが、取得文字列は旧値のまま、新値の検索は `found=0`。両エンジンで再現した。
- `ad-hoc-pdfium-forms` と form-js は値・画素・保存を確認する。編集前の完成済みテキストを温めないため、この不整合を検出しない。
- MuPDF 内の `InvalidateTextForPage` だけでは PDFium の外側キャッシュが残る。最小案は編集成功を共通の変更通知に集約し、編集エンジン・表示エンジン双方の文字列と検索状態を無効化すること。JS が他ページの値も変えるため、フォームは当面全取得済みページを対象にする。
- 実 UI の編集確定→検索・選択、checkbox / choice / 計算 JS、Undo / Redo を確認する。借用文字列・座標の寿命も ASan で確認する。ng `FormFields.cpp` も同じ setter を呼ぶため、UI だけへの個別修正は避ける。

### R5 / E30 — P2: ネットワーク CBX の同サイズ更新を検出しない

- **コード上の不具合・変更する。** [EngineCreate.cpp:37](../../src/shared/EngineCreate.cpp#L37) のキーは path + size だけ。[同 140 行](../../src/shared/EngineCreate.cpp#L140) はキャッシュの存在だけで再利用する。`EngineCbx::CreateFromFile` も元の更新時刻を比較せずローカルコピーを開く。
- 同じパス・サイズの CBX が更新されても、再度開くと旧ページを読む。RAR、またはメモリ読み込み上限を超える CBX が該当する。実際の SMB 再現は未実施。
- `cbr-network-unrar` は最初の読み込み・赤いページ・ファイル経由の解凍を確認する。管理共有がなければ skip し、更新後の再開封は確認しない。
- 最小案は元ファイルの更新時刻も再利用条件に加えること。全内容 hash はネットワーク読み込みを再導入するため採らない。
- 次は同サイズで色だけ異なる archive を用意し、UNC 上で更新→再開封を確認する。共有コード変更時は ng の factory もビルド確認する。

### R6 / E31 — P2: 非同期 controller 破棄の thread HANDLE を閉じない

- **コード上の不具合・変更する。** [DeleteControllerAsync](../../src/SumatraPDF.cpp#L1170) は `StartThread` の戻り値を成功判定に使うだけで捨てる。`StartThread` は `CreateThread` の生 HANDLE を返し、自動では閉じない。
- 描画中の文書を閉じ、非同期破棄へ進むごとに HANDLE を失う。通常の描画待ち設計を変える必要はない。
- sidebar-thumbnails-close は終了コード、source-lifetime の HANDLE 比較は Clone の反復を確認する。controller 破棄の反復は確認していない。今回の HANDLE 増加量は未測定。
- 最小案は戻り値を保持し、成功時に `SafeCloseThreadHandle` すること。失敗時の UI スレッド破棄への代替は維持する。
- 描画開始を確認してから閉じる反復と、描画終了後に閉じる対照例で HANDLE 数を比較する。ASan でモデル寿命も確認する。ng は別の破棄入口なので Win32 修正を機械的に共有しない。

## 変更不要・保留

変更不要の判断は今回読んだ範囲に限る。変更候補を組み合わせる実施順は末尾に記録した。

- **変更不要:** PDFium の DLL・フォント・参照数は既存 `PdfiumRuntime` に留める。`EnginePdfium` 全面分割や新しい汎用 backend 層は、今回の欠落した保存・変更通知の契約を解決しない。
- **変更不要:** `RenderCache` の要求管理と `RenderViewPage` の合成を、今回ただちに別クラスへ分けない。表示入力を値で渡し、実描画結果の色状態を返す契約は既に共通化されている。
- **変更不要:** 通常の描画終了待ち、元入力と編集データの API 分離、テーマ PDF とタイルの別キャッシュ、Try 要素取得の部分結果を維持する。
- **契約問題 / E32:** 停止未確認のワーカーを残したキャッシュ破棄を Debug で確認した。再開時のメモリアクセスと停止中のロック位置は未確認。末尾の継続点検を参照。
- **不具合 / E33:** 取得復旧後も完成済み空テキストが残ることを再現した。R7 として末尾に記録する。
- **保留:** MuPDF 代替の文書再利用、全非 PDF API の非待機化。効果量と寿命・同期の負担を測る入力が今回の再現には不要で、独立した最適化として扱う。
- **対象外:** 計画どおり ng の機能開発、D3、F1/F3 実機、配布、DLL 登録、クラッシュ復旧の実地確認。OOM・デバイス喪失・全コーデック・全ダイアログの障害注入も行っていない。

## E24 の残件処理

- E32 の終了契約は末尾で比較・選定した。通常のモデル待機を維持し、停止不能時に共有資源を解放しない。実装・回帰試験は修正作業として残す。
- E34 は保存対象切替と終了再入の診断を今回記録した。同じ scratch 実験は繰り返さず、修正時の対象検証と回帰試験を設計する。
- 編集途中失敗は journal の確定・破棄、wrapper、dirty、UI 通知まで追い、R10/E36・R11/E37 として判断した。実行再現済みとは扱わない。
- 非 PDF の元パス依存は今回ローカル7ケースで確認した。未確認入力への保証は広げず、E25 の責務再構成案と優先順位を確定する。

## 実行した検証

Debug、VS 2026 v145、Bun 1.4.4、Windows 10.0.26300。GUI は全てサンドボックス外の非表示 desktop。
製品コード差分なし。`-for-testing` と専用 `-appdata` を使用した。

`bun cmd/solok-build.ts -quick` はサンドボックス内で FileTracker のアクセス拒否により失敗し、
外で再実行して警告 0・エラー 0。Release・ASan・全スイートは実行していない。
寿命を変更していないため、ASan は R6/E32 の変更時に実施する。

対象テストは `--no-build` 相当で同一 exe を使用し、全 13 本が通過、skip なし。
一覧・入力・時刻・ログ・exe/DLL の SHA-256 は検証データを参照する。
うち 1 本は非表示 desktop の確認、12 本が上記経路の検証である。

再現プローブは R1–R4 の現行挙動を観測するもので、終了コード 0 を正常動作の判定には使っていない。
署名プローブの初期版はコントロール生成待ち不足・同期クリックでのモーダル待ち・ヘルパー引数誤りがあり、
プローブだけを修正して再実行した。製品のクラッシュやテスト通過として扱っていない。
この初回実行では R5/R6 と E32/E33 は未検証だった。E32/E33 の継続結果は次節を参照する。

プローブを再実行する場合は検証データの `reproducers[].source` を対応する `path` へ復元し、
Debug をビルドした後、`bun tools/solokpdf/run-hidden.ts -- bun <path>` で実行する。
通常入力は `OLDWORD` のフォーム、外部置換は `DISKWORD`、署名はローカル生成の PFX と壊れた PNG。
利用者の文書・証明書・設定は入力に使っていない。

## E24 継続点検（2026-11-10、`0046373df`）

製品コード差分なし。初回と同じ Debug exe/DLL の SHA-256 を照合した。
追加証拠は [継続検証データ](data/full-review-followup-2026-11-10.json)。Release・全スイートは実行していない。

### R7 / E33 — P2: 一時的な取得失敗を空テキストとして保持する

- **不具合・変更する。** `EnginePdfium::TextLocked`（2812行）はページ取得失敗に `{}` を返す。`ExtractText` はそのまま返し、`TryExtractPageText` も `needsEditor=false` なので成功とする。
- `EngineBase::ReadPageText`（1122行）→ `EnsurePageText` → `TextCacheEntry::StoreText`（589行）は失敗と空ページを区別せず `Finished` にする。検索の `GetTextForPage` はこの完成済み結果を再利用する。
- 5ページの合成 PDF の1ページ目は `RETRYWORD`、5ページ目を表示した。Debug の PDFium ページ取得だけを一時的に失敗させたところ、直接取得は9文字→0文字→9文字と復旧したが、失敗時に作ったキャッシュは復旧後も `chars=0 text=` だった。バイナリファイルは変更していない。検索 UI の操作自体は実行していない。
- MuPDF も `ExtractPageText`・`ExtractPageTextLocked` の失敗は `{}`、Try は取得不能のページにも `true` を返す。同じ共通キャッシュへ入るが、MuPDF の失敗注入は未実施。
- `ad-hoc-pdfium-try-reads` は editor 生成失敗時の partial とロック競合を確認する。ページ取得失敗からの復旧は確認しない。
- 最小案は取得結果で失敗を明示し、キャッシュを完成にしないこと。空ページは完成のまま保持する。単に全ての空結果を再取得する案は、空ページを読むたびにデコードするため採らない。`partial` の流用は失敗と利用可能な部分結果の意味を混ぜる。
- 修正前に共通キャッシュの失敗→復旧、完成済み空ページ、partial→完成、非待機の競合を試験する。`src/shared/EngineBase.cpp` は ng と非 PDF も使うため、既定の成功結果を壊さず、失敗を返す各実装と呼び出し側を照合する。

### E32 — 停止未確認のワーカーを残した解放

`RenderCache::~RenderCache`（300行）、`RenderCacheThread`、`ClearCurrentRequest`、`CancelRenderingBlocking`、
`JoinThread`（`src/base/Base.cpp:653`）、`WaitForPendingControllerDeletes`、終了時の `uitask::Destroy` まで追った。

- **寿命の契約問題・変更する。** Win32 の `JoinThread` は timeout でも HANDLE を閉じる。デストラクターはログだけで進み、キャッシュ内の semaphore・mutex と本体を破棄する。ワーカーが復帰すると `requestAccess` や `shouldExit` に触れる経路が残る。HANDLE を閉じてもスレッドは止まらない。
- 通常の文書破棄は先に `CancelRenderingBlocking` を待つ。描画そのものが停止不能なら pending controller の待機で止まり、キャッシュの5秒タイムアウトまで到達しない。タイムアウトだけを長くしても、通常終了の停止不能は解消しない。
- Debug では `WaitRenderIdle` 後に1ワーカーを停止し、終了時に thread 0・2 の timeout ログと exit 0 を観測した。文書描画中ではないが、停止位置が idle bookkeeping のロック内だった可能性があり、「semaphore 待機中だけを止めた」とは断定しない。再開時の UAF は未再現。
- ASan Debug の現行ビルドは警告0・エラー0。停止ワーカー検証は後続プローブの失敗前に終了条件を満たしたが、結果 JSON と stderr を保存し損ねたため、ASan 寿命検証の合格には数えない。timeout ログは残した。
- 最小案は所有者側で停止の成否を確定してから `delete` すること。終了専用であれば停止不能時は参照先を残してプロセス終了する案と、停止保証まで待つ案を比較する。デストラクター内の早期 return だけではメンバー破棄を防げない。
- 修正時は協調的に停止位置を制御するテスト入口を設け、要求中止・UI 投稿・join・解放の順序を ASan で確認する。外からのスレッド停止を回帰試験にはしない。

### 再入と対象寿命 / E34（未確定）

`ReloadDocument`、`HwndPasswordUI::GetPassword`、`ReplaceDocumentInCurrentTab`、`SaveCurrentFileAs`、
`SaveAnnotationsToMaybeNewPdfFile`、`MaybeSaveAnnotations`、`CloseTab`・`CloseWindow`、
`IsLoadTargetValid`・`IsLoadStillWanted`・`LoadDocumentAsyncFinish` を照合した。

- 非同期 open は対象ウィンドウ・タブと要求されたパスを再検証し、不要な engine/controller を解放する。編集保存ダイアログは元エンジンを AddRef し、復帰後に現在タブと同一エンジンを照合する。この境界は維持できる。
- 同期 `ReloadDocument`（2480行付近）はパスワード入力後に、元の `tab`・`win` の生存と controller の同一性を再検証しない。`LoadArgs(tab->filePath, win)` と編集 UI の無効化が元タブを使う一方、置換関数はその時の現在タブを選ぶ。閉じる再入なら寿命、タブ切替なら置換先に疑いがある。
- `SaveCurrentFileAs`（5784行付近）はダイアログ後に `win->IsDocLoaded()` を呼ぶだけで、ウィンドウ生存と元文書の同一性を確認しない。dirty の編集保存と共通の対象検証が必要かを E34 で判断する。
- 合成 PDF を暗号化した入力へ置き換え、手動 Reload のパスワード入力中に `CmdClose`、その後ダイアログを閉じるプローブを実施した。ログには元 `WindowTab` の破棄まであり、その後の要求はパイプ切断で失敗した。終了コード・ASan 診断を保存できていないため、不具合の実行再現とは数えない。無効化された親への投稿コマンドなので、通常のキー操作での到達性とも区別する。
- 最小候補は、安定したパスと元エンジン参照を保持し、復帰時に生存・同一性・現在タブを検証すること。不要になった新 controller と `FileState` も解放する。全 open を非同期へ統合する案は browser controller とパスワード UI の変更が広がるため、この欠落だけの修正としては採らない。
- 既存 `ctx-menu-reload` は ASan Debug で4.0秒、skipなしで通過した。画像のメニュー中の watcher 保留と閉じた後の更新を確認する試験で、同期 Reload のパスワード中の破棄は対象外。

### 非 PDF・入力・編集の追加確認

| 経路       | 読んだ実装・判断                                                                                                                                                                        | 残る検証                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 画像       | `EngineImage::Clone` は画素と `sourceData` を複製する。`EngineImages::GetFileData`・`SaveFileAs` はパスを優先するため、Clone と保存で元入力保持を同一視しない                           | 元パス消失・置換後の保存出力                                                                            |
| CBX        | `EngineCbx::Clone` はメモリ入力か `physicalPath` を使い、`CreateFromFile` のローカルコピーを再利用する。factory のキャッシュ再利用は R5 のまま                                          | 同サイズ UNC 更新。`cbr-network-unrar` は初回の経路のみ                                                 |
| EPUB 等    | `EngineEbook::CloneFromSource` は保持データがあれば複製し、それ以外はパスから再読込。`GetFileData`・`SaveFileOrData` は現在のパスを優先する                                             | 置換後の Clone/保存。全形式への PDFium と同じスナップショット保証は追加しない                           |
| DjVu       | `EngineDjvuDec::Clone` はパスを優先する。`Load` は大きいローカル入力を mmap、小さい入力をコピーし、デストラクターは decoder を破棄してから入力を解放する                                | パス消失後の Clone は失敗し得る。保存と描画の継続を分けて確認する                                       |
| PostScript | `EnginePs::Clone` は変換済み PDF とそのデータを所有する。PDF 保存は変換結果、それ以外は元 PS のコピーで契約が違う                                                                       | Ghostscript が必要な実行確認は未実施                                                                    |
| 入力       | `MaybeTranslateAccelerator` の caret→配置/自動スクロール→reading bar→hint→thumbnail→annotation nudge の順と入力先の制限を照合。`WndProcFormCtrl` は Enter/Tab/Escape・focus lost を扱う | 全モードの組合せ試験ではない。既存の優先処理を統一する根拠はない                                        |
| フォーム   | `CommitFormFieldEdit` は HWND 破棄前に状態を消して再入を防ぐ。`SetWidgetValue` は base context と docLock を使い、通知はロック外。`ToggleFormButton` の radio 操作は例外で abandon する | setter 後の appearance/JS 更新が失敗した場合の dirty/通知。checkbox と radio も同じ成功契約とは限らない |
| 墨消し     | `RedactAllPages`→`EngineMupdfApplyRedactions` は対象ページと削除 wrapper を集め、本文・text を無効化し、Undo位置に記録する                                                              | 複数ページの途中失敗時に、変更済みページ・wrapper・dirty が揃うかを追加点検する                         |

共通 API の全入力保持を強めると、大きい画像・archive・DjVu のコピーとメモリ保持が増える。
現時点では「複製は独立した所有者、保存は形式ごとの元入力契約」という境界を保ち、R5 の鮮度問題を個別に直す案を優先する。

### 検証の中断と記録の限界

最初のレビュー turn と「続けて」の turn は、会話側で `This content was flagged for possible cybersecurity risk` として失敗した。
承認待ち・ビルド待ちではなかった。判定理由の詳細は取得できていない。
これ以降、プロセスメモリの書換え・スレッド停止による追加検証は行わず、コード精読と既存テストに切り替えた。
scratch のプローブは自動回帰試験へ登録していない。製品の不具合修正・コミットは行っていない。

## E24 継続点検（2026-11-10、`a272e9137`）

製品コード差分なし。Debug exe・DLL と Debug ASan exe の SHA-256 は前回記録と一致した。
GUI は非表示 desktop、`-for-testing`、専用 `-appdata` を使用した。
以下は今回の確認結果であり、E24/E25 の完了を意味しない。
入力・プローブのソース・結果・ログの hash は[検証データ](data/full-review-contracts-2026-11-10.json)に保存した。

### R8 / E35 — P2: 選択項目の入力拒否を成功とする

- **不具合・変更する。** `SetWidgetChoiceValue`（`src/shared/Annotation.cpp:687`）は `pdf_set_choice_field_value` の戻り値を捨て、常に `true` を返す。共通の `SetWidgetValue` はこれを受けて `MarkNotificationAsModified` を呼ぶ。
- MuPDF の同関数は `pdf_set_text_field_value` の結果を返す。入力検証 JS の `event.rc = false` では値を変更せず `0` を返すため、成功通知と dirty が実際の文書変更に一致しない。
- 合成フォームで `first` → `second` を拒否させると、choice は `OK before='first' after='first'`・`canUndo=0 modified=1`。text の対照例は `ERROR`・`modified=0`。両エンジンで各2回確認した。
- 既存 `ad-hoc-pdfium-forms` は受理された choice の描画・保存を、`ad-hoc-pdfium-form-js` は計算を確認する。拒否を検証しない。
- 最小案は choice でも戻り値をそのまま成功判定へ渡すこと。text/choice の共通処理は維持する。共有 setter を使う ng にも適用される。
- 修正時は拒否→値・dirty・Undo 不変、受理→描画・保存、JS 無効時の受理を先にテストする。途中例外による変更の扱いとは分ける。

### R9 / E34 — P1: ダイアログ後の文書対象と借用パスを検証しない

- **不具合・変更する。** `SaveCurrentFileAs`（`src/SumatraPDF.cpp:5790`付近）はダイアログ後に現在文書を再取得するが、ダイアログを開いた文書との同一性を確認しない。
- `original.pdf` の Save As 中に、既存の DDE `[Open("other.pdf",0,0,0)]` で別タブを開く。元の保存ダイアログに `saved.pdf` を指定すると、出力は `original.pdf` ではなく `other.pdf` とバイト単位で一致する。Debug と Debug ASan で確認し、両方 exit 0・stderr 空。親が無効な状態でも、外部の通常の文書オープンは配送される。
- Reload プローブはパスワード画面を標準ダイアログの `#32770` と仮定したが、実装は `CreateCustom` を使う。画面を見逃した後、後片付けの `client.quit()` がパスワード画面のループへ再入した。DDE の段階には到達していない。
- この終了再入では exit 1 と ASan の解放済みメモリ参照を保存した。`WindowTab::~WindowTab` が `filePath` を解放し、同期 `ReloadDocument` から借用されたパスを `CreateEnginePdfium` の失敗ログ（3403行）が読む。通常の物理キーによる到達性は確認していない。単なるパイプ切断とは区別できた。
- 最小案はダイアログ前にパスと元エンジンを保持し、復帰後の窓・タブ・エンジン・現在タブを照合すること。Reload は factory に渡すパス自体を所有しておく。不要な controller と `FileState` は破棄する。
- `ctx-menu-reload` は watcher とコンテキストメニューを確認する試験で、この経路を確認しない。修正時は専用の回帰試験で保存対象の不変・対象喪失時の中止・失敗時解放を検証する。今回の終了処理を含む scratch プローブをそのまま登録しない。

### 非 PDF の元パス依存（実行確認）

watcher を無効にし、ロード済み文書の元パスを移動、または移動後に別内容を同じパスへ置いた。
PNG・CBZ は白→黒、EPUB は `ORIGINALWORD` → `REPLACEDWORD`、DjVu は既存の小さい fixture を使った。

| 入力         | 元パス移動後の Clone / Save As                | 同パスの別内容への置換後                                                   |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------------- |
| PNG          | 白い画素を複製できる / 保存失敗               | Clone は黒、保存は置換後のバイト列                                         |
| ローカル CBZ | Clone・保存とも失敗                           | Clone は黒、保存は置換後のバイト列                                         |
| EPUB         | Clone・保存とも失敗                           | Clone は新しい単語、保存は置換後のバイト列。元エンジンのキャッシュは旧単語 |
| 小さい DjVu  | Clone は失敗 / 保持データから元バイト列を保存 | 未実行                                                                     |

`EngineImage::Clone` の画素コピーだけからスナップショットとは判断できない。
`LoadFzImageForPage` → `GetImageData` は、Clone に rawData がないと現在のパスを読む。
元パス消失時はコピー済み画素へ代替できるが、`SaveFileOrData` に渡す `sourceData` はファイル入力では空である。
CBX のメモリ化はネットワーク小容量入力に限られ、今回のローカル CBZ には適用されない。

**契約の差・共通 API の一律変更は保留。** PDFium の入力保持を全形式へ広げると、archive・大画像の保持量と既存の再オープン動作が変わる。
通常の Clone が元パスを再読込する形式では、元の表示と印刷用 Clone が異なり得ることを明示する。R5 の同一キャッシュの鮮度問題とは分ける。
UNC・大画像・mmap DjVu・データ入力・PostScript と実機印刷は今回確認していない。

### 編集途中失敗のコード確認

`pdf_set_text_field_value` と `pdf_toggle_widget` は内部の値更新例外を journal の abandon で戻す。
一方、`ToggleFormButton` は値更新の確定後に appearance とページ更新を行い、全てが終わってから `changed=true` にする。
その間の例外では確定済みの値と dirty/通知が食い違い得る。text/choice の拒否（R8）と同じ問題として片付けず、途中失敗の回帰試験設計を残す。

墨消しは `pdf_redact_page` のページ内失敗を abandon し、外側の操作は成功ページを一つの Undo にまとめる。
成功したページの wrapper・描画・text と dirty の更新は行うが、失敗ページは continue し、`any` が true なら UI は `Redactions applied.` と通知する。
`createdRedactMark` も false になるため、未適用のマークが残る部分成功を成功と区別する契約が必要である。
`ad-hoc-pdfium-redaction-undo` は正常な適用・Undo・検索・印刷用 Clone を確認し、ページ途中失敗を検証しない。
これらはコード上の指摘であり、今回の失敗注入・部分成功の実行再現として数えない。

### 中断を局所化する手順

`history.md` の前回中断記録を踏まえ、各ケースの結果を完了直後に保存する。
GUI はケースごとに制限時間を設け、期待されるエラーダイアログも閉じる。
失敗・未実行を正常終了と区別し、後続ケースの失敗で取得済みの結果を失わないようにする。
プロセスメモリの書換え・スレッド停止による検証は再開しない。

今回のフォームプローブ初版は、事前の `TestMarkupAnnots` が PDFium の編集エンジンを JS 無効で生成し、拒否を確認できなかった。
副作用のない `editor` 状態取得へ替えて再実行した。製品の失敗や修正として数えない。
非 PDF の初回プローブは画像保存失敗の警告を閉じず、そこで待機した。
完了済みフォーム8ケースの JSON は残っており、画像ケースを単独・45秒制限でやり直して保存失敗を確認した。

### 会話中断の原因確認

`codex_tui.read_thread` で、このスレッドの2 turn が `failed`、1 turn が `interrupted` と確認できた。
2件の失敗理由はともに `This content was flagged for possible cybersecurity risk.`。承認待ちや runner の timeout ではない。
具体的な対象コンテンツ・内部判定理由は取得できず、アプリの ASan 診断との因果関係は確定できない。
プローブの失敗と会話の失敗を混同した初期対応では不十分だった。

同じ再入・障害再現プローブを繰り返さず、当面のレビューはコード精読と対象の既存テストで進める。
必要な失敗再現は、修正時に専用の回帰試験入口と終了手順を先に設計する。
再開時は会話の失敗状態、実行中プロセス、保存済み結果を確認して未完了分だけを進める。
安全判定は助手から無効化できず、再発しない保証もできない。

## E24 完了確認

2026-11-10、`a272e9137`＋文書差分。`32d95cef7` から `src/`・`cmd/`・`tests/`・`ext/` の差分なし。
以下で終了契約と編集途中失敗の残件を判断し、E24 を完了とする。
修正・失敗分岐の回帰試験は未実施であり、レビュー全体や E25 の完了ではない。

### E32 の終了契約

`DeleteControllerAsync` → `Retire` / `AbortRendering` → `CancelRenderingBlocking` → `DeleteControllerFinish` と、
`RenderCacheThread` / `ClearCurrentRequest` → `WaitThread` / `JoinThread`、WinMain の終了順を再確認した。
`DisplayModel` の通常破棄は `ControllerCallbackHandler::CleanUp` を介して描画終了を待つ。
UI 投稿は `Retire` 後のモデルを実行せず、pending delete の完了は UI 側で数を減らすため、待機中も `uitask::DrainQueue` が必要である。

**契約問題・変更する。** 停止確認はキャッシュの所有者が、共有資源を解放する前に行う。
要求受付の停止・中止・UI 完了処理・全ワーカー停止を一つの終了境界とし、停止済みと停止未完了を明示して返す。
現行 worker はループ先頭で終了すると `ClearCurrentRequest` を通らない。停止を pending 待機より前へ移すには、退出時も要求を必ず解除してから worker のスタックを失わせる必要がある。
Win32 では既存 `WaitThread` なら timeout 後も HANDLE を保持できる。全停止の確認後にだけ HANDLE とキャッシュを解放する。
停止未完了ならキャッシュだけを残して通常 cleanup を進めず、UI task・engine/runtime・共有フォント等も保持したまま既存の fast-exit 方針で終了する。
この判断は `WaitForPendingControllerDeletes` の無期限待機より前にも必要であり、デストラクターの5秒 join だけの変更では足りない。
停止処理自体も worker のロックを無期限に待たない条件が必要である。通常のタブ破棄を timeout で解放する変更や、全ての終了待ちが既に有界であるという判断はしない。

| 案                                              | 判断                                                           |
| ----------------------------------------------- | -------------------------------------------------------------- |
| join の時間を延長・無期限化                     | 採らない。モデル待機側の停止不能も残り、終了が戻らない         |
| timeout 後に cache だけ残す                     | 採らない。後続 cleanup が worker の依存先を解放する            |
| 所有者の停止結果で cleanup / fast exit を分ける | 採る。通常のモデル寿命と停止不能時の保持を同じ境界で説明できる |

Debug/ASan は既定で cleanup、通常 Release は既定で fast exit となるコードを確認した。Release は実行していない。
`RenderCache` は ng も共有し、ng は同期のモデル待機後に cache を破棄する。共有の停止 API を変える場合はその所有者も対応させる。
新しい汎用ワーカー管理層や `JoinThread` 全体の契約変更は不要である。
修正時はテスト用エンジンの協調的な完了制御と停止結果のテスト入口で、停止後の解放・停止未完了時の保持・UI 投稿順を ASan で確認する。
今回それらを新規実行せずとも解放条件の欠落はコードで判断できる。停止不能経路を試験済みとはしない。

### R10 / E36 — P2: 編集確定後の失敗で変更通知を失う

- **コード上の不具合・変更する。** `Annotation.cpp` の `UpdateAnnotIf`（184–205行）は setter 後の `pdf_update_annot` / bounds 取得が失敗すると `changed=false` にし、変更通知を省略する。`ToggleFormButton`（554–580行）も値を確定した後の表示更新まで終わらないと `changed` を立てない。
- MuPDF の値 setter と appearance 更新は別の操作である。後者の abandon は既に確定した値を取り消さない。`SetWidgetValue`（640–653行）は別の戻り方をし、同じ更新失敗に対する変更有無の扱いが揃っていない。
- `pdf_set_text_field_value` は拒否された場合も通常経路では operation を end する。検証 JS が別 field を更新してから拒否するなら、「対象値の拒否」を「文書全体に変更なし」とも扱えない。実行再現はしていない。
- 影響は、値・Undo が変わっても dirty・描画・検索の通知が欠けること。Win32 の `CommitFormFieldEdit` / button click と ng の同じ呼び出し側は、戻り値で再描画を決める。UI だけで dirty を補う案は採らない。
- 最小案は受理結果と確定変更・表示更新失敗を共通の編集結果で分け、確定変更を dirty・無効化・再描画へ必ず通知すること。受理済みの値を表示更新エラーだけで自動 Undo する案は、JS 副作用と wrapper の復元まで広がるため優先しない。R4 の無効化と同じ編集終了境界に集約する。
- `EngineMupdfCreateAnnotation` の通常失敗は作成済み annotation を unlink して参照を返すことも確認した。この既存の作成取消を、表示更新失敗後に変更を残す setter と同一視しない。
- 既存 forms / form-js は受理・計算・保存だけを検証する。修正前に text・choice・checkbox・radio・markup の値確定後の更新失敗と、拒否 JS の他 field 変更を専用入口で確認する。残った値・dirty・Undo・表示・検索の一致を検証する。R8 の単純な拒否とは別条件である。

### R11 / E37 — P1: 墨消しの部分成功を全体成功として通知する

- **コード上の不具合・変更する。** `RedactAllPages`（`EngineMupdf.cpp:12505–12540`）はページ取得・墨消しの失敗を continue し、`EngineMupdfApplyRedactions`（12602–12611行）は成功ページが一つでもあれば true を返す。共通 UI の `ApplyRedactionsInTab` は全体成功を通知し、残る user mark の状態も false にされる。E25 の再点検で、未削除の本文を削除完了と受け取る影響を理由に P2 から P1 へ上げた。過去の検証 JSON の優先度は当時の記録として残す。
- 成功ページの wrapper・本文・text の無効化、dirty、Undo step と PDFium の編集側への切替は維持できる。問題は取得不能・失敗・マークなしを区別しない全体結果であり、失敗ページの本文が未処理でも成功と受け取られる。
- `pdf_redact_page` は journal があれば失敗ページの PDF オブジェクトを abandon する。ただし abandon は Undo の `pdf_sync_open_pages` を行わない。削除後の失敗や live annotation 列挙失敗を、wrapper まで元通りと保証してはいけない。列挙失敗時の現行代替は Redact だけを外す一方、MuPDF は重なる FreeText も削除する。
- 最小案は成功・失敗ページを返し、部分成功では変更したページを保持して警告し、残るマークを維持すること。全ページを一括 rollback する案は既存の部分成功・wrapper 公開を大きく変えるため採らない。失敗・再列挙不能のページは再同期または利用停止し、不確かな wrapper を公開しない。
- journal の生成失敗はログ後に読み取りを続ける。journal なしの abandon は復元しないため、復元を前提に破壊的処理を始めない条件も必要である。
- 既存 redaction-undo と one-step は成功・Undo を確認する。修正時は第2ページ失敗、全ページ失敗、annotation 削除後の失敗、live 列挙失敗、journal なしを専用入口で確認する。成功ページだけの本文・保存出力・dirty と Undo、残る mark・wrapper、部分成功通知を照合する。共有 API と共通 UI を使う ng も同じ契約となる。

### 確認範囲と未実行の扱い

| 操作経路               | E24 の結論・残る修正検証                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| 開く・読み取り・移動   | factory・元入力・部分取得・text cache を確認。R7 の失敗結果を明示する。全非 PDF の非待機化は不要          |
| 描画・表示変更         | 色入力・世代・合成失敗・要求中止・サムネイル所有を確認。現行の層分担を維持し、E32 の停止条件を修正する    |
| 入力・画面状態         | キー優先・form commit の再入抑止・対象切替を確認。R9 の対象検証を追加する。全モードの組合せ試験は対象外   |
| 編集・Undo/Redo        | 通常の作成取消・journal・wrapper 更新と失敗の公開条件を確認。R3・R4・R8・R10・R11 を変更対象とする        |
| 保存・複製・再読み込み | 未保存・元入力と編集結果・同一実体・非 PDF のパス依存を確認。R1・R2・R5・R9 を変更対象とする              |
| 閉じる・終了           | retire・中止・UI 投稿・モデル待機・cache 破棄を確認。通常経路を維持し、R6 と E32 を別の欠落として修正する |

E32・R10・R11 の未実行分岐は、変更条件と期待結果を上で確定した。原因判断に新しい外部操作による障害再現は不要とし、専用入口による実行確認を修正の回帰試験へ残す。
UNC 更新（R5）、controller の HANDLE 増加量（R6）、大画像・mmap DjVu・添付を含む全形式の置換試験は追加していない。
R5/R6 はコードで欠落を特定済み、非 PDF は形式別契約を維持する判断であり、これらを実行済みの保証に広げない。
全 OOM・コーデック・デバイス喪失の故障網羅、ng 機能開発、実機印刷・入力、配布・DLL 登録・クラッシュ復旧は計画の対象外を維持する。

既存 Debug x64 の8構成（desktop probe 1、アプリ試験7）が全て通過、skip なし。
forms・form-js・redaction-undo は両エンジン、one-step は `ANNOT_UNDO_ONLY=redact` を各エンジンで実行した。
theme-render-cancel は通常構成と、キャンセル発生自体を assert する既存 pattern 構成を実行した。
redaction-undo / one-step の後片付けはプロセス終了を待つ寿命試験ではない。これらの通過を終了保証に使わない。
再ビルド・今回の ASan 実行・Release・全スイートはなし。以前の結果と分けた入力・構成・時刻・hash・ログは[完了時の検証記録](data/e24-completion-2026-11-10.json)を参照する。

## E25 再点検

2026-11-10、`44250b78c`＋文書差分。優先順位・依存関係・変更方針・未確認範囲と次の作業を整理し、E25 を完了した。
再点検で補正した条件は以下に記録する。E28/E36 の具体的な実装方式の確定は各修正工程へ残す。
製品修正は未着手で、`32d95cef7` から `src/`・`cmd/`・`tests/`・`ext/` の差分はない。11件の不具合と E32 の契約問題は未修正。

### 整理案から補正した点

| 項目                    | コードで再確認した根拠                                                                                                                                                                                                           | 修正案への補正・検証条件                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E26/R1                  | `ReloadDocument`（SumatraPDF.cpp:2424）は冒頭で `CommitFormFieldEdit(false)`。`LoadModelIntoTab`（4577–4579行）は呼出し前に `reloadOnFocus` を消す                                                                               | dirty 判定だけでは入力途中の text/choice を守れず、入口で戻るだけではタブ切替後の更新待ちを失う。自動更新は入力中も保留し、元タブに更新待ちを保持する。保存後の intentional reload は通す。入力途中・既存 dirty・別窓の入力を別々に試験する                         |
| E27/R2                  | `EngineMupdfHasUnsavedAnnotations`（EngineMupdf.cpp:12246）は既存 editor のフラグを読むだけ。一方 `EngineMupdfSaveUpdated`（11738行以降）は必要なら元ストリームを読む                                                            | dirty の問い合わせを先へ移す判断はできるが、元パス消失後の保存可能性とは別。`dataBacked` だけで安全な保存を判定しない。小容量メモリ入力・PDFium の保持 HANDLE・MuPDF の mmap を区別し、保存不能でも Cancel と明示破棄を残す                                         |
| E34/R9                  | 編集保存は `GetLiveTabEngine`（SumatraPDFCommon.cpp:890）と AddRef した元 engine で検証する。clean Save As は現在文書を取り直すだけ。同期 Reload は factory 前から path を借用する                                               | 既存の編集保存の検証を再利用する。factory に渡す前に path を所有し、成功・失敗の両方で対象生存・同一性を確かめてから触る。最後の置換直前だけの検証では遅い                                                                                                          |
| E32                     | `WaitForPendingControllerDeletes` は UI task の完了待ち。worker は `curReqs` にスタック上の要求を公開し、ループ先頭の退出で解除を飛ばす。WinMain は dangerous thread の10秒待ち後も Debug cleanup を続ける                       | stop は pending delete 待機と共有資源 cleanup より前。退出時の要求解除と UI drain を停止 API の前提にする。render の停止だけをアプリ全体の停止保証にしない。dangerous thread が残る場合の既存終了ゲートも照合する。未停止状態で lock を無期限に取る stop は採らない |
| E28/R3                  | `pdf_create_signature_widget`、`Prepare signature`、`pdf_sign_signature_with_appearance` は別操作。`pdf_xref_store_unsaved_signature`（pdf-xref.c:676）は journal 外の署名待ちリストも更新する                                   | 入力の先行検証だけでは準備途中失敗を覆えず、外側の abandon だけでも署名待ちリスト・loaded page・wrapper の復元は保証できない。取消対象と再同期の設計を残す。署名準備成功後の保存 Cancel/失敗は dirty な署名を保持する既存契約と分ける                               |
| E35/R8・E36/R10・E29/R4 | 拒否でも `pdf_set_text_field_value` は操作を end し、JS の他 field 変更を残せる。`pdf_undoredo_state` は操作中に例外、`EngineMupdfUndoPos` は nesting 中に -1。`pdf_end_operation` は空の記録を捨て、nested の変更は親へ統合する | 受理 bool・対象値の比較・Undo 位置だけでは確定変更を検出できない。結果型の追加だけで解決済みとしない。変更検出と通知範囲を先に決める。PDFium の表示エンジンと MuPDF editor の二つの text cache、JS の他ページへの影響も対象                                         |
| E37/R11                 | `RedactAllPages` は失敗ページを continue。`EngineMupdfApplyRedactions` は any 成功で true。共通 UI は全体成功を通知する。abandon は `pdf_sync_open_pages` を呼ばない                                                             | P2 案から P1 へ変更する。失敗ページの本文が保存出力にも残るのに、利用者が削除完了と判断する影響を優先する。発生頻度は未測定。成功ページを保持し、部分成功と未処理ページを通知する。失敗・列挙不能ページの再同期が必要                                               |
| E30/R5                  | コピー名は path＋size。`EngineCbx::Clone`（EngineImages.cpp:2384）は `physicalPath` を再利用する                                                                                                                                 | 更新時刻を加える際は世代別のコピーにし、開いている旧コピーを上書きしない。完了前のコピーも cache hit として公開しない。metadata 取得失敗・コピー中の元更新は元パスへの代替などを明示する。同サイズでも同じ更新時刻の内容改変まで検出する保証は追加しない            |

上記はコード確認であり、新規の実行再現ではない。E26 の入力途中、E28 の署名待ち登録後失敗、E32 の dangerous thread timeout を試験済みとは扱わない。
E24 の既存根拠は維持するが、これらの補正前の「最小案」で全条件を覆うとはしない。

### 優先順位と着手順

確定した優先事項は E26/E27 の未保存編集保護と、E34 の対象・寿命検証。墨消しの誤った完了通知も P1 とする。
同じ優先度内の順は到達経路と変更の依存で決める。再現済みかどうかを被害の大きさと混同しない。

| 順  | 項目                        | 理由・条件                                                                                                                                                          |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | E26/R1・E27/R2、P1          | watcher 更新・元パス移動という通常操作で既に dirty な編集が失われる。両エンジンで再現済み。入力途中と安全な保存の条件を補正する                                     |
| 2   | E34/R9、P1                  | 誤った文書の保存は Debug/ASan で再現済み。Reload の借用 path の寿命も ASan 診断あり。ただし通常キーでの到達性を実証したとはしない                                   |
| 3   | E37/R11、P1                 | 削除されていない本文の残存を全体成功で隠す。コード上の指摘であり、部分失敗の実行頻度・出力は未確認。成功ページと残る mark、保存出力、Undo、警告を専用試験で照合する |
| 4   | E32、P1                     | 停止未確認の解放と無期限の pending 待機を止める。通常 Release は fast exit、Debug/ASan は cleanup が既定。通常系テストから停止不能時の寿命を保証しない              |
| 5   | E28/R3、P2                  | 署名の特定の途中失敗で残る無通知の変更。再現済みの画像不良と、取消設計が必要な後段失敗を分けて修正する                                                              |
| 6   | E35/R8・E36/R10・E29/R4、P2 | 受理と変更の意味、通知、両エンジンの cache が関係する。E36 の変更検出設計を先に決める。E35 の戻り値だけの修正は独立できる                                           |
| 7   | E33/R7、P2                  | 取得復旧後も検索用 cache が空のまま。PDFium で失敗・復旧を観測済み。成功した空ページと明示した失敗を区別し、空なら常に再抽出する案は採らない                        |
| 8   | E30/R5、P2                  | 同サイズの UNC 更新で旧 archive を使うコード上の欠落。初回読み込みの成功を鮮度保証にしない。旧 Clone と新規 open の入力世代を分ける                                 |
| 9   | E31/R6、P2                  | 非同期 controller 破棄の HANDLE 漏れ。独立した局所修正として先行できる。通常の描画待ちと生成失敗時の代替は維持する                                                  |

E26/E27 は「dirty が正しい変更」の損失を先に止められる。E28/E36 の dirty 通知漏れが残る間、全ての未保存編集を保護したとは報告しない。
E32 と E31 は別の欠落であり、一方の修正を他方の前提にしない。

### 修正間の依存と境界

| 関係         | 判断                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E26 → E34    | 保存確認や入力確定はメッセージを処理し得る。確認後は対象を検証し直す。E26 の入口保留は先行できるが、同期 Reload 全体の寿命は E34 まで保証しない                                                                 |
| E27 ↔ E34   | 元パス消失後の新規保存もダイアログを開く。既存の編集保存の AddRef・対象検証を維持し、安全な保存能力と UI の選択肢を分ける                                                                                       |
| E36 → E29    | 何が確定したか、JS の影響ページを特定できるかで無効化範囲が決まる。単に通知関数で元ページを無効化するだけでは不足。変更範囲不明なら全ページを無効化する案を比較する                                             |
| E35 と E36   | 拒否は対象入力の受理結果。変更なしを意味しない。E35 の bool 修正はできるが、その bool を dirty 判定の最終契約にはしない                                                                                         |
| E37 と E28   | journal の生成失敗後も現状は読み取りを続ける。取消を必要とする破壊的操作は journal なしで開始しない案を優先し、読み取りの継続は維持する。両方で loaded page と wrapper の再同期が必要                           |
| E33 と E29   | 取得失敗と編集無効化は別問題。E33 は失敗時に Finished を保存しない。cache の世代確認・退避データの借用寿命は維持し、Blocking の同一呼出し内で失敗を無限再試行しない                                             |
| E32 と共有側 | Win32 の所有者に加えて ng の同期モデル破棄・cache 破棄を対応させる。Win32 の既存 `WaitThread` は timeout 後も HANDLE を保持できる。POSIX の timed join は detach するため、そのまま stop 成否の確認へ転用しない |

UI は保存方針・対象生存・通知、共通編集層は確定変更・wrapper・cache の整合、終了の所有者は停止結果と cleanup を担当する。
`PdfiumRuntime`、元入力と編集内容の API 分離、テーマ PDF とタイルの別 cache、Try の部分結果は維持する。
`EnginePdfium` の全面分割や汎用 backend 層は、上記の欠落を解決せず受け渡す入力・lock・寿命を増やすため採らない。
署名の失敗時取消と、フォームの確定済み変更を表示更新エラー後も保持する契約は統一しない。

### 修正工程に残す詳細設計

次の二点はそれぞれ E36・E28 の詳細設計とする。E25 では不足条件・比較する案・検証対象を明示し、具体的な実装方式の確定は完了条件に含めない。

1. **E36 の変更検出。** 受理 bool、対象値比較、前後の Undo 位置だけの案は採れない。現在の nested 操作内の journal 変更を照会する小さい MuPDF API を加える案と、既存の操作終了通知へ集約する案を比較する。変更を観測できない journal なしの扱い、拒否 JS と既存 dirty 文書、通知時の lock 順を決める。journal の私有構造をアプリ側へ複製しない。vendored API を変えるなら同じコミットに `ext/patches/` を伴わせる。
2. **E28 の取消範囲。** PDF オブジェクトの journal と、署名待ちリスト・loaded page・wrapper は同じ状態ではない。画像の先行検証と外側の操作だけで十分としない。準備失敗時にどこまで復元してから再試行を許すか、既存署名の登録を壊さず確認する。成功後の保存失敗を同じ取消条件に含めない。

E32 は停止不能時に依存先を保持して fast exit とする方針を維持する。ただし cleanup に入る前の dangerous thread 判定と pending delete の処理順も同じアプリ側の終了ゲートに反映する。
E30 は世代別コピーの公開条件を修正時の受入条件に加える。全内容 hash や全形式の入力保持への拡大は不要。

### 計画の完了条件との照合

| 条件                                    | 確認結果・残件の扱い                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 操作経路・読んだ関数・検証範囲          | E23 の入口表、E24 の六経路、継続記録と上記の再点検に記録した。全ソース精読ではない                                                         |
| 八つの評価観点                          | E24 の評価表と責務・API・所有・同期・cache・性能・試験の根拠を照合し、変更検出と取消の不足条件を補正した                                   |
| PDFium/MuPDF・共通 API・非 PDF・UI 境界 | 二つの text cache、ng 呼出し側、CBX の旧 Clone、PDFium 保持入力と MuPDF mmap の差を記録。一律に同じ保証へ変更しない                        |
| 重要な未確認分岐の処置                  | 入力途中・拒否 JS 副作用・署名後段失敗・部分墨消し・停止未完了・UNC 更新・HANDLE 数を各修正の検証条件へ残した。実行済みとはしない          |
| 各指摘の判断と次の作業                  | 全11件＋E32 は変更対象。優先順位・最小変更方針・依存を整理し、E28/E36 の詳細設計は各修正工程へ割り当てた。保留・変更不要・対象外も記録済み |
| 設計・backlog・履歴への反映             | E25 完了と E26–E37 未着手を区別して同期した。製品修正・回帰試験の完了を意味しない                                                          |

### 検証と範囲

既存の検証 JSON 4件を構文確認し、参照された path/log と SHA-256 の重複を除く56組を再計算した。全56組一致、欠落・変更なし。
これは証拠ファイルの同一性の確認であり、アプリ試験の再実行ではない。製品コード差分なし、ビルド・新規 Debug/ASan 試験・Release・全スイート・中断時の実験の再試行はない。

既存 assertion も確認した。forms は受理した値・描画・保存後の再開封、form-js は計算結果の保存後の再開封であり、事前 cache や拒否 JS の副作用を検証しない。
source-lifetime は watcher を無効にする。saveas は未編集の元バイト列のコピーで、大きい MuPDF の元ファイル移動が拒否されたケースを続行扱いにする。
signing は署名成功・認証・再開封、UI の誤パスワードは変更前の失敗。redaction-undo は成功・検索・印刷用 Clone・Undo/Redoを確認するがページ途中失敗は確認しない。
theme-render-cancel の pattern 構成は cancel 発生を assert するが、停止不能時の解放条件ではない。
cbr-network-unrar は到達不能な管理共有では skip し、初回のファイル経由 open と赤画素を検証する。local cache hit・同サイズ更新後の再開封は assert しない。

MuPDF 代替描画の文書再利用は再オープン費用と lock・保持量を比較する測定が必要なため保留する。
非 PDF 全般のスナップショット化・非待機化も、大画像・archive・mmap の保持量と既存の形式別契約を変えるため保留する。今回の修正の前提ではない。
実機印刷・入力、配布、DLL 登録、クラッシュ復旧、D3、全 OOM・codec・device 故障の網羅は対象外を維持する。
