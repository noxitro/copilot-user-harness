# copilot-user-harness

GitHub Copilot で「実装役が書き、審査役が確かめ、合格したら次へ進む」を回すための部品集です。
どのリポジトリにも同じ手順と同じ確認を入れられるよう、部品の原本をここに 1 か所で持ちます。

ここで言う **ハーネス** は、Copilot そのもの(実行環境)ではなく、その上に載せる **ユーザーハーネス** のことです。
実装役と審査役のカスタムエージェント、フェーズとゲート条件を書く雛形、1 フェーズを回す起動手順の組み合わせを指します。

## 何ができるか

- フェーズごとに、実装役(`implementer`)が実装し、審査役(`reviewer`)が自分で測り直して PASS / FAIL を出す。
- FAIL なら再現手順付きで差し戻し、3 周で通らなければ止まって人に戻る。
- テストの書き換えで合格させる、審査役がこっそり直す、といったごまかしを決まりと差分の比較で止める。
- フェーズが終わるたびに結果と所要を記録し、後から「何にどれだけかかったか」を比べられる。

```text
人がフェーズとゲート条件を書く(HARNESS.md)
  → /phase-loop N
  → implementer: 実装・ビルド・テスト・自己検証 → 定型の報告
  → reviewer: テストの差分確認・測り直し・わざと壊して検出できるか・意地悪テスト → VERDICT
  → FAIL: 差し戻し(最大 3 周) / PASS: 人が確かめてコミット → 記録 → 次のフェーズ
```

## 中身

| 置き場 | 中身 | 配布先での置き場 |
| --- | --- | --- |
| `harness/.github/agents/` | 実装役 `implementer.agent.md`、審査役 `reviewer.agent.md` | `.github/agents/` |
| `harness/.github/skills/phase-loop/` | 1 フェーズを回す起動手順(Copilot CLI とそれを基盤とする面のスキル)と、審査の前後に作業ツリーを採取して比べる `snapshot.ps1` | `.github/skills/phase-loop/` |
| `harness/.github/prompts/` | 同じ起動手順(VS Code / VS 2026 用のプロンプトファイル) | `.github/prompts/` |
| `harness/.github/extensions/phase-gate/` | 同じ段取りをコードで固定したワークフロー版(dynamic workflows はプレビュー機能)。`-Workflow` を付けたときだけ配る | `.github/extensions/phase-gate/` |
| `harness/HARNESS.md` | 役割・流れ・運用ルール・ゲート条件の枠(種) | ルート |
| `harness/docs/TEST_REPORT.md` | フェーズ × 環境の結果を 1 枚にまとめる表(種) | `docs/` |
| `harness/docs/acceptance-checklist.md` | 満たすべき動きを実装の前に書き出し、1 項目ずつ照合する受け入れ項目の表(種) | `docs/` |
| `docs/gate-conditions.md` | ゲート条件とフェーズの分け方の書き方 | 配らない(読む資料) |
| `docs/phase-gate.md` | ワークフロー版の置き方と回し方 | 配らない(読む資料) |
| `authoring/` | スキルを 1 本作るときの雛形 `SKILL.md` と依頼票 `skill-request.md` | 配らない(コピーして使う) |

**種**は最初の 1 回だけ置かれ、以後は配布先で育てます。種以外の部品は配布先で直さず、プロジェクト固有のこと
(ビルドやテストのコマンド、テストの置き場、意地悪テストの観点)は `HARNESS.md` に書きます。部品はそれを読んで動きます。

## 必要なもの

- GitHub Copilot(Copilot CLI とそれを基盤とする面、VS Code、Visual Studio 2026 のいずれか)。カスタムエージェントとスキルを使える状態であること
- 配布先が git リポジトリで、コミットが 1 つ以上あること(審査の前後で `git diff HEAD` を比べるため)
- 導入する PC: Windows と Windows PowerShell 5.1 以降(`install.bat` / `install.ps1` は Windows 専用)
- 配布先でフェーズを回す PC: PowerShell(Windows は標準のもの、それ以外は `pwsh`)。phase-loop が審査の前後に `snapshot.ps1` を実行するため
- ワークフロー版を使うときだけ: dynamic workflows を有効にした Copilot CLI([docs/phase-gate.md](docs/phase-gate.md) の「置き方」)
- 部品を直してテストを回すときだけ: Node.js 22 以降

## 導入

### ダブルクリックで

1. このリポジトリを clone する。
2. `install.bat` をダブルクリックし、配布先リポジトリのパスを入力する。

### コマンドで

```bat
install.bat ..\my-app
install.bat ..\my-app -Workflow
install.bat ..\my-app -Check
```

| スイッチ | 意味 |
| --- | --- |
| `-Workflow` | ワークフロー版 phase-gate も配る。一度入れると以後の実行でも配り続ける(外すときは `-Remove` してから `-Workflow` なしで入れ直す) |
| `-Check` | 何も書かずに、配る物・消す物があるかだけを報告する。`-Remove` とは同時に使えない |
| `-Remove` | このスクリプトが置いた部品を消す。手で直した部品と種は残す |
| `-Force` | 手で直した部品・手で置かれた同名のファイルも上書き(`-Remove` では削除)する |

| 終了コード | 意味 |
| --- | --- |
| 0 | 問題なし |
| 1 | 失敗した、または `-Check` で配る物・消す物があった |
| 2 | 配ったが警告がある(手で直した部品をスキップした、`.gitignore` に `e2e-artifacts/` が無い、など) |

配った部品の一覧とハッシュは、配布先の `.github/copilot-user-harness.json` に記録されます。
配布先で手を入れた部品は、`-Force` を付けない限り上書きも削除もしません。改行コード(CRLF / LF)の違いだけなら「手を入れた」とは見なしません。

導入したら、配布先の `.gitignore` に `e2e-artifacts/`(証拠の置き場)を足してください。スクリプトは `.gitignore` を書き換えず、無ければ警告だけ出します。
ビルドやテストのたびに作り直されるファイル(生成物・キャッシュ・カバレッジ)も `.gitignore` に入れておきます。入っていないと、審査の前後で作業ツリーが食い違い、判定が毎回無効になります。

## 使い方

### 1. HARNESS.md を埋める

配布先の `HARNESS.md` の `{{ }}` を埋めます。人の仕事はほぼここだけです。

- **環境**: ビルド・テスト・実行のコマンド、テストディレクトリ、外部 API の文書の置き場
- **意地悪テストの観点**: このプロジェクトで壊れやすい入力や状態
- **フェーズとゲート条件**: 審査役が機械的に確かめられる形で書く。書き方は [docs/gate-conditions.md](docs/gate-conditions.md)

実装を始める前に、`docs/acceptance-checklist.md`(受け入れ項目)に満たすべき動きを書き出します。最終フェーズのゲート条件がこの表を指します。

フェーズの分け方は、チャットの plan モードで案を出させ、人が承認してから書いても構いません。

### 2. 部品が見えることを確かめる

配布先でチャットを開き、`implementer` と `reviewer` のエージェント、`phase-loop` のスキル(VS Code ではプロンプト)が
一覧に出ることを目で確かめます。審査役には「1 行直して」と頼み、断ることも確かめます。

### 3. Phase 0 で審査役を試す

`HARNESS.md` の付録 B のとおり、正しい状態で PASS が出ること(陰性コントロール)と、
わざと壊した状態で FAIL が出て指摘がその箇所を指すこと(陽性コントロール)を確かめます。

### 4. フェーズを回す

| 面 | 頼み方 |
| --- | --- |
| Copilot CLI とそれを基盤とする面 | `/phase-loop 1`、または「HARNESS.md の Phase 1 を phase-loop で進めて」 |
| VS Code | チャットで `/phase-loop` を選び、フェーズ番号を入れる |
| VS 2026 | チャットからプロンプトファイル `phase-loop` を呼び、フェーズ番号を入れる |
| ワークフロー版 | [docs/phase-gate.md](docs/phase-gate.md) の「回し方」 |

チャットは次の所で止まり、人の判断を待ちます。

- 実装役が「止めて報告」したとき
- テストディレクトリに追加以外の変更(書き換え・削除・名前の変更)があったとき。承認するなら `docs/TEST_REPORT.md` の承認記録に行を足す
- 審査の前後で作業ツリーが変わったとき(その判定は無効。戻してから再審査)
- 3 周で PASS しなかったとき(フェーズを分けるか、要件を見直す)
- PASS して締めに入ったとき(差分を確かめ、介入時間を答える)

コミットは人が行います。フェーズが終わると、`docs/TEST_REPORT.md` の更新案と `docs/phase-log.csv` の 1 行が差分で出ます。
チャットが途中で落ちたら、作業ツリーはそのまま残っているので、同じフェーズ番号で `/phase-loop N` をもう一度頼みます。

### 5. 更新を取り込む

このリポジトリを pull してから、同じ配布先に `install.bat <配布先> -Check` で何が変わるかを見て、`-Check` なしでもう一度実行します。
配布先で直していない部品だけが更新され、種と手で直した部品はそのまま残ります(スキップした部品は警告に出ます)。
種(`HARNESS.md` など)の雛形が新しくなっても配布先には届かないので、必要なら手で取り込みます。

## 使う人ごとの関わり方

| 使う人 | すること |
| --- | --- |
| 作業者 | 導入済みのリポジトリで、`/phase-loop N` を回す。止まったら判断する |
| リーダー | 導入し、HARNESS.md のフェーズとゲート条件を書く。審査役の観点を案件に合わせて足す |
| 部品を育てる人 | 案件で見つけた改善を、このリポジトリの部品に戻す |

## 部品を直すとき

- 起動手順はスキル(`harness/.github/skills/phase-loop/SKILL.md`)とプロンプト(`harness/.github/prompts/phase-loop.prompt.md`)の 2 本があり、
  本文は同じです。直すときは両方を直します(違うのは frontmatter とフェーズ番号の受け取り方だけ。`npm test` が食い違いを見つけます)。
- 段取りを変えたら、ワークフロー版(`harness/.github/extensions/phase-gate/extension.mjs`)も合わせます。
- 部品を変えたら `VERSION` を上げ、テストを回します。

```bat
npm test
```

テストは AI クレジットを使いません。ワークフロー版の段取りの分岐(偽の実行環境)、導入スクリプトの動き(一時フォルダへの配布)、
`snapshot.ps1` の採取と比較、スキルとプロンプトの本文の一致を確かめます。導入スクリプトと `snapshot.ps1` のテストは Windows でだけ動きます。

GitHub では、`main` への push と pull request のたびに、同じ `npm test` が Windows と Linux(Node.js 22)で回ります
(`.github/workflows/test.yml`。Actions タブから手で回すこともできます)。

## ライセンス

[MIT](LICENSE)
