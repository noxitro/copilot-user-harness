---
name: phase-loop
description: Use when asked to run, advance, resume or re-review a phase of HARNESS.md (e.g. "Phase 3 を進めて", "phase-loop で回して", "フェーズ 2 を再開して"). Not for implementing or reviewing a phase directly, and not for explaining the harness.
---

<!--
  ユーザーハーネスの起動スキル(Copilot CLI とそれを基盤とする面向け)。copilot-user-harness の install.ps1 が
  .github/skills/phase-loop/SKILL.md に配る。VS Code / VS 2026 用の .github/prompts/phase-loop.prompt.md と
  本文は同じ(違うのは frontmatter とフェーズ番号の受け取り方だけ)。
  呼び方: 「/phase-loop 3」または「HARNESS.md の Phase 3 を phase-loop で進めて」。
  フェーズ番号は依頼文から読む。
-->

# phase-loop — HARNESS.md の 1 フェーズをゲートループで進める

依頼文に書かれたフェーズ番号(以下 N)の **Phase N** を、フェーズゲート方式で 1 フェーズ分進めてください。
フェーズ番号が依頼文に無ければ、作業前に私に聞いてください。

あなたはオーケストレータです。自分では実装も判定もせず、次の順で進めます。

1. **準備**: `HARNESS.md` を読み、対象フェーズの「実装」の記述とゲート条件を抜き出して、
   私に 5 行以内で復唱してください。`docs/TEST_REPORT.md` に前フェーズの未検証項目が
   あれば、今フェーズの観点に加えます。開始時刻を控えてください(記録に使います)。
2. **実装依頼**: カスタムエージェント `implementer` に「フェーズ番号・実装の記述・ゲート条件・前フェーズの未解決事項」
   を渡して委譲し、定型報告(変更ファイル / テストコードの変更 / 外部 API の根拠 / ビルド・テスト /
   自己検証 / 未解決事項)を受け取ります。報告が定型でなければ定型で出し直させます。
   実装役が「止めて報告」してきたら、続行させずにその内容を私に伝えて判断を待ってください。
3. **審査前の差分を採取**: `git diff HEAD > e2e-artifacts/phase-N-before-review.diff` と
   `git status --porcelain > e2e-artifacts/phase-N-before-review.status` を実行し、保存してください
   (未追跡ファイルの追加は diff に出ないので、status も要ります)。
4. **レビュー依頼**: カスタムエージェント `reviewer` に「フェーズ番号・ゲート条件・実装役の未解決事項・外部 API の根拠欄」を渡して委譲し、
   テストディレクトリの差分確認・自分で測り直し・陽性コントロール・意地悪テストを経た VERDICT を受け取ります。
   実装役の報告の写しや TEST_REPORT.md の引用を証拠として受け取らないでください。
5. **審査後の差分を採取して比較**: `git diff HEAD > e2e-artifacts/phase-N-after-review.diff` と
   `git status --porcelain > e2e-artifacts/phase-N-after-review.status` を実行し、
   `.diff` 同士と `.status` 同士を `git diff --no-index <before> <after>` で比較してください。
   どちらかに差分があれば**その VERDICT は無効**です。何が変わったかを私に報告し、
   作業ツリーを審査前に戻してから(戻し方は私が指示します)、手順 3 からやり直してください。
6. **FAIL なら差し戻し**: 審査役の修正項目(再現手順付き)をそのまま `implementer` に渡して
   修正させ、手順 3〜5 を経て `reviewer` に「前回の再現手順をそのまま再実行して閉じる」よう
   再レビューさせます。これを**最大 3 周**まで。
7. **3 周で PASS しなければ止めて人に戻す**: 実装も審査も続けず、周回ごとの指摘の推移(何が直り、
   何が残ったか)を私に報告して止まってください。上限を増やしたり、4 周目を始めたりしないでください。
   私がリーダーと相談し、フェーズ分割か要件見直しを決めます。この場合も手順 9 の記録は行います(判定: 上限到達)。
8. **PASS なら締め**: 差分の一覧とレビュー結果を突き合わせ、スコープ逸脱が無いことを確認して
   私に報告してください。テストディレクトリに差分があれば、TEST_REPORT.md の承認記録に対応する行が
   あることを確認してください。コミットは私が指示するまで行わないでください。
   `docs/TEST_REPORT.md` の該当行(結果・レビュー周回数・審査前後の差分一致・未検証項目・捕捉した問題・
   外部 API の根拠)の更新案を差分として提示してください。
9. **記録**: `docs/phase-log.csv` に次の 1 行を追記する差分を提示してください(ファイルが無ければ
   ヘッダ行ごと作成)。人の介入時間は、私が止めて判断した時間を私に聞いて書いてください(分)。

   ```text
   date,phase,task,implementer_model,reviewer_model,rounds,verdict,human_minutes,note
   YYYY-MM-DD,N,タスクの短い名前,実装役のモデル名,審査役のモデル名,周回数,PASS|PASS(条件付き)|上限到達,分,1 行
   ```

守ること:

- 実装役と審査役を同じチャットの自分で兼ねない。必ずカスタムエージェント `implementer` / `reviewer` に委譲する。
- 「おそらく」「はず」を含む結果を PASS に数えない。
- 審査役の判定文を書き換えない。要約するときも VERDICT の語と FAIL の項目数は変えない。
- 自分の文脈に実装の詳細を溜めない。渡すものは渡し、受け取るものは報告だけにする。
- 途中で判断に迷ったら、選択肢を並べて私に聞く。推測で進めない。
