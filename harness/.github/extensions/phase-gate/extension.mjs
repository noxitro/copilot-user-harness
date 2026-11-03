// phase-gate: phase-loop(スキル)と同じ段取りを、dynamic workflows のコードで固定したもの。
// 置き場: リポジトリの .github/extensions/phase-gate/extension.mjs(使い方は同じフォルダの README.md)。
// 前提: HARNESS.md(ルート)、.github/agents/implementer.agent.md と reviewer.agent.md、docs/TEST_REPORT.md。
// 下の定数だけをリポジトリに合わせて直す。段取り(周回の数え方・止まる所)は変えない。
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_ROUNDS = 3; // 審査の差し戻しの上限(4 周目は始めない)
const MAX_FORMAT_RETRIES = 2; // 実装役の報告が定型にならないときの出し直しの回数
const ART = "e2e-artifacts"; // 証拠の置き場(HARNESS.md の「証拠の置き場」と同じにする。gitignore 対象)
const READ_ALSO = ["GOAL.md"]; // HARNESS.md と一緒に読ませる文書(ルートにあるものだけ渡す)
const PROTECTED = []; // 触ってはいけないファイル(例: /^src\/generated\//)。締めで変更の有無を見せる
// 「推測の PASS」を数えないための語。「はずれ」「はずす」などは拾わない
const HEDGE = /おそらく|たぶん|はず(?![れさしすせそ])/;

const implSchema = {
    type: "object",
    additionalProperties: false,
    required: [
        "stopped", "stopReason", "changedFiles", "testCodeChanges",
        "externalApiEvidence", "buildTest", "selfVerification", "unresolved",
    ],
    properties: {
        stopped: { type: "boolean" },
        stopReason: { type: "string" },
        changedFiles: { type: "array", items: { type: "string" } },
        testCodeChanges: { type: "string" },
        externalApiEvidence: { type: "string" },
        buildTest: { type: "string" },
        selfVerification: { type: "string" },
        unresolved: { type: "string" },
    },
};

const reviewSchema = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "conditions", "failItems", "unverified", "reportText"],
    properties: {
        verdict: { type: "string", enum: ["PASS", "PASS(条件付き)", "FAIL"] },
        conditions: { type: "string" },
        failItems: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["priority", "item", "reproduction"],
                properties: {
                    priority: { type: "integer" },
                    item: { type: "string" },
                    reproduction: { type: "string" },
                },
            },
        },
        unverified: { type: "array", items: { type: "string" } },
        reportText: { type: "string" },
    },
};

const root = () => process.cwd();
const path = (...p) => join(root(), ...p);
const readText = (p) => readFileSync(path(p), "utf8");

function git(args, okCodes = []) {
    try {
        return execFileSync("git", args, { cwd: root(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    } catch (e) {
        if (okCodes.includes(e.status) && typeof e.stdout === "string") return e.stdout;
        throw e;
    }
}

function writeArtifact(name, text) {
    mkdirSync(path(ART), { recursive: true });
    writeFileSync(path(ART, name), text, "utf8");
}

function parsePhase(args) {
    const raw = typeof args === "object" && args !== null ? args.phase : args;
    const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
    if (!Number.isInteger(n) || n < 0) throw new Error(`phase はフェーズ番号(0 以上の整数)で指定する。受け取った値: ${JSON.stringify(args)}`);
    return n;
}

function section(text, startRe) {
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => startRe.test(l));
    if (i < 0) return null;
    const level = lines[i].match(/^#+/)[0].length;
    let j = i + 1;
    while (j < lines.length) {
        const m = lines[j].match(/^(#+) /);
        if (m && m[1].length <= level) break;
        j++;
    }
    return lines.slice(i, j).join("\n").trim();
}

// エージェントの定義の model(コメントアウトされていれば本体と同じ)。記録に書くだけで、呼び出しには使わない
function agentModel(name) {
    const p = path(".github", "agents", `${name}.agent.md`);
    if (!existsSync(p)) return "(定義が無い)";
    const front = readFileSync(p, "utf8").split(/\r?\n---\r?\n/)[0];
    const m = front.match(/^model:\s*["']?([^"'\r\n#]+?)["']?\s*$/m);
    return m ? m[1] : "(本体と同じ)";
}

function prepare(n) {
    if (!existsSync(path("HARNESS.md"))) {
        throw new Error(`HARNESS.md が作業フォルダ(${root()})に無い。リポジトリのルートで実行する。`);
    }
    const harness = readText("HARNESS.md");
    const phaseSec = section(harness, new RegExp(`^### Phase ${n}[::]`));
    if (!phaseSec) throw new Error(`HARNESS.md に Phase ${n} の節(### Phase ${n}: …)が無い。`);
    const common = section(harness, /^### 全フェーズ共通/) ?? "";
    const gates = `${common}\n\n${phaseSec}`.trim();
    const docs = ["HARNESS.md", ...READ_ALSO.filter((f) => existsSync(path(f)))];

    let prior = "";
    if (n > 0 && existsSync(path("docs", "TEST_REPORT.md"))) {
        const report = readText("docs/TEST_REPORT.md");
        const unver = (section(report, /^## 未検証項目と理由/) ?? "").split("\n").slice(1).filter((l) => l.trim()).join("\n");
        const prev = section(report, new RegExp(`^### Phase ${n - 1}[::]`)) ?? "";
        const prevLines = prev.split("\n").filter((l) => /未検証|➖|未解決/.test(l)).join("\n");
        prior = [unver, prevLines].filter(Boolean).join("\n").trim();
    }
    return {
        gates, prior, docs, startedAt: new Date().toISOString(),
        title: phaseSec.split("\n")[0].replace(/^#+\s*/, ""),
        implementerModel: agentModel("implementer"), reviewerModel: agentModel("reviewer"),
    };
}

function snapshot() {
    return `${git(["diff", "HEAD"])}\n--- git status --porcelain ---\n${git(["status", "--porcelain"])}`;
}

function checkImpl(r) {
    const blank = ["testCodeChanges", "externalApiEvidence", "buildTest", "selfVerification"].filter((k) => !String(r[k] ?? "").trim());
    if (blank.length) return `空の欄: ${blank.join(", ")}`;
    if (r.stopped && !String(r.stopReason ?? "").trim()) return "stopped なのに stopReason が空";
    return null;
}

function formatImpl(r) {
    return [
        "## 変更ファイル", ...(r.changedFiles ?? []).map((f) => `- ${f}`),
        "", "## テストコードの変更", r.testCodeChanges,
        "", "## 外部 API の根拠", r.externalApiEvidence,
        "", "## ビルド・テスト", r.buildTest,
        "", "## 自己検証", r.selfVerification,
        "", "## 未解決事項", r.unresolved || "(なし)",
        ...(r.stopped ? ["", "## 止めて報告", r.stopReason] : []),
    ].join("\n");
}

function formatFix(items) {
    return items.map((f) => `${f.priority}. ${f.item}\n   再現手順: ${f.reproduction}`).join("\n");
}

function formatReview(v) {
    return `${v.reportText}\n\n--- 構造化フィールド(審査役の出力そのまま) ---\nverdict: ${v.verdict}\nconditions: ${v.conditions}\nfailItems:\n${formatFix(v.failItems ?? []) || "(なし)"}\nunverified: ${(v.unverified ?? []).join(" / ") || "(なし)"}`;
}

function unifiedDiff(relPath, newText) {
    const tmp = `proposed-${relPath.replace(/[\\/]/g, "_")}`;
    writeArtifact(tmp, newText);
    const oldSide = existsSync(path(relPath)) ? relPath : "/dev/null";
    return git(["diff", "--no-index", "--", oldSide, `${ART}/${tmp}`], [1]);
}

function csvEscape(s) {
    const t = String(s ?? "").replace(/\r?\n/g, " ");
    return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// TEST_REPORT.md の結果マトリクスの、フェーズ n の行の更新案(列は見出しの名前で探す)
function reportRowUpdate(reportText, n, verdict, rounds) {
    const lines = reportText.split(/\r?\n/);
    const cellsOf = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
    const h = lines.findIndex((l) => /^\|\s*フェーズ\s*\|/.test(l));
    if (h < 0) return { lines, note: "結果マトリクスの見出し(| フェーズ | …)が見つからない。人が書く" };
    const head = cellsOf(lines[h]);
    let end = h + 1;
    while (end < lines.length && lines[end].startsWith("|")) end++; // 探すのは、この表の中だけ(後ろの別の表は見ない)
    const i = lines.findIndex((l, k) => k > h && k < end && new RegExp(`^\\|\\s*${n}\\s*\\|`).test(l));
    if (i < 0) return { lines, note: `結果マトリクスに Phase ${n} の行が見つからない。人が追記する` };
    const cells = cellsOf(lines[i]);
    while (cells.length < head.length) cells.push("");
    const set = (name, value) => {
        const c = head.findIndex((x) => x === name || x.startsWith(`${name}(`));
        if (c >= 0) cells[c] = value;
    };
    set("環境 A", verdict === "PASS" ? "✅" : "⚠(条件は審査結果を参照)");
    set("レビュー周回数", String(rounds));
    set("審査前後の差分一致", "一致");
    lines[i] = `| ${cells.join(" | ")} |`;
    return { lines, note: null };
}

async function record(ctx, n, prep, rounds, verdict, note, review, checkpoint) {
    ctx.phase("記録");
    const minutesFile = `${ART}/phase-${n}-human-minutes.txt`;
    const readMinutes = () => ctx.step(`minutes:${n}`, () => {
        if (!existsSync(path(minutesFile))) return null;
        const v = readText(minutesFile).trim();
        return /^\d+(\.\d+)?$/.test(v) ? v : null;
    }, { volatile: true });
    let minutes = await readMinutes();
    if (minutes === null) {
        await checkpoint("minutes", "人の介入時間(分)が未記入", `${minutesFile} に数字だけを書いてから resume する(書かなければ「未記入」で記録案を出す)。`);
        minutes = (await readMinutes()) ?? "未記入";
    }

    const out = await ctx.step("proposals-v2", () => {
        const date = new Date().toISOString().slice(0, 10);
        const row = [date, n, prep.title, prep.implementerModel, prep.reviewerModel, rounds, verdict, minutes, note].map(csvEscape).join(",");
        const logPath = "docs/phase-log.csv";
        const header = "date,phase,task,implementer_model,reviewer_model,rounds,verdict,human_minutes,note";
        const cur = existsSync(path(logPath)) ? readText(logPath) : `${header}\n`;
        const logEol = cur.includes("\r\n") ? "\r\n" : "\n";
        const logDiff = unifiedDiff(logPath, `${cur.endsWith("\n") ? cur : `${cur}${logEol}`}${row}${logEol}`);

        let reportDiff = "(TEST_REPORT.md の更新案は、判定が PASS 系のときだけ出す)";
        if (review && existsSync(path("docs", "TEST_REPORT.md"))) {
            const reportText = readText("docs/TEST_REPORT.md");
            const reportEol = reportText.includes("\r\n") ? "\r\n" : "\n";
            const upd = reportRowUpdate(reportText, n, review.verdict, rounds);
            reportDiff = upd.note ? `(${upd.note})` : unifiedDiff("docs/TEST_REPORT.md", upd.lines.join(reportEol));
        }
        writeArtifact(`phase-${n}-phase-log.proposal.diff`, logDiff);
        writeArtifact(`phase-${n}-test-report.proposal.diff`, reportDiff);
        return { row, logDiff, reportDiff };
    });

    ctx.log(`記録案(適用はしない):\n${out.row}\nファイル: ${ART}/phase-${n}-phase-log.proposal.diff / phase-${n}-test-report.proposal.diff`);
    return { phase: n, verdict, rounds, humanMinutes: minutes, phaseLogRow: out.row, phaseLogDiff: out.logDiff, testReportDiff: out.reportDiff };
}

const phaseGate = defineWorkflow({
    meta: {
        name: "phase-gate",
        description:
            "HARNESS.md のフェーズを 1 つ回す(実装役 implementer → 審査役 reviewer、差し戻しは最大 3 周、人のチェックポイントあり、コミットしない)。" +
            "args: { phase: integer } — HARNESS.md のフェーズ番号(例 { phase: 1 })。" +
            "チェックポイントで paused になる。内容は e2e-artifacts/phase-N-checkpoint-<key>.md を見て、人の判断があれば e2e-artifacts/phase-N-human-note-<key>.md に書き、同じ run ID を resume する。",
        phases: [
            { title: "準備" }, { title: "実装依頼" }, { title: "審査" }, { title: "差し戻し判定" },
            { title: "締め" }, { title: "記録" },
        ],
        argsSchema: {
            type: "object",
            required: ["phase"],
            properties: { phase: { type: "integer" } },
        },
        limits: { maxTotalSubagents: 12, maxConcurrentSubagents: 1 },
    },
    run: async (ctx) => {
        const n = parsePhase(ctx.args);

        // 内容をファイルとログに出して止まり、再開後に人のメモを返す
        const checkpoint = async (key, title, body) => {
            const file = `phase-${n}-checkpoint-${key}.md`;
            const noteFile = `phase-${n}-human-note-${key}.md`;
            await ctx.step(`cp-write:${key}`, () => {
                writeArtifact(file, `# ${title}\n\n${body}\n\n---\n人の判断があれば ${ART}/${noteFile} に書き(任意)、同じ run ID を resume する。\n`);
                return true;
            });
            ctx.log(`[チェックポイント ${key}] ${title} — ${ART}/${file} を確認し、判断してから resume する。\n${body.slice(0, 1500)}`);
            await ctx.pause(`cp:${key}`);
            return ctx.step(`note:${key}`, () => (existsSync(path(ART, noteFile)) ? readText(`${ART}/${noteFile}`) : ""), { volatile: true });
        };

        ctx.phase("準備");
        const prep = await ctx.step("prepare-v2", () => prepare(n));
        ctx.log(`Phase ${n}: ${prep.title} 開始 ${prep.startedAt}`);
        const priorText = prep.prior ? `\n\n前フェーズの未解決・未検証項目(観点。証拠ではない):\n${prep.prior}` : "";
        const readDocs = prep.docs.join(" と ");

        let round = 0;
        let attempts = 0; // 実装の呼び出し回数。label を一意にする
        let notes = "";
        let fixItems = null;
        let previousFixItems = null;
        const history = [];
        let finalVerdict = null;
        let finalImpl = null;
        const reportFormat = "agent 定義の報告形式で、構造化出力(schema)として報告する。止めるべき状況なら stopped=true と stopReason を書く。";

        while (round < MAX_ROUNDS) {
            round++;
            attempts++;
            ctx.phase("実装依頼");

            const humanNote = notes ? `\n人の指示:\n${notes}\n` : "";
            const implPrompt = fixItems
                ? `${readDocs} を読み、Phase ${n} の差し戻し修正を行う。コミットしない。\n\nゲート条件:\n${prep.gates}${priorText}\n\n審査役の修正項目(再現手順付き。優先度順):\n${fixItems}\n${humanNote}\n${reportFormat}`
                : `${readDocs} を読み、Phase ${n} を実装する。コミットしない。\n\nフェーズ番号: ${n}\nゲート条件:\n${prep.gates}${priorText}\n${humanNote}\n${reportFormat}`;
            notes = "";

            let impl = null;
            let formatErr = null;
            for (let t = 0; t <= MAX_FORMAT_RETRIES; t++) {
                const prompt = t === 0 ? implPrompt
                    : `${implPrompt}\n\n前回の報告は形式不備(${formatErr})。作業ツリーの現状を確認し、再実装せずに定型報告を出し直す。`;
                impl = await ctx.agent(prompt, { agent: "implementer", schema: implSchema, label: `implementer:${attempts}:t${t}` });
                if (impl === null) break; // 失敗(上限・接続・枠切れなど)は null で返る。出し直しても同じなので止まる
                formatErr = checkImpl(impl);
                if (!formatErr) break;
            }
            if (impl === null) {
                notes = await checkpoint(`impl-null-${attempts}`, "実装役が結果を返さなかった(null)",
                    "サブエージェントの失敗(AI クレジットの枠切れ・上限・接続など)は null で返る。セッションのログで原因を確かめ、解消してから resume すると、同じフェーズの実装をもう一度依頼する。");
                round--; // 周回に数えない
                continue;
            }
            if (formatErr) {
                notes = await checkpoint(`impl-format-${attempts}`, `実装役の報告が形式不備のまま(${formatErr})`, `出し直し ${MAX_FORMAT_RETRIES} 回でも定型にならなかった。\n\n最後の出力:\n${formatImpl(impl)}`);
                round--; // 周回に数えない
                continue;
            }
            finalImpl = impl;
            ctx.log(`実装役の報告(r${round}):\n${formatImpl(impl)}`);

            if (impl.stopped) {
                notes = await checkpoint(`impl-stopped-${attempts}`, "実装役が「止めて報告」した", formatImpl(impl));
                round--; // 人の判断後の再依頼は周回に数えない(上限は審査の差し戻しの周回)
                continue;
            }

            // 審査前後の差分を比べる。違えば無効にして人に見せる
            let review = null;
            let valid = false;
            for (let attempt = 1; !valid; attempt++) {
                ctx.phase("審査");
                const tag = `${attempts}-a${attempt}`;
                const before = await ctx.step(`before-review-${tag}`, () => {
                    const s = snapshot();
                    writeArtifact(`phase-${n}-before-review-${tag}.diff`, s);
                    return s;
                });

                const reviewPrompt =
                    `HARNESS.md を読み、Phase ${n} を審査する。ファイルは書かない(${ART}/ への証拠保存のみ可)。\n\n` +
                    `フェーズ番号: ${n}\nゲート条件:\n${prep.gates}${priorText}\n\n` +
                    `実装役の未解決事項(観点):\n${impl.unresolved || "(なし)"}\n\n` +
                    `実装役の「外部 API の根拠」欄(自分で開いて確認する対象):\n${impl.externalApiEvidence}\n\n` +
                    (previousFixItems
                        ? `これは再審査。前回 FAIL にした次の項目は、前回の再現手順をそのまま再実行して閉じる(差分を読むだけで PASS にしない):\n${previousFixItems}\n\n`
                        : "") +
                    "実装役の報告の文章や docs/TEST_REPORT.md は証拠ではない。自分で測り直し、生出力を証拠にする。" +
                    "agent 定義の報告形式の全文を reportText に入れ、構造化出力(schema)で返す。";
                review = await ctx.agent(reviewPrompt, { agent: "reviewer", schema: reviewSchema, label: `reviewer:${tag}` });

                const after = await ctx.step(`after-review-${tag}`, () => {
                    const s = snapshot();
                    writeArtifact(`phase-${n}-after-review-${tag}.diff`, s);
                    return s;
                });

                if (!review) {
                    await checkpoint(`review-null-${tag}`, "審査役の判定が得られなかった(null)", "サブエージェントの失敗(AI クレジットの枠切れ・上限・接続など)は null で返る。原因を解消してから resume すると再審査する。");
                    continue;
                }
                if (before !== after) {
                    await checkpoint(
                        `diff-changed-${tag}`,
                        "審査の前後で作業ツリーが変わった(この VERDICT は無効)",
                        `${ART}/phase-${n}-before-review-${tag}.diff と after-review の差を確認する。\n無効にした判定(審査役の出力そのまま):\n${formatReview(review)}\n\nresume すると再審査する。`
                    );
                    continue;
                }
                if (review.verdict !== "FAIL" && HEDGE.test(`${review.reportText}\n${review.conditions}`)) {
                    await checkpoint(
                        `hedge-${tag}`,
                        "PASS の結果に推測の語(おそらく・たぶん・はず)が含まれる(PASS に数えない)",
                        `審査役の出力そのまま:\n${formatReview(review)}\n\nresume すると再審査する。`
                    );
                    continue;
                }
                valid = true;
            }

            history.push({ round, verdict: review.verdict, items: review.failItems.map((f) => f.item) });
            ctx.log(`審査役の判定(r${round}): ${review.verdict}`);

            if (review.verdict === "FAIL") {
                ctx.phase("差し戻し判定");
                if (!review.failItems.length) {
                    notes = await checkpoint(`fail-no-items-${attempts}`, "FAIL だが修正項目が空", formatReview(review));
                    history.pop();
                    round--;
                    continue;
                }
                fixItems = formatFix(review.failItems);
                previousFixItems = fixItems;
                continue;
            }

            finalVerdict = review;
            break;
        }

        // 上限到達(4 周目は始めない)
        if (!finalVerdict) {
            const trajectory = history.map((h) => `周 ${h.round}: ${h.verdict}\n${h.items.map((i) => `  - ${i}`).join("\n")}`).join("\n");
            await checkpoint("max-rounds", `${MAX_ROUNDS} 周で PASS しなかった(${MAX_ROUNDS + 1} 周目は始めない)`, `周回ごとの指摘の推移:\n${trajectory}\n\nフェーズ分割か要件の見直しを人が決める。`);
            return await record(ctx, n, prep, history.length, "上限到達", `指摘の推移: ${history.map((h) => `${h.round}:${h.items.length}件`).join(" ")}`, null, checkpoint);
        }

        ctx.phase("締め");
        const status = await ctx.step("closing-status", () => git(["status", "--porcelain"]));
        const changed = status.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, "").replace(/\\/g, "/"));
        const reported = new Set((finalImpl.changedFiles ?? []).map((f) => f.split(/\s+[—–]\s+|\s+-\s+/)[0].trim().replace(/^`|`$/g, "").replace(/\\/g, "/").replace(/^\.\//, "")));
        const unreported = changed.filter((f) => !f.endsWith("/") && !reported.has(f));
        const protectedTouched = changed.filter((f) => PROTECTED.some((re) => re.test(f)));
        const closing =
            `差分の一覧(git status --porcelain):\n${status || "(なし)"}\n\n` +
            `実装役の報告に無い変更ファイル(スコープ逸脱の候補。ディレクトリ単位の項目は人が確認):\n${unreported.join("\n") || "(なし)"}\n\n` +
            (PROTECTED.length ? `触ってはいけないファイルの変更:\n${protectedTouched.join("\n") || "(なし)"}\n\n` : "") +
            `審査結果(審査役の出力そのまま):\n${formatReview(finalVerdict)}\n\n` +
            "コミットはしない。TEST_REPORT.md の更新案と phase-log.csv の追記案は、resume 後に e2e-artifacts/ へ差分として出す。\n" +
            `人の介入時間(分)を ${ART}/phase-${n}-human-minutes.txt に数字だけで書いてから resume する。`;
        await checkpoint("closing", "PASS: 差分と審査結果の突き合わせ", closing);

        return await record(ctx, n, prep, history.length, finalVerdict.verdict, `未検証: ${(finalVerdict.unverified ?? []).join(" / ") || "なし"}。逸脱候補: ${unreported.length}件`, finalVerdict, checkpoint);
    },
});

await joinSession({ workflows: [phaseGate] });
