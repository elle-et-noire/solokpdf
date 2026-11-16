# TreeView の手動確認

2026-11-09 に所有者が手順の全項目を OK と報告した（F2 完了）。既定化した仮想ツリーが対象。
Debug・Release とも同じ部品を使う。確認した環境・バージョンの詳細は未記録。
既定化時の自動テスト結果は [history.md](../history.md#virtual-sidebar-rollout-2026-11-09)、
試作時の結果は [置き換え計画](tree-view-replacement-plan.md#試作の結果) を参照する。

手順（起動・読み上げ・スクロールと DPI）は [testing.md](../testing.md#physical-tree-checks) へ移した。

## 実施結果

2026-11-09: 手順提示後、所有者が「どれもOKです」と報告。下表を所有者報告による確認済みとし、F2 と E10 を完了した。
実行ファイルのコミット、Debug／Release、Windows ビルド、読み上げソフトのバージョン、モニター倍率は未記録。
この報告は所有者の実機確認であり、エージェントによる再実行結果ではない。

| 項目                    | 結果             | 環境詳細 |
| ----------------------- | ---------------- | -------- |
| Narrator                | OK（所有者報告） | 未記録   |
| NVDA                    | OK（所有者報告） | 未記録   |
| 縦横のバーと実カーソル  | OK（所有者報告） | 未記録   |
| 実モニター間の DPI 移動 | OK（所有者報告） | 未記録   |

### 実機確認前の記録

2026-11-09: 差分レビューを完了。当時、Windows 操作ヘルパーは `native pipe is unavailable` で接続できず、実画面の操作は未実施。
スクロール確認用の文書とモード別設定を、ローカルの `.work/tree-manual-review/` に準備した。
既定表示で UIA/MSAA の名前・階層移動・展開・選択・スクロールを実クライアントから確認した。
これは Narrator／NVDA の実際の読み上げを確認した結果ではない。
Release の Light／Dark を非表示デスクトップで起動し、Windows／overlay モードの実描画を `PrintWindow` で確認した。
接続ディスプレイは 1 台のため、異なる実モニター間の移動も未確認。

準備したスクロール用文書は、リポジトリのルートから次のように起動する。`$mode` を切り替えて各モードを確認する。
同じ端末内では、アプリを閉じてから次のモードへ進む。

```powershell
$mode = 'windows' # windows / overlay / smart / hidden
& ./out/dbg64/SumatraPDF.exe -for-testing -appdata "$PWD/.work/tree-manual-review/$mode" "$PWD/.work/tree-manual-review/scroll-check.pdf"
```
