# SolokPDF 独立再レビュー（Sol / high）

実施日: 2026-11-11。開始時・終了時 HEAD: `4d68e2f697acab9c1832cd8ab8a7c897fbad52e6`。
開始時の作業ツリーは変更なし。独立精読は `gpt-6-sol` / `high`、呼び出し側の照合と実行検証は親エージェントが担当した。
製品コードの変更・コミットはなし。既存レビュー記録は変更していない。

`AGENTS.md`、`testing.md`、`full-review-plan.md` を読み、計画の Windows SolokPDF 範囲を対象とする。
現行コードと試験の assertion を判断根拠とし、以前の完了判定・実装モデルは品質の根拠にしない。

根拠・プローブ最終ソース・実行出力は [検証記録](data/full-review-sol-2026-11-11.json)。
`full-review-results.md`、`history.md` の E26–E37、各修正の検証記録、`architecture.md` と照合した。
過去の実行結果と今回の実行を区別する。行番号は開始時 HEAD に対応する。

## 指摘

### SOL1 — P1: 保存・再読込・閉じるが入力確定より先に進む

**不具合。両エンジンで実再現済み。修正対象。**

場所:

- `src/SumatraPDF.cpp:5110` / `5160` / `5787`: 注釈保存・Save As の入口。
- `src/SumatraPDF.cpp:5450`: `ReloadWithSavePrompt` はフォームだけ確定する。
- `src/SumatraPDF.cpp:5382` / `5532` / `5697`: 保存確認はエンジンの dirty だけを見る。
- `src/SumatraPDF.cpp:4937` / `2494`: 文書破棄・再読込はフォーム入力を取り消す。
- `src/AnnotEditToolbar.cpp:2072`: 非表示化で FreeText は確定、注釈本文は editor を破棄する。

到達条件と影響:

| 状態・操作                                                                                    | 今回の観測                                                                  |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| clean な既存 FreeText / Square の本文を `EDITED` と入力中、`CmdReloadDocument`                | 確認なしで `ORIGINAL` に戻る。Undo/Redo 不可、dirty=false                   |
| 注釈本文を `COMMITTED` と確定した後、`EDITED` を入力中、`CmdSaveAnnotations`                  | 保存・再読込後は `COMMITTED`。追加入力は失われ、Undo/Redo 不可、dirty=false |
| clean な FreeText / Square の本文を入力中、`CmdClose`                                         | 保存確認なしで閉じ、元ファイルの内容は変わらない                            |
| テキスト / choice フォームに `DISKWORD` を確定した後、`EDITED` を入力中、`CmdSaveAnnotations` | 保存・再読込後の値は `DISKWORD`。追加入力が失われる                         |
| clean なテキスト / choice フォームを入力中、`CmdClose`                                        | 保存確認なしで閉じ、元ファイルの内容は変わらない                            |

PDFium・MuPDFそれぞれで上記を確認した。注釈12ケース、フォーム8ケース。
フォームは既存 control setter の戻り値 `before='DISKWORD'`、注釈は再読込後の本文・Undo・dirty、閉じるは editor の消滅・ダイアログ不在・元ファイルのバイト一致を観測した。
通常の `WM_COMMAND` 配送を使用し、プロセスメモリ操作や障害注入はしていない。
編集コントロールでも Ctrl+W / Ctrl+Shift+S を通す accelerator があるため、単なる無効な制御API呼出しではない（`src/shared/Accelerators.cpp:76,111,457`）。

コード上、入力途中はまだエンジンの変更ではない。`MaybeSaveAnnotations` は clean と判断し、保存入口も入力確定を待たない。
FreeText は `HideAnnotEditToolbar` で後から確定しても、保存・新コントローラー作成の後なので古いエンジンとともに捨てられる。
注釈本文とフォームは teardown で取り消される。
`CmdSaveAnnotations` は clean のエンジンには何もしないため、保存の再現には事前に確定済み変更を作った。clean の保存だけから入力消失とは判定していない。

既存試験の穴: `auto-reload-unsaved` の注釈ケースは watcher と取消・クリック確定・Undo の後のタブ往復を検証する。
手動 Reload の入力確定はフォームケースだけで、注釈入力中の保存・閉じるを通さない。
`form-text-cache` は setter / 明示確定後の dirty・保存を確認するが、今回の保存入口より前の入力確定を保証しない。
`annot-text-popup-reload` は本文入力ではなく表示カードの破棄を確認する。

最小修正: UI 層に、対象タブの保留入力を確定して対象の生存・同一性を再検証する処理を一つ置く。
保存、手動再読込の保存確認、タブ・ウィンドウ終了の保存確認より前に呼ぶ。
明示取消・Discard と自動再読込の保留は区別し、別ウィンドウの editor を確定しない。
非表示化・破棄時の副作用に確定を任せる現状から、操作入口の契約へ移す。エンジンやファイル層に HWND の知識を持たせない。

必要な検証: 今回の20ケースを、期待値 `EDITED` の保存・保持、または保存確認の出現を assert する回帰試験へする。
Save As、ウィンドウ終了、Cancel/Discard、保存失敗後の再試行、入力拒否と JS 副作用、別ウィンドウの入力も追加する。
確定が通知・再入を起こすため、対象が閉じる・切り替わる場合は Debug / ASan で確認する。

### SOL2 — P1: Save As・Merge の途中失敗で既存保存先を壊す

**コード上の不具合。I/O 失敗は未実行。修正対象。**

場所と根拠:

- `src/solokpdf/EnginePdfium.cpp:3282`: `SaveFileAs` の小容量分岐は `file::WriteFile`。
  大容量分岐は `OPEN_ALWAYS` → 同一実体確認 → 位置0で `SetEndOfFile` → 転送。
  `ReadBlock` / `WriteFile` / 書込長の失敗時には `file::Delete(path)` する（3327行）。
- `src/SumatraPDF.cpp:5955`: PDFium の保持した元入力をコピーする Save As がこの API を呼ぶ。
- `src/MergePdf.cpp:1892`: `SaveTo` は完成した一時PDFを `ReadFile` で全量メモリ化し、1924行の `file::WriteFile(destPath, data)` で公開する。
  保存先が入力元自身でもよい契約である。
- `src/base/File.cpp:1330`: `WriteFile` は `CREATE_ALWAYS` で旧内容を切り詰め、書込失敗で旧内容を復元しない。

条件・影響: 既存保存先への上書きを選択し、その後に入力読取失敗・容量不足・書込エラーが起きると、保存失敗の表示だけが残り旧保存先まで失う。
大容量PDFiumでは既存保存先が削除され、Mergeでは入力元PDF自身が途中までのファイルになり得る。
同一ファイル実体の事前比較は自己切り詰めを防ぐが、別の既存保存先の保全は保証しない。
小容量PDFiumにも切り詰めによる同類の問題がある。

既存試験の穴: `ad-hoc-pdfium-saveas` は small/big と rename/delete 後の新規保存先についてバイト一致を assert する。
既存保存先の途中失敗は扱わない。MuPDF big の rename/delete が Windows に拒否されたケースは通過扱いなので、入力消失全条件の保証にもならない。
Merge の `issue-6070:295` は Save Asで元入力が変わらないこと、同304行は入力元への保存成功と再読込を確認する。
`merge-struct-parents` / `tool-merge` も生成結果・ページ・構造などの試験で、完成PDFの公開時失敗に対する旧保存先の保全を assert しない。

最小修正: 保存先と同じディレクトリの一時ファイルへ出力し、成功後だけ置換する。
失敗で削除するのは一時ファイルに限る。
Merge は既存の `file::OverwriteAtomicRetry`（`src/base/File.cpp:1714`）を利用でき、全量 `ReadFile` と `WriteFile` を除去できる。
PDFium は保持した入力ハンドルから一時ファイルへ転送し、既存の置換処理を利用する。
汎用 `WriteFile` の全利用者の契約を変える必要はない。

必要な検証: 保存先の事前バイト列を保持し、最初・途中・最後の読取／書込と公開の失敗後も旧内容が一致することを確認する。
成功、同一実体・ハードリンク、元パス rename/delete、保存先の共有違反、Merge の入力元への上書きも確認する。
実ディスクを満杯にする代わりに専用の限定的な失敗入口を用意する。クラッシュ時の永続性保証は別に扱う。

### SOL3 — P1: 印刷中の終了確認後にウィンドウの寿命を検証しない

**静的な寿命の懸念。実再現なし。修正前に専用検証が必要。**

場所: `src/SumatraPDF.cpp:5631` の `CanCloseWindow`、`14639` の `WM_CLOSE`、`4890` の `OnMenuExit`、
`5663` の `CloseWindow`。再入入口は `src/shared/SearchAndDDECommon.cpp:2512` の DDE command。
ほかに `CanCloseWindow` を使うタブ終了・Esc・ウィンドウ集約にも同じ事後条件が必要。

条件: 印刷中に `WM_CLOSE` を受け、`CanCloseWindow` が確認 `MsgBox` を開く。
この段階では `isBeingClosed` が未設定で、DDE `[CmdExit]` を `FrameOnCommand` の closing guard が止めない。
外側の確認中に印刷が終われば内側の終了確認は不要になり、ウィンドウを破棄できる。
印刷継続中でも内側の確認で Yes を選ぶと、`AbortPrinting` を経て破棄へ進める。

外側の `CanCloseWindow` は戻り後に生存を検証せず、IDNO 以外を true とする。
`WM_CLOSE` はそのまま `CloseWindow(win, ...)` を呼び、入口の `win->isBeingClosed` が解放済みポインターを読む可能性がある。
影響は終了時のクラッシュ・寿命違反。`OnMenuExit` も生きているウィンドウ列の反復中に modal を開くため併せて確認が必要。
ウィンドウ破棄時の `MsgBox` の実際の戻り値と順序は今回実行していない。

既存試験の穴: `dialog-target-reentry` は Save As とパスワード付き再読込の切替・閉鎖・終了を確認するが、印刷確認を開かない。
`render-cache-shutdown` もこの `MsgBox` を経由しない。E34の通過を全ダイアログの寿命保証に拡張できない。

最小修正: `CanCloseWindow` の modal 復帰後に生存を確認し、呼出し側も確認した対象がまだ有効な場合だけ閉じる。
複数ウィンドウは安定した列と各要素の生存検証を使う。全ダイアログの枠組みを作り直す必要はない。
専用の印刷中状態を使い、印刷完了、内側 Yes/No、DDE Exit、元ウィンドウ破棄、複数ウィンドウを Debug / ASan・隠しデスクトップで確認する。
計画の新規再入プローブ制限に従い、今回は実行せず修正時の回帰試験へ残した。物理プリンターでの試験とは別である。

## 契約上の保留と変更不要の判断

- **P3・仕様未確定:** 入力中に保留した自動更新は同じタブで取消／Undoしても直ちに再試行しない。
  `Canvas.cpp:5005` は timer を解除し、`ReloadDocument` は `reloadOnFocus` を残すだけで、editor 終了は timer を再設定しない。
  `SumatraPDF.cpp:4660` のタブ再選択か、新しい watcher event が次の契機となる。
  `auto-reload-unsaved` は明示的なタブ往復で消費するため、同じタブでの更新時期を保証しない。
  静的確認のみ。即時反映を要するか、再選択まで保留する仕様かを決めてから変更する。データ損失の指摘には数えない。
- `4d68e2f69` の guard は、取消処理や新コントローラー生成より前に FreeText・注釈本文を確認しており、確認した自動再読込経路には妥当。
  dirty 前の入力を保護し、保留更新も残す。今回の既存14ケースが通った。
  SOL1の手動操作、上記の同一タブでの再試行、すべての入力モードを保証する修正ではない。
- 通常注釈を含まない `Clone` と、適用済み墨消しでは編集エンジン側を使う分岐は別契約。
  F12 palette / 印刷の通常Cloneと sidebarのlive表示を一律に統合すると、保持量・同期・保存副作用が増える。今回、全面変更を求める根拠はない。
- `CloseWindow` のタブ snapshot に対する DDE CmdClose による UAF 案は撤回した。
  その区間は `isBeingClosed=true` で `FrameOnCommand:10820` が拒否する。SOL3の確認前の区間とは異なる。

## 確認した経路

下表は今回の精読・呼出し側照合の範囲。全ファイル・全分岐の監査ではない。

| 経路                     | 追った実装・今回の判断                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 開く・読み取り・移動     | `EngineCreate` の file/data factory・エンジン選択、PDFium `Load` / `ReadBlock` / `ReadIntoMemory` / `LoadWithPassword` / `AnnotationEditor`、MuPDF fallback、`ReadPageText` / text cache、`TryExtractPageText` / `TryGetElements`、リンク・TOC利用。password中止の Final と fallback、失敗・empty・partialを区別する。Try要素の部分集合を完全取得としない。非PDFはfactoryとCBX/画像の入力・保存・Cloneの違いを確認。コーデック全内部は対象外。 |
| 描画・表示変更           | `RenderCache::Render` / `GetNextRequest` / `Add` / `SetViewColors` / `Invalidate`、`RenderCacheRunOne`、`RenderViewPage`、PDFium `PrepareRenderRoute` / `DrawPage` / `DrawMupdf` / `RenderPage`。世代と中止の挿入時照合、probeのロック、alpha後処理と注釈合成失敗を照合。`PageThumbnails::ResetCache` / worker / `BgJob`、Homeの中立PNGと表示用コピー、Merge thumbnailと印刷のClone境界も追った。画素比較は今回なし。                          |
| 入力・コマンド・画面状態 | `GetKeyTarget` / `MaybeTranslateAccelerator` / edit用accelerator、Canvasのform/annot配送、`FrameOnCommand`、watcher→timer→`ReloadDocument`、各editorの確定・取消・非表示化。SOL1と保留更新の契機を確認。`RefHoverHide` / render request / completionのエンジン参照とUI生存確認を照合。全キー・ポップアップ・通知種類の網羅はなし。                                                                                                             |
| 編集・Undo/Redo          | `Annotation::UpdateAnnotIf` / `SetWidgetValue` / `ToggleFormButton`、`FormEditResult`、journal変更検出、`InvalidateFormPages` / text世代、`SyncPagesAfterUndoRedo`。`EngineMupdfApplyRedactions` のページ単位確定・失敗番号・wrapper再取得とPDFiumの編集側切替、`PdfSign::EngineMupdfSignDocument` のpending signer除去・abandon・loaded page同期を確認。後段appearance失敗を変更なしと扱わない実装と対象試験を照合。                          |
| 保存・複製・再読み込み   | `SaveCurrentFileAs` / `SaveDocAs`、両注釈保存入口、`EngineMupdfCanSave` / `SaveUpdated` / `SaveCopy`、PDFium `SaveFileAs` / `Clone`、Merge `SaveTo`、`ReloadDocument` / `ReplaceDocumentInCurrentTab`。元入力と編集結果、入力実体とパス、dialog後のengine保持と対象確認、SOL1/SOL2を照合。非PDFのパス再読込はPDFiumの入力保持保証と同一視しない。                                                                                              |
| 閉じる・終了             | `MaybeSaveAnnotations` / `CloseTab` / `CloseWindow` / `CanCloseWindow` / `CloseDocumentInCurrentTab`、`WindowTab`破棄、`DeleteControllerAsync` / `CancelRenderingBlocking` / UI完了 / pending-delete待機、`RenderCache::Stop` / `ClearCurrentRequest`、WinMainのcleanup gate。sidebar/Mergeのdetach後解放、hoverのengine参照と遅延結果の破棄も追った。SOL1/SOL3と停止未確認時の依存保持を照合。                                                |

## 評価観点と構造変更の判断

| 観点            | 判断                                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 責務と依存      | UIの保留入力確定はUI層、PDF編集・変更検出は共通編集層、完成ファイルの公開はファイル処理の責務。SOL1/SOL2はこの境界の欠落を局所的に埋める。PDFium閲覧とMuPDF編集の分離自体を崩す必要はない。                                                                                      |
| API契約と正しさ | 元データコピーと編集済み保存、受理・変更・refresh失敗、partial/empty/failedを区別する現行設計を確認。dirtyが保留入力を含まない以上、破壊的操作の入口で補う必要がある。                                                                                                           |
| 状態と寿命      | engine AddRef、annotation wrapper無効化、BgJobの最後の利用者による解放を照合。SOL3はmodalをまたぐ借用windowの検証不足。通常成功から全通知の再入安全は推定しない。                                                                                                                |
| 非同期と同期    | RenderCacheは受付停止→queue/公開要求abort→単一予算のjoin。停止未確認時にHANDLEと依存を保持。WinMainはcache停止後にdangerous threadとpending deleteを確認し、必要なUI完了をdrainする。全callbackの時間上限は保証しない。                                                          |
| 保守性          | SOL1の入口別の入力状態列挙を一つの対象付き確定契約に集約すれば、今回漏れた「入力種類×操作」の重複判断を減らせる。SOL2の既存atomic helper利用はコピー・失敗掃除の独自実装を減らす。単に大きいEnginePdfiumを細分化する案は、ロック・ページ・入力所有者の引数を増やすため採らない。 |
| データ整合性    | SOL1はUI文字列とエンジン値、SOL2は新出力と旧出力の整合性欠落。フォームの表示・検索・選択・Undo/Redo・保存の世代整合は既存試験の対象条件で通過。署名のPDF journal以外の状態も確認したが全失敗を実行していない。                                                                   |
| 性能と応答性    | Mergeの完成PDFの全量再読込は出力サイズに比例する余分なメモリとコピー。atomic helperへの置換で除ける。PDFiumのテーマ変換再利用、UIのTry読取、非同期controller破棄は維持する。MuPDF代替描画の文書再生成やグローバルロックの分割は、効果と保持量を測る前に提案しない。              |
| 検証可能性      | 現試験はE35/E36の確定変更と後段失敗、E37のページ失敗、E32の停止失敗を実際にassertする。一方SOL1の入口前、SOL2の公開途中、SOL3の印刷確認は未網羅。制御APIの直接setterや保存確認を省く終了を、利用者の操作入口の試験に代用しない。                                                 |

共有API変更が必要になった場合はngの呼出し側も検証対象となる。
`src/ng/FormFields.cpp`、`src/ng/AnnotEditToolbar.cpp` と共有宣言は別のUI確定経路を持つ。
Windowsのeditor確定を共有エンジン内部へ移植する案ではなく、プラットフォームのUI境界で同じ事後条件を実装する。
今回はngの機能変更・ビルド・GUI試験はしていない。

## 実行した検証

全アプリ試験は sandbox 外の隠しデスクトップ、Debug x64、`-for-testing`。
ビルド後は同一実行ファイルを使用した。

SHA-256: `57e01bfc668f8b338a35df14e5a97b1b2ffc3d5d06fed0a3e5434f01fefe4945`。
Windows build `26300.9818`、Bun `1.4.4`、PDFium有効。fixtureと両エンジンの指定は検証記録のソース・出力に含む。

| 実行                            | 結果・assertionの範囲                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `bun cmd/solok-build.ts -quick` | 成功、警告0・エラー0。sandbox内の初回はMSBuild FileTrackerのアクセス拒否。sandbox外で成功し、製品不具合とは扱わない。           |
| `ad-hoc-b69-hidden-desktop`     | PASS。probe windowが入力desktopと異なることを確認。                                                                             |
| `auto-reload-unsaved`           | PASS、52.3秒。両エンジン計14ケース。入力保持・dirty/Undo・保留更新・手動Reloadのform・別windowを確認。                          |
| `form-text-cache`               | PASS、59.3秒。両エンジンのフォーム/FreeTextの後段失敗、拒否JS副作用、journal有無、表示/検索/選択、Undo/Redo、保存値を確認。     |
| `redact-partial`                | PASS、29.4秒。両エンジン、既定9失敗モードと利用者マーク。本文・警告・wrapper再取得・Undo/Redo・保存を確認。                     |
| `render-cache-shutdown`         | PASS、37.0秒。両エンジンのidle、stopで解放、停止不能、dangerous workerのUI完了／timeout。終了コードとcleanup/依存保持をassert。 |
| `dialog-target-reentry`         | PASS、24.5秒。両エンジンのSave As同一/切替/閉鎖/置換、password reloadの同一/切替/取消/閉鎖/終了。印刷確認は含まない。           |
| 最小入力プローブ・注釈          | 12ケースで入力消失を観測。正常動作のPASSではない。                                                                              |
| 最小入力プローブ・フォーム      | 8ケースで入力消失を観測。正常動作のPASSではない。                                                                               |

既存試験のskip報告はなし。すべて個別実行で、全スイートは実行していない。
新規プローブのexit 0は観測完了を意味し、製品の正しさを判定するassertionではない。期待入力と実測値を上記SOL1に明記した。
プローブ初版のclean保存待ちと、次版の400ms再編集抑制による待ち失敗は、試験側の前提誤りとして記録し、製品失敗の件数に含めない。
最終注釈版は抑制を450ms待ち、全ケースを完了した。後から追加したフォーム部分は別実行した。

## 未確認範囲と次の作業

- SOL2のI/O・容量不足・公開失敗、SOL3の印刷確認再入は未実行。専用回帰試験を先に作り、失敗を確認してから修正する。
- SOL1のSave As・ウィンドウ全終了・拒否入力との組合せ、保留reload後の同一タブ滞在、すべての通知による再入は未実行。SOL1修正の対象試験へ追加する。
- E28の署名失敗試験、E27の元パス消失、E30のUNC cache、E31のHANDLE増加、E33の抽出失敗、`redact-no-journal` は今回は再実行していない。関連実装・履歴・assertionの照合まで。過去の通過を今回の通過としない。
- journal abandon自体やMuPDF内部全箇所のOOM、全コーデック停止、全ワーカー・UI callbackの有界性、画素全比較は未確認。問題を局所化した専用検証なしに保証しない。
- 非PDFの全形式置換、WebView2内部、ng機能開発、D3 CI分割、F1/F3実機確認、配布・DLL登録、クラッシュ復旧実地は計画どおり対象外。今回のASan実行・Releaseビルドもなし。

次の修正はSOL1の入力確定契約を優先し、SOL2の既存出力保全、SOL3の寿命検証を独立した変更にする。
既存の「完了」は各記録の条件に限定する。このレビューの終了は全ソース精読・全機能検証・全体の安全の保証を意味しない。

## SOL1–SOL3 修正検証（2026-11-11）

上記は開始HEAD `4d68e2f697acab9c1832cd8ab8a7c897fbad52e6` でのレビュー記録として保持する。
その後の「修正して」により以下を実装した。未コミット。
機械可読の記録は [sol-review-fixes-2026-11-11.json](data/sol-review-fixes-2026-11-11.json)。

- **SOL1**: 対象タブのフォーム・FreeText・注釈本文を `CommitTabInput` で確定してから、保存・手動再読込・終了の判断をする。
  エンジン参照を保持し、確定後にタブ・controller・engineの同一性を再検証する。
  choiceのフォーカス喪失やFreeTextの終了中判定より前に確定するため、印刷確認前・タブ破棄前・windowのclosingフラグ設定前にも呼ぶ。
  watcherの入力保護は維持する。
- **SOL2**: PDFiumの保持元入力は小容量・大容量とも保存先と同じディレクトリへコピーし、flushとcloseの後だけ置換する。
  同一実体・ハードリンクの判定は維持し、失敗で削除するのは一時出力だけとした。
  Mergeは既存の `OverwriteAtomicRetry` を使い、完成PDFの全量再読込を除いた。
  copy callbackの取消をWindows/POSIXの双方で扱い、共有helperの取消・公開をunit testで検証した。
- **SOL3**: 印刷確認でYesを受けた後にもwindowの生存を確認する。Escの後続処理も検証する。
  全終了の事前確認はwindow配列のコピーを使い、再入中に追加された未確認windowを閉じない。

### 失敗を先に確認

`pending-document-input` は修正前のFreeText手動Reloadで保存確認が出ず失敗した。
`atomic-pdf-save` は旧コピー実装に限定的な途中失敗入口だけを置いた状態で、PDFium小容量・Mergeとも旧保存先のバイト不一致を検出した。
実ディスクの容量不足を起こした試験ではない。
`print-close-reentry` は旧判定で `allowed=1 live=0` を検出した。
さらにFreeText複数行のwindow close時の矩形縮小、印刷確認によるchoice入力取消を検出し、確定順を補正して再検証した。
通常試験を通すだけでは見つからなかった入力種類・入口の組合せである。

### 実行結果と限界

すべてのアプリ起動はsandbox外の隠しデスクトップ、`-for-testing`、Debug/ASan。
Releaseビルド・全GUIスイート・commitは実行していない。

| 検証                            | 結果・範囲                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SolokPDF Debug/ASan build       | 成功、警告0・エラー0                                                                                                                                                      |
| `pending-document-input`        | Debug 56ケース、ASan 56ケース通過。両エンジン×4入力×7操作。Cancel→再試行、保存失敗→再試行、既存dirty、Save As、再open値、FreeText複数行の矩形をassert                     |
| `atomic-pdf-save`               | Debug/ASan各14ケース通過。小/大PDFiumの読取・書込途中失敗、両エンジンMergeのコピー取消、read-only公開失敗、成功後内容、旧保存先・元入力の保持、一時ファイルの掃除をassert |
| `print-close-reentry`           | Debug 6ケース通過。最終試験のASan 6ケースは2回通過、3回目は終了コード9。両エンジンのmodal中の対象破棄、No、choice入力の確定をassert                                       |
| `dialog-target-reentry`         | Debug/ASan通過。両エンジンの保存対象切替・破棄・置換、password reload再入                                                                                                 |
| `auto-reload-unsaved`           | Debug 14ケース通過。`4d68e2f69` のwatcher保護、取消、Undo、別windowとの組合せ                                                                                             |
| `form-text-cache`               | Debug通過。両エンジンの入力拒否・後段失敗・キャッシュ・Undo/Redo・保存                                                                                                    |
| `ad-hoc-pdfium-source-lifetime` | Debug 6ケース通過。小/大のrename/replace/deleteと同一実体・alias                                                                                                          |
| `issue-6070`                    | Debug通過。Merge Save Asと入力元への上書き                                                                                                                                |
| unit tests                      | Debug/ASan通過。共有atomic helperのコピー取消で旧出力保持、成功後の置換を追加                                                                                             |
| ng `test_util`                  | Windows Debugのコンパイル・リンク成功。実行・ng GUI・POSIXビルドは未実施                                                                                                  |
| static lint                     | command IDs・desktop input、差分の空白検査通過                                                                                                                            |

**ASanの終了時例外は未解決として残す。** 上の通過とは別に、保存試験の終了時に断続的なnative `0xC0000409` を観測した。
Bunの終了コード9だけで判断せず、保持したprocess HANDLEの `GetExitCodeProcess` と一時debuggerで実終了・stackを取得した。
stackは `LdrShutdownProcess` → MSCTFの入力サービス終了 → ASan wrapper → `RtlReAllocateHeap`、fast-fail引数 `0x23` を示す。
アプリの `shutdown: shared cleanup complete` の後であり、製品の保存処理に原因を特定したものではない。
allocator hook設定を変えた4回は通過したが、これを原因の確定・修正とは扱わず、既定のASan設定・suppressionは変更していない。
通常の失敗判定を免除していない。関連する取消時のMuPDF `UNHANDLED EXCEPTION` 警告も記録し、終了コード0だけで全体の安全とは判断しない。

印刷試験の初版には、完了ファイルの作成直後にworkerがまだ終了しておらず、二重の確認を開く競合があった。
最終版は別control接続から実スレッドHANDLEのsignaledを待つ。固定sleepでは回避していない。
この変更はDebugの試験入口だけを追加する再ビルドで、上記56ケース・14ケースを実行した製品経路は同じ。
変更後のASan反復3回目の終了コード9も、cleanup完了後の未解決の失敗として保持する。

未確認: 物理ディスク容量不足・電源断時の永続性、SMB/特殊filesystemの置換、全I/O失敗位置、全JS拒否と通知再入の組合せ、
実プリンター・spooler、全workerと全依存の停止、ng/POSIXの実行。
この修正・限定試験の通過は、レビューの未確認範囲を解消したことや全体の安全を保証しない。
