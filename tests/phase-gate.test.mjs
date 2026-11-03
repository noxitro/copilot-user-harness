// phase-gate の段取りを、偽の実行環境で通しで確かめる(AI クレジットを使わない)。
// 実行: リポジトリのルートで `npm test`。雛形は harness/ から読む。
// 偽の実行環境は SDK の文書の決まりに合わせる: step は記録して再生する(volatile は毎回実行)、
// agent は同じ呼び出しを 1 回にまとめ、失敗は null で返す、pause は初回に止まり、再開すると同じ所から返る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harnessDir = join(here, "..", "harness");
const scratch = mkdtempSync(join(tmpdir(), "phase-gate-test-"));

// SDK の代わり: defineWorkflow は定義をそのまま返し、joinSession は登録されたワークフローを受け取る
const mod = join(scratch, "module");
const sdk = join(mod, "node_modules", "@github", "copilot-sdk");
mkdirSync(sdk, { recursive: true });
writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@github/copilot-sdk", type: "module", exports: { "./extension": "./extension.mjs" } }));
writeFileSync(join(sdk, "extension.mjs"),
    "export const defineWorkflow = (d) => d;\nexport async function joinSession(o) { globalThis.__phaseGate = o.workflows[0]; return {}; }\n");
cpSync(join(harnessDir, ".github", "extensions", "phase-gate", "extension.mjs"), join(mod, "extension.mjs"));
await import(pathToFileURL(join(mod, "extension.mjs")).href);
const workflow = globalThis.__phaseGate;

test.after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd, ...args) {
    return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=phase-gate-test", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
}

// 雛形から試験用のリポジトリを作る
function makeRepo({ crlfReport = false, goal = false, reviewerModel = null, gitignore = true, testDir = false } = {}) {
    const repo = mkdtempSync(join(scratch, "repo-"));
    git(repo, "init", "-q");
    let harness = readFileSync(join(harnessDir, "HARNESS.md"), "utf8");
    if (testDir) {
        harness = harness.replace("(テストディレクトリ: `{{tests/}}`)", "(テストディレクトリ: `tests/`、`./spec`)");
        assert.ok(harness.includes("テストディレクトリ: `tests/`"), "雛形の「環境」節の書き方が変わった");
        mkdirSync(join(repo, "tests"));
        writeFileSync(join(repo, "tests", "a.test.js"), "assert(1 === 1);\n");
    }
    writeFileSync(join(repo, "HARNESS.md"), harness);
    mkdirSync(join(repo, "docs"));
    let report = readFileSync(join(harnessDir, "docs", "TEST_REPORT.md"), "utf8").replace(/\r\n/g, "\n");
    if (crlfReport) report = report.replace(/\n/g, "\r\n");
    writeFileSync(join(repo, "docs", "TEST_REPORT.md"), report);
    mkdirSync(join(repo, ".github", "agents"), { recursive: true });
    cpSync(join(harnessDir, ".github", "agents", "implementer.agent.md"), join(repo, ".github", "agents", "implementer.agent.md"));
    let reviewer = readFileSync(join(harnessDir, ".github", "agents", "reviewer.agent.md"), "utf8");
    if (reviewerModel) reviewer = reviewer.replace(/^# model:.*$/m, `model: ${reviewerModel}`);
    writeFileSync(join(repo, ".github", "agents", "reviewer.agent.md"), reviewer);
    if (goal) writeFileSync(join(repo, "GOAL.md"), "# ゴール\n\n試験用。\n");
    writeFileSync(join(repo, "README.md"), "# 試験用\n");
    if (gitignore) writeFileSync(join(repo, ".gitignore"), "e2e-artifacts/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    return repo;
}

const implOk = (extra = {}) => ({
    stopped: false, stopReason: "", changedFiles: ["README.md — 1 行足した"], testCodeChanges: "なし",
    externalApiEvidence: "外部 API は使っていない", buildTest: "ビルド対象なし(生出力: 省略)", selfVerification: "README.md を開いて確認した",
    unresolved: "", ...extra,
});
const review = (verdict, extra = {}) => ({
    verdict, conditions: "", failItems: [], unverified: [], reportText: `VERDICT: ${verdict}。自分で開いて確かめた。`, ...extra,
});
const fail = (item) => review("FAIL", { failItems: [{ priority: 1, item, reproduction: `type README.md で ${item} を確かめる` }] });

// 偽の実行環境で、止まるたびに onPause(key, repo) を呼んで再開する
async function drive(repo, args, responders, onPause = () => {}) {
    const journal = new Map();
    const passed = new Set();
    const calls = [];
    const pauses = [];
    const ctx = () => ({
        runId: "test-run", args, signal: undefined,
        phase: () => {}, log: () => {},
        step: async (key, fn, opts = {}) => {
            if (!opts.volatile && journal.has(`s:${key}`)) return structuredClone(journal.get(`s:${key}`));
            const v = await fn();
            if (!opts.volatile) {
                assert.notEqual(v, undefined, `step ${key} が undefined を返した(記録できない)`);
                journal.set(`s:${key}`, JSON.parse(JSON.stringify(v)));
            }
            return v;
        },
        agent: async (prompt, opts = {}) => {
            const key = `a:${JSON.stringify([prompt, opts])}`;
            if (journal.has(key)) return structuredClone(journal.get(key));
            calls.push({ agent: opts.agent, label: opts.label, prompt });
            const v = (await responders[opts.agent]({ prompt, opts, repo, calls })) ?? null;
            journal.set(key, v);
            return structuredClone(v);
        },
        pause: async (key) => {
            if (passed.has(key)) return;
            passed.add(key);
            pauses.push(key);
            const e = new Error(`paused: ${key}`);
            e.name = "AbortError";
            e.key = key;
            throw e;
        },
    });
    const cwd = process.cwd();
    process.chdir(repo);
    try {
        for (let attempt = 0; attempt < 40; attempt++) {
            try {
                const result = await workflow.run(ctx());
                return { result, calls, pauses };
            } catch (e) {
                if (e.name !== "AbortError") throw e;
                await onPause(e.key, repo);
            }
        }
        throw new Error(`止まりすぎ: ${pauses.join(", ")}`);
    } finally {
        process.chdir(cwd);
    }
}

const art = (repo, name) => join(repo, "e2e-artifacts", name);
const writeMinutes = (n, v = "5") => (key, repo) => {
    if (key === "cp:closing" || key === "cp:max-rounds") writeFileSync(art(repo, `phase-${n}-human-minutes.txt`), v);
};
const appendReadme = (repo, text) => writeFileSync(join(repo, "README.md"), `${readFileSync(join(repo, "README.md"), "utf8")}${text}\n`);

test("雛形の見出しと結果マトリクスの列を読める", () => {
    const harness = readFileSync(join(harnessDir, "HARNESS.md"), "utf8");
    assert.match(harness, /^### Phase 0[::]/m);
    assert.match(harness, /^### Phase 1[::]/m);
    const report = readFileSync(join(harnessDir, "docs", "TEST_REPORT.md"), "utf8");
    const head = report.split(/\r?\n/).find((l) => /^\|\s*フェーズ\s*\|/.test(l));
    assert.ok(head, "結果マトリクスの見出しがある");
    for (const name of ["環境 A", "レビュー周回数", "審査前後の差分一致"]) assert.ok(head.includes(name), `列「${name}」がある`);
    assert.match(report, /^## 未検証項目と理由/m);
});

test("1 周目で PASS: 締めで止まり、介入時間を書いて再開すると記録案を出す", async () => {
    const repo = makeRepo({ reviewerModel: "model-b" });
    const { result, calls, pauses } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "追加した行"); return implOk(); },
        reviewer: () => review("PASS"),
    }, writeMinutes(1, "7"));
    assert.equal(result.verdict, "PASS");
    assert.equal(result.rounds, 1);
    assert.equal(result.humanMinutes, "7");
    assert.deepEqual(pauses, ["cp:closing"]);
    assert.deepEqual(calls.map((c) => c.agent), ["implementer", "reviewer"]);
    assert.doesNotMatch(calls[0].prompt, /GOAL\.md/, "GOAL.md が無ければ読ませない");
    // 記録案: モデルは定義から(実装役は model を書いていないので本体と同じ)
    assert.match(result.phaseLogRow, /,\(本体と同じ\),model-b,1,PASS,7,/);
    // TEST_REPORT.md の更新案は Phase 1 の行だけを変え、列の数を変えない
    const plus = result.testReportDiff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const minus = result.testReportDiff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    assert.equal(plus.length, 1);
    assert.equal(minus.length, 1);
    const cells = (l) => l.slice(1).split("|").slice(1, -1).map((c) => c.trim());
    assert.equal(cells(plus[0]).length, cells(minus[0]).length);
    assert.equal(cells(plus[0])[0], "1");
    assert.ok(cells(plus[0]).includes("✅"));
    assert.ok(cells(plus[0]).includes("一致"));
    // 作業ツリーはコミットされていない
    assert.match(git(repo, "status", "--porcelain"), /README\.md/);
    assert.equal(git(repo, "rev-list", "--count", "HEAD").trim(), "1");
});

test("FAIL で差し戻し、再審査では前回の再現手順を渡し、2 周目で PASS", async () => {
    const repo = makeRepo();
    let reviews = 0;
    const { result, calls } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: () => (++reviews === 1 ? fail("見出しが無い") : review("PASS")),
    }, writeMinutes(1));
    assert.equal(result.verdict, "PASS");
    assert.equal(result.rounds, 2);
    const impl2 = calls.filter((c) => c.agent === "implementer")[1];
    assert.match(impl2.prompt, /差し戻し修正/);
    assert.match(impl2.prompt, /見出しが無い/);
    const rev2 = calls.filter((c) => c.agent === "reviewer")[1];
    assert.match(rev2.prompt, /これは再審査/);
    assert.match(rev2.prompt, /見出しが無い/);
});

test("3 周で PASS しなければ止まり、4 周目を始めない", async () => {
    const repo = makeRepo();
    const { result, calls, pauses } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: ({ calls }) => fail(`指摘 ${calls.length}`),
    }, writeMinutes(1));
    assert.equal(result.verdict, "上限到達");
    assert.equal(result.rounds, 3);
    assert.equal(calls.filter((c) => c.agent === "implementer").length, 3);
    assert.equal(calls.filter((c) => c.agent === "reviewer").length, 3);
    assert.ok(pauses.includes("cp:max-rounds"));
    assert.match(result.testReportDiff, /PASS 系のときだけ/);
});

test("実装役の「止めて報告」で止まり、人の判断を次の依頼に渡す(周回に数えない)", async () => {
    const repo = makeRepo();
    let impls = 0;
    const { result, calls, pauses } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => {
            if (++impls === 1) return implOk({ stopped: true, stopReason: "既存の挙動を変える必要がある" });
            appendReadme(repo, "行");
            return implOk();
        },
        reviewer: () => review("PASS"),
    }, (key, repo) => {
        if (key === "cp:impl-stopped-1") writeFileSync(art(repo, "phase-1-human-note-impl-stopped-1.md"), "変えてよい。理由を報告に書く");
        writeMinutes(1)(key, repo);
    });
    assert.ok(pauses.includes("cp:impl-stopped-1"));
    assert.match(calls.filter((c) => c.agent === "implementer")[1].prompt, /人の指示:\n変えてよい/);
    assert.equal(result.rounds, 1);
});

test("実装役が null(枠切れなど)なら出し直さずに止まり、再開で依頼し直す", async () => {
    const repo = makeRepo();
    let impls = 0;
    const { result, calls, pauses } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => {
            if (++impls === 1) return null;
            appendReadme(repo, "行");
            return implOk();
        },
        reviewer: () => review("PASS"),
    }, writeMinutes(1));
    assert.equal(pauses[0], "cp:impl-null-1");
    assert.deepEqual(calls.map((c) => c.label), ["implementer:1:t0", "implementer:2:t0", "reviewer:2-a1"]);
    assert.equal(result.verdict, "PASS");
});

test("報告が定型にならなければ 2 回まで出し直し、それでもだめなら止まる", async () => {
    const repo = makeRepo();
    let impls = 0;
    const { pauses, calls } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => {
            if (++impls <= 3) return implOk({ buildTest: "" });
            appendReadme(repo, "行");
            return implOk();
        },
        reviewer: () => review("PASS"),
    }, writeMinutes(1));
    assert.equal(pauses[0], "cp:impl-format-1");
    assert.deepEqual(calls.slice(0, 3).map((c) => c.label), ["implementer:1:t0", "implementer:1:t1", "implementer:1:t2"]);
    assert.match(calls[1].prompt, /形式不備\(空の欄: buildTest\)/);
});

test("審査の前後で作業ツリーが変わったら、その判定を無効にして再審査する", async () => {
    const repo = makeRepo();
    let reviews = 0;
    const { pauses, calls, result } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: ({ repo }) => {
            if (++reviews === 1) writeFileSync(join(repo, "stray.txt"), "審査役が書いた");
            return review("PASS");
        },
    }, (key, repo) => {
        if (key === "cp:diff-changed-1-a1") rmSync(join(repo, "stray.txt"));
        writeMinutes(1)(key, repo);
    });
    assert.ok(pauses.includes("cp:diff-changed-1-a1"));
    assert.match(readFileSync(art(repo, "phase-1-checkpoint-diff-changed-1-a1.md"), "utf8"), /stray\.txt/, "何が変わったかを見せる");
    assert.equal(calls.filter((c) => c.agent === "reviewer").length, 2);
    assert.equal(result.verdict, "PASS");
});

test("実装役が足した未追跡のファイルを審査役が書き換えても、その判定を無効にする", async () => {
    const repo = makeRepo();
    let reviews = 0;
    const { pauses, calls, result } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { writeFileSync(join(repo, "added.txt"), "実装役が足した\n"); return implOk(); },
        reviewer: ({ repo }) => {
            if (++reviews === 1) writeFileSync(join(repo, "added.txt"), "審査役が書き換えた\n");
            return review("PASS");
        },
    }, (key, repo) => {
        if (key === "cp:diff-changed-1-a1") writeFileSync(join(repo, "added.txt"), "実装役が足した\n");
        writeMinutes(1)(key, repo);
    });
    assert.ok(pauses.includes("cp:diff-changed-1-a1"));
    assert.equal(calls.filter((c) => c.agent === "reviewer").length, 2);
    assert.equal(result.verdict, "PASS");
});

test("推測の語(はず)を含む PASS は数えず再審査する。「はずれ」には反応しない", async () => {
    const repo = makeRepo();
    let reviews = 0;
    const { pauses, result } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: () => (++reviews === 1
            ? review("PASS", { reportText: "陽性コントロールでも検出できるはずです" })
            : review("PASS", { reportText: "範囲のはずれ値も自分で測って確かめた" })),
    }, writeMinutes(1));
    assert.deepEqual(pauses, ["cp:hedge-1-a1", "cp:closing"]);
    assert.equal(result.verdict, "PASS");
});

test("推測の語は審査役自身の文章だけで見る(コードブロックと `…` の中は見ない)", async () => {
    const repo = makeRepo();
    const { pauses, result, calls } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: () => review("PASS", { reportText: "テストの生出力:\n```\n✔ 0 件ならヘッダだけになるはず\n```\n`はず` を含むテスト名も自分で実行した" }),
    }, writeMinutes(1));
    assert.deepEqual(pauses, ["cp:closing"]);
    assert.equal(result.verdict, "PASS");
    assert.match(calls[1].prompt, /生出力はコードブロック/);
});

test("推測の語のチェックポイントで人が「採用」と書けば、再審査せずにその判定を数え、備考に残す", async () => {
    const repo = makeRepo();
    const { pauses, result, calls } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: () => review("PASS", { reportText: "陽性コントロールでも検出できるはずです" }),
    }, (key, repo) => {
        if (key === "cp:hedge-1-a1") writeFileSync(art(repo, "phase-1-human-note-hedge-1-a1.md"), "\n採用。固有の語なので推測ではない\n");
        writeMinutes(1)(key, repo);
    });
    assert.deepEqual(pauses, ["cp:hedge-1-a1", "cp:closing"]);
    assert.equal(calls.filter((c) => c.agent === "reviewer").length, 1, "採用したら再審査しない");
    assert.equal(result.verdict, "PASS");
    assert.match(result.phaseLogRow, /推測の語を含む PASS を人が採用\(1-a1\)/);
});

test(".gitignore に e2e-artifacts/ が無くても、証拠の置き場への書き込みで判定を無効にしない", async () => {
    const repo = makeRepo({ gitignore: false });
    const { pauses, result } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: ({ repo }) => {
            mkdirSync(join(repo, "e2e-artifacts"), { recursive: true });
            writeFileSync(art(repo, "phase-1-log.txt"), "証拠");
            return review("PASS");
        },
    }, writeMinutes(1));
    assert.deepEqual(pauses, ["cp:closing"]);
    assert.equal(result.verdict, "PASS");
    const lists = readFileSync(art(repo, "phase-1-checkpoint-closing.md"), "utf8").split("審査結果(")[0];
    assert.doesNotMatch(lists, /\be2e-artifacts\/(?!\s*は除く)/, "締めの照合にも出さない");
});

test("締めの照合: 日本語の名前を崩さず、新しいフォルダの中も 1 件ずつ見る", async () => {
    const repo = makeRepo();
    const { result } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => {
            writeFileSync(join(repo, "メモ.txt"), "報告した\n");
            mkdirSync(join(repo, "新しい"));
            writeFileSync(join(repo, "新しい", "a.txt"), "報告した\n");
            writeFileSync(join(repo, "新しい", "b.txt"), "報告していない\n");
            return implOk({ changedFiles: ["メモ.txt — 足した", "`新しい/a.txt` — 足した"] });
        },
        reviewer: () => review("PASS"),
    }, writeMinutes(1));
    const closing = readFileSync(art(repo, "phase-1-checkpoint-closing.md"), "utf8");
    const unreported = closing.split("実装役の報告に無い変更ファイル")[1].split("\n\n")[0];
    assert.match(unreported, /新しい\/b\.txt/);
    assert.doesNotMatch(unreported, /メモ\.txt|新しい\/a\.txt|新しい\/$/m);
    assert.match(result.phaseLogRow, /逸脱候補: 1件/);
});

test("Phase 0 を受け付け、GOAL.md があれば読ませ、CRLF の TEST_REPORT.md でも 1 行だけ変える", async () => {
    const repo = makeRepo({ goal: true, crlfReport: true });
    const { result, calls } = await drive(repo, { phase: 0 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: () => review("PASS(条件付き)", { conditions: "環境 B は未確認" }),
    }, writeMinutes(0));
    assert.match(calls[0].prompt, /^HARNESS\.md と GOAL\.md を読み、Phase 0 を実装する/);
    const changed = result.testReportDiff.split("\n").filter((l) => /^[+-][^+-]/.test(l));
    assert.equal(changed.length, 2);
    assert.match(changed[1], /^\+\| 0 \|/);
    assert.ok(changed[1].includes("⚠"));
});

test("フェーズ番号が不正なら始めない", async () => {
    const repo = makeRepo();
    for (const phase of [-1, "abc", 1.5]) {
        await assert.rejects(drive(repo, { phase }, { implementer: () => implOk(), reviewer: () => review("PASS") }), /フェーズ番号/);
    }
    await assert.rejects(drive(repo, { phase: 99 }, { implementer: () => implOk(), reviewer: () => review("PASS") }), /Phase 99 の節/);
    assert.equal(existsSync(art(repo, "phase-99-checkpoint-closing.md")), false);
});

const testFile = (repo) => join(repo, "tests", "a.test.js");

test("テストディレクトリの書き換えは、審査の前に止め、人が承認しなければ実装役に戻させる(1 周に数える)", async () => {
    const repo = makeRepo({ testDir: true });
    let impls = 0;
    const { result, calls, pauses } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => {
            if (++impls === 1) writeFileSync(testFile(repo), "// assert(1 === 2);\n");
            else git(repo, "checkout", "--", "tests/a.test.js");
            appendReadme(repo, "行");
            return implOk();
        },
        reviewer: () => review("PASS"),
    }, writeMinutes(1));
    assert.deepEqual(pauses, ["cp:test-changed-1", "cp:closing"]);
    const cp = readFileSync(art(repo, "phase-1-checkpoint-test-changed-1.md"), "utf8");
    assert.match(cp, /M tests\/a\.test\.js/);
    assert.match(cp, /-assert\(1 === 1\);/, "差分を見せる");
    assert.match(cp, /tests\/ spec\//, "HARNESS.md の複数のテストディレクトリを読む");
    assert.deepEqual(calls.map((c) => c.agent), ["implementer", "implementer", "reviewer"], "審査役は書き換えた版を審査しない");
    assert.match(calls[1].prompt, /差し戻し修正[\s\S]*追加以外の変更を戻す:  M tests\/a\.test\.js/);
    assert.equal(result.rounds, 2);
    assert.equal(result.verdict, "PASS");
});

test("テストディレクトリの書き換えを人が「採用」すれば審査に進み、審査役に承認済みと伝え、締めと記録に残す", async () => {
    const repo = makeRepo({ testDir: true });
    const { result, calls, pauses } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { writeFileSync(testFile(repo), "assert(1 === 1, '理由を足した');\n"); return implOk({ changedFiles: ["tests/a.test.js"] }); },
        reviewer: () => review("PASS"),
    }, (key, repo) => {
        if (key === "cp:test-changed-1") writeFileSync(art(repo, "phase-1-human-note-test-changed-1.md"), "採用。承認記録に足した\n");
        writeMinutes(1)(key, repo);
    });
    assert.deepEqual(pauses, ["cp:test-changed-1", "cp:closing"]);
    assert.match(calls[1].prompt, /人がチェックポイント test-changed-1 で承認した[\s\S]*M tests\/a\.test\.js/);
    assert.match(readFileSync(art(repo, "phase-1-checkpoint-closing.md"), "utf8"), /追加以外の変更:\n M tests\/a\.test\.js/);
    assert.equal(result.rounds, 1);
    assert.match(result.phaseLogRow, /テストの変更を人が承認\(1\)/);
});

test("テストの追加では止めない。テストディレクトリの外へ移したら拾う", async () => {
    const repo = makeRepo({ testDir: true });
    const added = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { writeFileSync(join(repo, "tests", "b.test.js"), "assert(true);\n"); return implOk({ changedFiles: ["tests/b.test.js"] }); },
        reviewer: () => review("PASS"),
    }, writeMinutes(1));
    assert.deepEqual(added.pauses, ["cp:closing"]);

    const repo2 = makeRepo({ testDir: true });
    const moved = await drive(repo2, { phase: 1 }, {
        implementer: ({ repo }) => { git(repo, "mv", "tests/a.test.js", "old-a.test.js"); return implOk(); },
        reviewer: () => review("PASS"),
    }, (key, repo) => {
        if (key === "cp:test-changed-1") writeFileSync(art(repo, "phase-1-human-note-test-changed-1.md"), "採用\n");
        writeMinutes(1)(key, repo);
    });
    assert.equal(moved.pauses[0], "cp:test-changed-1");
    assert.match(readFileSync(art(repo2, "phase-1-checkpoint-test-changed-1.md"), "utf8"), /R {2}tests\/a\.test\.js -> old-a\.test\.js/);
});

test("サブエージェントの上限に届く前に止め、記録案を出して終わる(上限を超えて呼ばない)", async () => {
    const repo = makeRepo();
    const { result, calls, pauses } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => { appendReadme(repo, "行"); return implOk(); },
        reviewer: () => null,
    }, writeMinutes(1));
    assert.equal(calls.length, 12);
    assert.equal(pauses.filter((k) => k.startsWith("cp:review-null-")).length, 11);
    assert.ok(pauses.includes("cp:subagent-limit"));
    assert.equal(result.verdict, "中断(サブエージェント上限)");
    assert.match(result.phaseLogRow, /中断\(サブエージェント上限\)/);
});

test("入れ子のリポジトリ(未追跡の git init 済みフォルダ)の中を審査役が書き換えても、その判定を無効にする", async () => {
    const repo = makeRepo();
    let reviews = 0;
    const { pauses, calls, result } = await drive(repo, { phase: 1 }, {
        implementer: ({ repo }) => {
            mkdirSync(join(repo, "sub"));
            git(join(repo, "sub"), "init", "-q");
            writeFileSync(join(repo, "sub", "f.txt"), "実装役が足した\n");
            return implOk({ changedFiles: ["sub/"] });
        },
        reviewer: ({ repo }) => {
            if (++reviews === 1) writeFileSync(join(repo, "sub", "f.txt"), "審査役が書き換えた\n");
            return review("PASS");
        },
    }, (key, repo) => {
        if (key === "cp:diff-changed-1-a1") writeFileSync(join(repo, "sub", "f.txt"), "実装役が足した\n");
        writeMinutes(1)(key, repo);
    });
    assert.ok(pauses.includes("cp:diff-changed-1-a1"));
    assert.match(readFileSync(art(repo, "phase-1-checkpoint-diff-changed-1-a1.md"), "utf8"), /sub\/f\.txt/);
    assert.equal(calls.filter((c) => c.agent === "reviewer").length, 2);
    assert.equal(result.verdict, "PASS");
});
