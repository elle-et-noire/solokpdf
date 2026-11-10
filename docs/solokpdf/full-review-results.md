# SolokPDF 構造・コードレビュー中間結果

2026-11-10、初回 `7c67b529f`、継続 `0046373df`。計画の基準 `32d95cef7` から `src/`・`cmd/`・`tests/` の差分はない。
E23 の入口対応付けを完了し、E24 の主要経路を初回点検した。レビュー全体と E25 の最終整理は未完了。
初回は約30分の点検。以下の関数名は調査した経路を示し、全分岐の精読を意味しない。継続点検は末尾に分けて記録する。
製品コードの修正は未着手。指摘の優先順位・最小変更案・変更不要の判断は暫定である。

不具合は 7 件。R1–R4 は両エンジンで再現、R5–R6 はコード上の指摘、R7/E33 は PDFium の取得失敗注入で再現した。
E32 は終了待ちの契約問題、E34 はダイアログ中の対象寿命の疑いとして別に残す。
R1・R2 のデータ損失を最優先とし、E32/E34 の寿命確認、R3、R4・R5・R7、R6 の順で扱う。初回の再現入力・プローブのソース・出力・実行条件は
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

| 観点             | 判断・根拠                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 責務・依存       | UI → 共通編集 API → MuPDF の境界は利用できる。問題は文書置換時の保存方針と、編集通知時のキャッシュ更新が各呼び出し元へ漏れていること（R1・R2・R4）。                                                                         |
| API 契約・正しさ | 元入力・編集内容・部分取得の区別を維持する。署名の `false` が「変更なし」にならない点は R3。Try の全件取得・全エンジン非待機化は保証しない。                                                                                 |
| 状態・寿命       | 元入力と編集参照の寿命は source-lifetime で照合。未保存の状態遷移は R1–R3、取得済みテキストは R4、thread HANDLE は R6。                                                                                                      |
| 非同期・同期     | 通常のタイル挿入、サムネイル世代、文書破棄の終了待ちは維持。停止不能ワーカー・投稿直前の競合は E32 の追加確認とし、テスト通過から競合なしとは判断しない。                                                                    |
| 構造・保守性     | 全面分割より、文書置換の保存判定と変更時の無効化の集約を優先する。PDFium 全体を汎用 backend 群へ分割すると、ページ・入力・ロックの引数と寿命境界が増える。                                                                   |
| データ整合性     | 元入力保持・同一ファイル判定・墨消しの参照先は維持。R1–R5 が編集状態・検索・ファイル更新との食い違いを示す。                                                                                                                 |
| 性能・応答性     | Try hover、UI 外での描画終了待ち、テーマ変換 PDF の再利用を維持。MuPDF 代替描画はタイルごとに context/document を開くが、共有化は同期・保持量を増やすため測定前に変更しない。                                                |
| 検証可能性       | 既存 12 本の経路テストと desktop probe が通過。保存確認を事前回答する `client.quit()` と、キャッシュを温めないフォーム保存テストでは R1・R2・R4 を検出できない。署名成功・誤パスワードだけでは R3 の途中失敗を検出できない。 |

## E25: 指摘と最小変更案

以下は途中時点の整理。E24 の残りを確認してから最終判断する。

### R1 / E26 — P1: 自動再読み込みが未保存編集を捨てる

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

- **不具合・変更する。** [PdfSign.cpp:298](../../src/shared/PdfSign.cpp#L298) は新規 widget を作り、`Prepare signature` を確定した後に画像を読む。画像エラー時は rollback せず false を返し、成功時だけ dirty を立てる（同ファイル 325–364 行）。
- 有効な使い捨て PFX と壊れた既存 PNG を指定してページ上に配置すると、エラー後も署名の配置候補が 1→2、`canUndo=1`・`modified=0` となる。両エンジンで UI 経由で再現した。
- `ad-hoc-pdfium-signing` は成功・再開封・署名検証、`ad-hoc-sign-document` の失敗は変更前の誤パスワードを確認する。この途中失敗は未検証。
- 最小案は画像等の失敗し得る入力を文書変更前に読むこと。その上で field 作成・Lock/Certify 設定・署名準備を一つの取り消せる操作にする。失敗時だけ dirty を立てる案は、失敗した操作の残骸を利用者へ渡すため採らない。
- 新規・既存 field、壊れた画像、署名準備中の失敗で field 数・Lock/Certify・Undo 位置・dirty の不変を確認する。既存の署名検証テストも通す。共有 `PdfSign.cpp` なので ng の呼び出し側にも同じ契約を適用する。

### R4 / E29 — P2: フォーム編集後の検索が旧値を使う

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

変更不要の記述は今回読んだ範囲での暫定判断であり、E24 の継続調査で再評価する。

- **変更不要:** PDFium の DLL・フォント・参照数は既存 `PdfiumRuntime` に留める。`EnginePdfium` 全面分割や新しい汎用 backend 層は、今回の欠落した保存・変更通知の契約を解決しない。
- **変更不要:** `RenderCache` の要求管理と `RenderViewPage` の合成を、今回ただちに別クラスへ分けない。表示入力を値で渡し、実描画結果の色状態を返す契約は既に共通化されている。
- **変更不要:** 通常の描画終了待ち、元入力と編集データの API 分離、テーマ PDF とタイルの別キャッシュ、Try 要素取得の部分結果を維持する。
- **契約問題 / E32:** 停止未確認のワーカーを残したキャッシュ破棄を Debug で確認した。再開時のメモリアクセスと停止中のロック位置は未確認。末尾の継続点検を参照。
- **不具合 / E33:** 取得復旧後も完成済み空テキストが残ることを再現した。R7 として末尾に記録する。
- **保留:** MuPDF 代替の文書再利用、全非 PDF API の非待機化。効果量と寿命・同期の負担を測る入力が今回の再現には不要で、独立した最適化として扱う。
- **対象外:** 計画どおり ng の機能開発、D3、F1/F3 実機、配布、DLL 登録、クラッシュ復旧の実地確認。OOM・デバイス喪失・全コーデック・全ダイアログの障害注入も行っていない。

## E24 の継続調査

- E32 は、停止待ちと解放を分離した所有者側の終了契約を決める。メモリ書換え・スレッド停止による追加実験は行わず、修正時に専用のテスト入口で確認する。
- E34 は、同期 Reload・保存ダイアログから復帰した対象の再検証を確認する。パイプ切断だけをクラッシュの証明にせず、終了コード・ASan 出力を保存する。
- フォームの更新途中失敗と墨消しの部分成功を、変更済みフラグ・Undo・UI 通知まで追う。正常系から例外時の整合性を推定しない。
- 非 PDF の元パス依存を下記に整理した。消失・置換後の保存/Clone の実行確認を補い、E25 の責務再構成案と優先順位を確定する。

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
