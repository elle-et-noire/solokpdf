# SolokPDF の現行設計

E21 の色方針と E19 の描画結果契約を反映した Win32 版の責務と状態。設計上の見直しは
[リファクタリング計画](refactoring-plan.md)、実装・検証履歴は [history.md](history.md) を参照する。

## PDF エンジンの役割

PDFium と MuPDF は文書全体で排他的に切り替わるものではない。
通常の本文は PDFium が描画し、必要な操作だけ MuPDF が担当する。

| 経路                          | 判断する場所                                                                                              | 役割                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 文書を開く                    | [EngineCreate.cpp](../../src/shared/EngineCreate.cpp)                                                     | PDFium の失敗時に MuPDF で文書を開く。パスワード入力の中止など、再試行しない失敗を区別する |
| ページを描く                  | [EnginePdfium.cpp](../../src/solokpdf/EnginePdfium.cpp) の `PrepareRenderRoute`、`DrawPage`、`RenderPage` | ページの内容・テーマ変換の可否に応じて描画経路を選ぶ。文書全体のエンジンは変えない         |
| 注釈・フォームを編集する      | `AnnotationEditor`、[EngineMupdf.cpp](../../src/shared/EngineMupdf.cpp) の `AnnotEngineMupdf`             | 同じ文書の編集エンジンを遅延生成する。文書 JavaScript や一部の読み取りにも使う             |
| テーマ・特殊な PDF 情報を扱う | [EngineAll.h](../../src/shared/EngineAll.h) の PDF 用 API                                                 | 描画用プローブ、テーマ変換、ページ形状など。遅延編集エンジンとは別の用途                   |

注釈描画はタイルごとに編集エンジンの有無を一度読み、二重描画を避ける。
墨消し適用後のページは編集エンジンが描画・読み取りを担当する。
編集前の元データのコピーと、編集内容の保存・再読み込みは別の操作である。
詳細は [annotations.md](annotations.md#design) を参照する。

## 描画と色処理

`CapturePageColors` がプレビューを含む有効モードを一度取得し、[Theme.cpp](../../src/shared/Theme.cpp) の
`ThemePageRenderColors` に渡して色反転を含む実効色を取得する。
このモード・前景色・背景色・リンク色を `PageColorInput` として、通常描画と Home のサムネイルが保持する。
[PdfDarkModeProfile.cpp](../../src/shared/PdfDarkModeProfile.cpp) の分類別プロファイル生成は、
この値だけを参照し、設定やテーマを読み直さない。
値の取得全体を原子的にする変更ではなく、要求と描画世代の対応は E22 の対象に残る。
[Pixmap.cpp](../../src/base/Pixmap.cpp) の `RecolorPageColor` と `RecolorPixmap` は同じ画素変換を使う。
PDF の色空間から RGB への変換と、テーマ色への変換は別の処理である。

| 経路                                    | 現在の処理                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| PDFium の smart                         | MuPDF でページの色を変えた一時 PDF を作り、PDFium が描画する。変換に失敗した場合は MuPDF 描画を使う |
| MuPDF の smart・PDFium の代替・注釈合成 | MuPDF の描画デバイスを通して色を変える。マスクなど元の色を保つ条件を持つ                            |
| PDF の smart の表示後処理               | エンジン内で色変換後、`RenderViewPage` がグレースケール、明度・コントラスト補正を行う               |
| legacy の表示後処理                     | `RenderViewPage` が補正後、ビットマップを再着色する                                                 |
| F12 ページサムネイル                    | `RenderPageThumbnail` が `RenderViewPage` を使う                                                    |
| Home の保存済みサムネイル               | 中立 PNG を複製し、補正後に再着色する。画像保持は保存した矩形による近似                             |

`8bf864e18` で集約した `GetPageColorPass` がエンジン分類・入力元・プロファイルから
色変換の担当を `None`・`Renderer`・`Bitmap` で返す。
[RenderViewPage](../../src/shared/RenderCache.cpp) と Home のサムネイルがこの方針を使う。
PDF の smart は描画側、Home の中立画像はビットマップ側で変換する。
これは予定する段階の指定。実施状態は `RenderPageArgs::color_out` の
`RenderPageColor::Original`・`Themed` で成功時だけ返す。呼び出し側は `Original` で初期化する。
PDFium と MuPDF が描画時の変換を報告し、`RenderViewPage` は変換済みの画素を再着色しない。
引数のコピーにローカルなプロファイルと出力先を渡し、呼び出し元に一時ポインターを残さない。

`PrepareRenderRoute` の `PdfRenderRoute` は経路判定。
`DrawPage`・`DrawMupdf` の `PageDrawResult` は完了・代替要求・中止・失敗と色状態を返す。
PDFium の進行状態は `DrawPage` 内だけで扱い、代替要求だけを `DrawMupdf` で再実行する。
ビットマップ生成・通常ページ読み込み・PDFium 描画の失敗を、一律に代替要求には変えない。

描画先は背景を埋めた BGRA8 の借用バッファ。PDFium は straight alpha、MuPDF の代替は
乗算済み alpha を生成し、`Pixmap::hasAlpha`・`premultiplied` が後処理を決める。
透明な PDFium 出力だけを一度乗算し、その後に編集エンジンの注釈を合成する。
不透明な View 出力は従来どおり gray DIB または BGR8 に縮める。
成功した `Pixmap` は呼び出し側が所有し、失敗・中止・注釈合成失敗では解放して null を返す。
MuPDF も結果公開前に中止を確認する。テーマ・PDFium ロックの範囲と画素後処理の並列性は維持する。

キャッシュの依存も複数箇所で管理する。`UpdateDocumentColors` は実効色・設定を比較してタイル世代を進め、
PDFium はページと色でテーマ変換結果を再利用する。
[Home のサムネイル](../../src/shared/FileThumbnailsCommon.cpp) はプロファイルと補正値の hash を使う。
ページ描画経路や画像矩形など、テーマ非依存の情報もあるため、無効化は一律ではない。
再利用条件の見直しは [計画](refactoring-plan.md) の E22 で扱う。

## 所有権と同期

| 所有するもの                                          | 現在の責務                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [PdfiumRuntime](../../src/solokpdf/PdfiumRuntime.cpp) | DLL API、ライブラリ初期化・参照数、フォントキャッシュ。利用者がゼロでも DLL は保持する                                            |
| `EnginePdfium`                                        | PDFium 文書・ページ情報、入力バイト列またはファイル、パスワード、遅延編集エンジン、描画プローブ、テーマキャッシュを保持・解放する |
| `gPdfiumLock`                                         | 文書をまたぐ PDFium API とランタイムの操作を直列化する                                                                            |
| `editorLock`                                          | 遅延編集エンジンの初回生成を保護する。生成結果は atomic なポインター操作で公開する                                                |
| `themeLock`                                           | 描画経路の準備とテーマキャッシュの利用を保護する。`DrawPage` はこの後に `gPdfiumLock` を取る                                      |
| `fileLock`                                            | ファイルからの位置指定読み取りを保護する                                                                                          |

パスワード問い合わせ中は `gPdfiumLock` を解放する。ダイアログのメッセージ処理中に
他の PDFium 操作が再入し得るため、この順序も設計の一部である。
上表は各経路の責務であり、全ロックの取得順を検証済みという意味ではない。

## 読み取り API の契約

UI の hover・paint は、検索などの完全な読み取りと待機・編集エンジン生成の条件が異なる。
`EditorLoad::IfLoaded` と `EditorLoad::Load` が生成の可否を指定する。
`Try*` の戻り値の意味は API ごとに異なる。

| API                     | `EnginePdfium` の現在の意味                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `TryExtractPageText`    | ロック競合や編集エンジンが必要で取得できない場合は `false`。不完全な文字列を完全な結果として返さない            |
| `TryGetElements`        | PDFium ロック競合は `false`。編集エンジン未生成時でも PDFium 側の要素を返せる。全要素の取得完了を示す値ではない |
| `TryHasPageAnnotations` | ロック競合も注釈なしも `false`。hover がその回の処理を見送るために使う                                          |
| `TryFormWidgetAt`       | ロック競合では `true` と `found=false`。編集エンジン生成済みでは `false` としてそちらへ委ねる                   |

これは現行動作の記録であり、不具合の認定ではない。戻り値を統一する前に、
基底実装・各エンジンの実装と呼び出し側の再試行・キャッシュ処理を確認する必要がある。

## UI と入力

- `SidebarTree` は既存 `TreeView` API と仮想ツリーの変換を担当する。
  `VirtTree` が選択・展開・配置・描画・通知順を管理し、UIA/MSAA は専用プロバイダーが扱う。
  モデル本体の所有権は移していない。
- `MainWindow::GetKeyTarget` が入力先を分類し、`SumatraPDF.cpp` がメッセージを配送する。
  `VimKeys.cpp` が優先順位と実行を扱い、`KeyInputState` は回数・接頭キーの状態だけを持つ。
  送り先 HWND と実フォーカスは別に判定する。
- [AppSettings.cpp](../../src/shared/AppSettings.cpp) の `ApplySettingsToOpenWindows` が
  メモリ上の設定を反映する。`-for-testing` では設定ファイルを書き換えない。

ツリーの配置・内部状態、PDFium ランタイム、キー状態の分離とレビューは完了済み。
次の作業で再実装する前提にはしない。
