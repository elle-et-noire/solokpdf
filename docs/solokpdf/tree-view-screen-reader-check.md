# TreeView の読み上げ確認

Narrator と NVDA で、それぞれ以下を確認する。自動テストとは別に、操作する人のデスクトップで実行する。

PowerShell でリポジトリのルートから起動する。専用の PDF と設定は `.work/tree-reader-check` に作られる。
準備コマンドは専用設定を毎回上書きする。

```powershell
. ./tools/solokpdf/env.ps1 -Toolset v145
bun tools/solokpdf/tree-reader-fixture.ts
$oldToc = $env:SOLOKPDF_VIRTUAL_TOC
$oldFavorites = $env:SOLOKPDF_VIRTUAL_FAVORITES
try {
    $env:SOLOKPDF_VIRTUAL_TOC = '1'
    $env:SOLOKPDF_VIRTUAL_FAVORITES = '1'
    & ./out/dbg64/SumatraPDF.exe -for-testing -appdata "$PWD/.work/tree-reader-check/appdata" "$PWD/.work/tree-reader-check/tree-reader-check.pdf"
} finally {
    $env:SOLOKPDF_VIRTUAL_TOC = $oldToc
    $env:SOLOKPDF_VIRTUAL_FAVORITES = $oldFavorites
}
```

デバッグ版のビルドが必要な場合は、先に `MSBuild.exe vs2026/SumatraPDF.vcxproj '/p:Configuration=Debug;Platform=x64' /m` を実行する。`-for-testing` により既存のセッションと設定は変更されない。

1. スクリーンリーダーを有効にし、目次にフォーカスを移す。ツリー名と `First`、`Second`、`Third` の項目名・選択状態が分かることを確認する。
2. `Second` で右矢印を押し、展開状態と子項目 `Nested`、階層が分かることを確認する。左矢印で折り畳み、状態の変化を確認する。
3. Tab と Shift+Tab で目次とお気に入りの間を移動する。お気に入りのツリー名とファイル名を確認し、ファイル名で右矢印を押す。`First favorite` と `Third favorite` の項目名、階層、選択状態が分かることを確認する。
4. お気に入りで上下キーを押し、Enter で選択項目のページへ移動する。キーボードのコンテキストメニューも確認する。
5. 各ツリーの検索欄で項目を絞り込み、検索文字を消す。結果の変化と復元後の項目を読み上げられることを確認する。

各スクリーンリーダーについて、バージョン、実施結果、読み上げられなかった情報や操作を記録する。試験後は SolokPDF を閉じ、両者を別々に確認する。
