# SolokPDF 構造・コードレビュー中間結果

2026-11-10、`7c67b529f`。計画の基準 `32d95cef7` から `src/`・`cmd/`・`tests/` の差分はない。
E23 の入口対応付けを完了し、E24 の主要経路を初回点検した。レビュー全体と E25 の最終整理は未完了。
約30分の点検であり、以下の関数名は調査した経路を示す。各関数の全分岐や関連実装を精読したという意味ではない。
製品コードの修正は未着手。指摘の優先順位・最小変更案・変更不要の判断は暫定である。

不具合は 6 件。R1–R4 は両エンジンで再現、R5–R6 はコード上の根拠による指摘で、実行検証は未実施。
優先順は R1・R2、R3、R4・R5、R6。再現入力・プローブのソース・出力・実行条件は
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
- **追加確認 / E32:** render cache の join timeout と、停止不能時に破棄を続ける経路。通常終了の成功をこの分岐の安全性の証明にしない。停止・UI 投稿・解放の順序を障害注入と ASan で確かめ、停止できなければ状態を生かして終了する案と比較する。
- **追加確認 / E33:** ページ読み込み失敗と空テキストがともに `{}` になり、完成済み空ページとして保存される経路。`TextLocked`・`EnsurePageText`・`StoreText` が根拠。部分取得の既存試験では区別できない。ページ読み込み失敗を注入して再試行要否を決め、必要なら結果型を変更する。現時点で利用者影響を再現した不具合とは数えない。
- **保留:** MuPDF 代替の文書再利用、全非 PDF API の非待機化。効果量と寿命・同期の負担を測る入力が今回の再現には不要で、独立した最適化として扱う。
- **対象外:** 計画どおり ng の機能開発、D3、F1/F3 実機、配布、DLL 登録、クラッシュ復旧の実地確認。OOM・デバイス喪失・全コーデック・全ダイアログの障害注入も行っていない。

## E24 の継続調査

- E32/E33 の停止不能・取得失敗を検証し、呼び出し側が結果と寿命を正しく扱うか確認する。
- 同期 Reload・パスワード・保存ダイアログのメッセージ処理中にタブや文書が変わる経路を、参照の保持から復帰後の利用まで追う。
- 入力モードの競合、編集の途中失敗、非 PDF の保存・複製・再読み込みを深掘りする。今回の入口確認と正常系テストでは完了扱いにしない。
- 各経路の失敗・中止・再入の確認を補い、責務の再構成案と現行維持案を比較してから E25 を確定する。

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
R5/R6 と E32/E33 は実行未検証として残す。

プローブを再実行する場合は検証データの `reproducers[].source` を対応する `path` へ復元し、
Debug をビルドした後、`bun tools/solokpdf/run-hidden.ts -- bun <path>` で実行する。
通常入力は `OLDWORD` のフォーム、外部置換は `DISKWORD`、署名はローカル生成の PFX と壊れた PNG。
利用者の文書・証明書・設定は入力に使っていない。
