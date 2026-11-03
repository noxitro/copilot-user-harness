// phase-loop の snapshot.ps1 を Windows PowerShell 5.1 で、一時フォルダの試験用リポジトリに対して確かめる。
// 実行: リポジトリのルートで `npm test`。Windows 以外では飛ばす。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harnessDir = join(here, "..", "harness");
const script = join(harnessDir, ".github", "skills", "phase-loop", "snapshot.ps1");
const skip = process.platform !== "win32";
const scratch = mkdtempSync(join(tmpdir(), "snapshot-test-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=snapshot-test", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });

// 配布先と同じく、リポジトリのルートで -File で呼ぶ(コンソールのコードページは既定のまま)
function snap(cwd, stage, phase = 1) {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Phase", String(phase), "-Stage", stage], { cwd, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// .gitignore は置かない(e2e-artifacts/ が gitignore に無くても採取から外れることを確かめるため)
function makeRepo({ testDirs = "`tests/`" } = {}) {
    const repo = mkdtempSync(join(scratch, "repo-"));
    git(repo, "init", "-q");
    const harness = readFileSync(join(harnessDir, "HARNESS.md"), "utf8").replace("(テストディレクトリ: `{{tests/}}`)", `(テストディレクトリ: ${testDirs})`);
    writeFileSync(join(repo, "HARNESS.md"), harness);
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "tests", "a.test.js"), "assert(1 === 1);\n");
    writeFileSync(join(repo, "README.md"), "# 試験用\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    return repo;
}

test("変わっていなければ一致(0)。証拠の置き場への書き込みは数えない", { skip }, () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "# 試験用\n実装した\n");
    writeFileSync(join(repo, "新規.txt"), "足した\n");
    const b = snap(repo, "before");
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /追加以外の変更なし/);
    writeFileSync(join(repo, "e2e-artifacts", "phase-1-log.txt"), "審査役の証拠\n");
    const a = snap(repo, "after");
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /一致/);
});

test("審査中に未追跡のファイル(日本語の名前)の中身が変われば不一致(1)で、何が変わったかを出す", { skip }, () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "新規.txt"), "実装役が足した\n");
    assert.equal(snap(repo, "before").code, 0);
    writeFileSync(join(repo, "新規.txt"), "審査役が書き換えた\n");
    const a = snap(repo, "after");
    assert.equal(a.code, 1, a.out);
    assert.match(a.out, /不一致/);
    assert.match(a.out, /新規\.txt/, "日本語の名前を崩さない");
});

test("Shift_JIS の中身の書き換えも拾う(コンソールのコードページで崩さない)", { skip }, () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "sjis.txt"), Buffer.from([0x82, 0xa0, 0x0a])); // 「あ」
    git(repo, "add", "sjis.txt");
    git(repo, "commit", "-q", "-m", "sjis");
    writeFileSync(join(repo, "sjis.txt"), Buffer.from([0x82, 0xa2, 0x0a])); // 「い」
    assert.equal(snap(repo, "before").code, 0);
    writeFileSync(join(repo, "sjis.txt"), Buffer.from([0x82, 0xa4, 0x0a])); // 「う」
    assert.equal(snap(repo, "after").code, 1);
});

test("テストディレクトリの書き換え・削除・外への移動は 3 で知らせ、追加では知らせない", { skip }, () => {
    const repo = makeRepo({ testDirs: "`tests/`、`./spec`" });
    writeFileSync(join(repo, "tests", "b.test.js"), "assert(true);\n");
    const added = snap(repo, "before");
    assert.equal(added.code, 0, added.out);
    assert.match(added.out, /テストディレクトリ\(tests\/ spec\/\): 追加以外の変更なし/);

    writeFileSync(join(repo, "tests", "a.test.js"), "// assert(1 === 2);\n");
    const modified = snap(repo, "before");
    assert.equal(modified.code, 3, modified.out);
    assert.match(modified.out, / M tests\/a\.test\.js/);
    assert.doesNotMatch(modified.out, /b\.test\.js/);

    git(repo, "checkout", "--", "tests/a.test.js");
    git(repo, "mv", "tests/a.test.js", "old-a.test.js");
    const moved = snap(repo, "before");
    assert.equal(moved.code, 3, moved.out);
    assert.match(moved.out, /R {2}tests\/a\.test\.js -> old-a\.test\.js/);
});

test("HARNESS.md のテストディレクトリが {{ }} のままなら見ないと言う。審査前の採取が無ければ 2", { skip }, () => {
    const repo = makeRepo({ testDirs: "`{{tests/}}`" });
    writeFileSync(join(repo, "tests", "a.test.js"), "// 消した\n");
    const b = snap(repo, "before", 2);
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /書かれていないので、テストの変更は見ていない/);
    const a = snap(repo, "after", 3);
    assert.equal(a.code, 2, a.out);
    assert.match(a.out, /審査前の採取が無い/);
});
