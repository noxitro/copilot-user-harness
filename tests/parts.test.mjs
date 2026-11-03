// 部品どうしの食い違いを確かめる(AI クレジットを使わない)。
// 実行: リポジトリのルートで `npm test`。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const github = join(here, "..", "harness", ".github");
const skill = readFileSync(join(github, "skills", "phase-loop", "SKILL.md"), "utf8");
const prompt = readFileSync(join(github, "prompts", "phase-loop.prompt.md"), "utf8");

// 違ってよいのは frontmatter・先頭のコメント・フェーズ番号の受け取り方(最初の段落)だけ。そこから後は同じ
const START = "あなたはオーケストレータです。";
const body = (text) => {
    const i = text.indexOf(START);
    assert.ok(i >= 0, `「${START}」が無い`);
    return text.slice(i).replace(/\r\n/g, "\n");
};

test("phase-loop のスキルとプロンプトは、フェーズ番号の受け取り方より後の本文が同じ", () => {
    const a = body(skill).split("\n");
    const b = body(prompt).split("\n");
    const at = a.findIndex((l, k) => l !== b[k]);
    assert.equal(at < 0 && a.length === b.length, true,
        `${at + 1} 行目(「${START}」から数えて)で食い違う:\nSKILL.md : ${a[at] ?? "(終わり)"}\nprompt.md: ${b[at] ?? "(終わり)"}`);
});

test("phase-loop の本文が呼ぶスクリプトが、配る部品の中にある", () => {
    for (const m of body(skill).matchAll(/\.github\/([\w./-]+\.ps1)/g)) {
        assert.ok(existsSync(join(github, ...m[1].split("/"))), `.github/${m[1]} が harness/.github に無い`);
    }
    assert.match(body(skill), /snapshot\.ps1/);
});
