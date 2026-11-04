// install.ps1 を Windows PowerShell 5.1(install.bat が呼ぶもの)で、一時フォルダの配布先に対して通しで確かめる。
// 実行: リポジトリのルートで `npm test`。Windows 以外では飛ばす。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "install.ps1");
const skip = process.platform !== "win32";
const scratch = mkdtempSync(join(tmpdir(), "install-test-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// 出力はコンソールのコードページで出るので、UTF-8 に切り替えてから呼ぶ(install.bat の chcp 65001 と同じ状態)。
// 引数は単一引用符で包む(一時フォルダのパスと - で始まるスイッチだけを渡す)。
// スクリプトが例外で止まると $LASTEXITCODE が設定されないので、そのときは 1 で返す(install.bat の -File と同じ)。
function installWith(env, target, ...args) {
    const quoted = [script, target].map((a) => `'${a}'`).concat(args).join(" ");
    const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $global:LASTEXITCODE = 0; ` +
        `try { & ${quoted} } catch { Write-Output $_; exit 1 }; exit $LASTEXITCODE`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8", env });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const install = (target, ...args) => installWith(process.env, target, ...args);
function target({ gitignore = true } = {}) {
    const dir = mkdtempSync(join(scratch, "repo-"));
    if (gitignore) writeFileSync(join(dir, ".gitignore"), "node_modules/\ne2e-artifacts/\n");
    return dir;
}
const at = (dir, ...p) => join(dir, ...p);
const manifest = (dir) => JSON.parse(readFileSync(at(dir, ".github", "copilot-user-harness.json"), "utf8"));
const agent = (dir) => at(dir, ".github", "agents", "implementer.agent.md");
const extension = (dir) => at(dir, ".github", "extensions", "phase-gate", "extension.mjs");

test("初回: 部品と種を置き、管理ファイルを書く。ワークフローは既定では置かない", { skip }, () => {
    const dir = target();
    const r = install(dir);
    assert.equal(r.code, 0, r.out);
    for (const p of [
        [".github", "agents", "implementer.agent.md"], [".github", "agents", "reviewer.agent.md"],
        [".github", "skills", "phase-loop", "SKILL.md"], [".github", "skills", "phase-loop", "snapshot.ps1"],
        [".github", "prompts", "phase-loop.prompt.md"],
        ["HARNESS.md"], ["docs", "TEST_REPORT.md"], ["docs", "acceptance-checklist.md"],
    ]) assert.ok(existsSync(at(dir, ...p)), p.join("/"));
    assert.ok(!existsSync(extension(dir)));
    const m = manifest(dir);
    assert.equal(m.workflow, false);
    assert.ok(m.files[".github\\agents\\implementer.agent.md"]);
    assert.ok(!m.files["HARNESS.md"], "種は管理ファイルに載せない");
});

test("二度目: 変更が無ければ何もしない。-Check も差分なしで 0", { skip }, () => {
    const dir = target();
    install(dir);
    const harness = readFileSync(at(dir, "HARNESS.md"), "utf8");
    writeFileSync(at(dir, "HARNESS.md"), `${harness}\n育てた行\n`);
    const before = readFileSync(at(dir, ".github", "copilot-user-harness.json"), "utf8");
    const r = install(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /変更なし/);
    assert.match(readFileSync(at(dir, "HARNESS.md"), "utf8"), /育てた行/, "種は上書きしない");
    assert.equal(readFileSync(at(dir, ".github", "copilot-user-harness.json"), "utf8"), before, "管理ファイルを書き直さない(installedAt も変えない)");
    assert.equal(install(dir, "-Check").code, 0);
});

test("core.autocrlf=true の clone のように部品が CRLF になっていても、編集とは見なさない", { skip }, () => {
    const dir = target();
    install(dir);
    const parts = Object.keys(manifest(dir).files).map((k) => at(dir, ...k.split("\\")));
    for (const p of parts) writeFileSync(p, readFileSync(p, "utf8").replace(/\r?\n/g, "\r\n"));
    const r = install(dir, "-Check");
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /スキップ/);
    // CRLF でも中身を変えたら編集として扱う
    writeFileSync(agent(dir), `${readFileSync(agent(dir), "utf8")}手で足した\r\n`);
    const r2 = install(dir);
    assert.equal(r2.code, 2, r2.out);
    assert.match(r2.out, /スキップ\(配布後に編集されている.*implementer/);
});

test("配布後に編集した部品は上書きせず警告(2)。-Force なら上書きする", { skip }, () => {
    const dir = target();
    install(dir);
    writeFileSync(agent(dir), "手で直した\n");
    const r = install(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /スキップ\(配布後に編集されている/);
    assert.equal(readFileSync(agent(dir), "utf8"), "手で直した\n");
    assert.equal(install(dir, "-Force").code, 0);
    assert.notEqual(readFileSync(agent(dir), "utf8"), "手で直した\n");
});

test("-Check は何も書かず、配る物があれば 1", { skip }, () => {
    const dir = target();
    const r = install(dir, "-Check");
    assert.equal(r.code, 1, r.out);
    assert.ok(!existsSync(agent(dir)));
    assert.ok(!existsSync(at(dir, "HARNESS.md")));
});

test("-Workflow で入れたワークフローは、次に付け忘れても配り続ける", { skip }, () => {
    const dir = target();
    assert.equal(install(dir, "-Workflow").code, 0);
    assert.ok(existsSync(extension(dir)));
    assert.equal(manifest(dir).workflow, true);
    const r = install(dir);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(extension(dir)));
});

test("-Remove は置いた部品だけを消し、編集した部品と種は残す", { skip }, () => {
    const dir = target();
    install(dir, "-Workflow");
    writeFileSync(agent(dir), "手で直した\n");
    const r = install(dir, "-Remove");
    assert.equal(r.code, 2, r.out);
    assert.ok(existsSync(agent(dir)), "編集した部品は残す");
    assert.ok(!existsSync(at(dir, ".github", "agents", "reviewer.agent.md")));
    assert.ok(!existsSync(extension(dir)));
    assert.ok(!existsSync(at(dir, ".github", "copilot-user-harness.json")));
    assert.ok(existsSync(at(dir, "HARNESS.md")), "種は残す");
});

test(".gitignore に e2e-artifacts/ が無ければ警告する(書き換えはしない)", { skip }, () => {
    const dir = target({ gitignore: false });
    const r = install(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /e2e-artifacts\//);
    assert.ok(!existsSync(at(dir, ".gitignore")));
});

test("手で置かれた同名の部品は上書きしない", { skip }, () => {
    const dir = target();
    install(dir);
    install(dir, "-Remove");
    mkdirSync(dirname(agent(dir)), { recursive: true });
    writeFileSync(agent(dir), "前からあった\n");
    const r = install(dir);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /スキップ\(手で置かれたファイル/);
    assert.equal(readFileSync(agent(dir), "utf8"), "前からあった\n");
});

test("pwsh 7 から起動されて PSModulePath が 7 の Modules を指していても動く", { skip }, () => {
    // pwsh 7 は自分の Modules を PSModulePath の先頭に置いたまま子プロセスへ渡す。その状態を再現する
    const pwshModules = join(process.env.ProgramFiles ?? "", "PowerShell", "7", "Modules");
    const env = { ...process.env, PSModulePath: `${pwshModules};${process.env.PSModulePath ?? ""}` };
    const dir = target();
    const r = installWith(env, dir);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(agent(dir)));
});

test("管理ファイルのパスが配布先の外を指していたら、そのファイルを消さずに無視する", { skip }, () => {
    const dir = target();
    install(dir);
    const name = `outside-${Date.now()}.txt`;
    const outside = join(dirname(dir), name);
    writeFileSync(outside, "配布先の外\n");
    const m = manifest(dir);
    // ハッシュを本物に合わせ、「手で編集されている」で残る逃げ道を塞ぐ(install.ps1 と同じ大文字の 16 進)
    const h = createHash("sha256").update(readFileSync(outside)).digest("hex").toUpperCase();
    const bad = [`..\\${name}`, `.github\\..\\..\\${name}`, `.github/../../${name}`, outside, `.github\\"<>|${name}`];
    for (const k of bad) m.files[k] = h;
    writeFileSync(at(dir, ".github", "copilot-user-harness.json"), JSON.stringify(m));
    const r = install(dir, "-Remove");
    assert.equal(r.code, 2, r.out);
    assert.equal((r.out.match(/無視した\(管理ファイルのパスが/g) ?? []).length, bad.length, r.out);
    assert.ok(existsSync(outside), "配布先の外のファイルが残っている");
    assert.ok(!existsSync(agent(dir)), "配布先の中の部品は消えている");
    rmSync(outside);
});

test("配布先の .github や docs がジャンクションなら、たどって外を書き換えず、何もせずに 1", { skip }, () => {
    const outside = mkdtempSync(join(scratch, "outside-"));
    writeFileSync(join(outside, "大事.txt"), "外のファイル\n");
    for (const link of [".github", "docs"]) {
        const dir = target();
        const r0 = spawnSync("cmd.exe", ["/c", "mklink", "/J", at(dir, link), outside], { encoding: "utf8" });
        assert.equal(r0.status, 0, r0.stdout + r0.stderr);
        for (const args of [[], ["-Force"], ["-Remove", "-Force"]]) {
            const r = install(dir, ...args);
            assert.equal(r.code, 1, r.out);
            assert.match(r.out, /リンク/);
        }
        assert.deepEqual(readdirSync(outside), ["大事.txt"], `${link}: 外に何も足さず、何も消さない`);
    }
});

test("配布先の .github の奥にリンクがあっても、何もせずに 1", { skip }, () => {
    const outside = mkdtempSync(join(scratch, "outside-"));
    const dir = target();
    install(dir);
    mkdirSync(at(dir, ".github", "deep"));
    const r0 = spawnSync("cmd.exe", ["/c", "mklink", "/J", at(dir, ".github", "deep", "j"), outside], { encoding: "utf8" });
    assert.equal(r0.status, 0, r0.stdout + r0.stderr);
    const r = install(dir, "-Remove");
    assert.equal(r.code, 1, r.out);
    assert.ok(existsSync(agent(dir)), "部品を消していない");
    assert.ok(existsSync(outside));
});
