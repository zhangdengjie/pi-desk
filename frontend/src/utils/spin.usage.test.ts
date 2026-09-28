import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 旋转一旦从 CSS 搬到指令，"忘了绑 v-spin" 就是静默故障：图标还在、只是不转，
// 组件测试（只看 class）抓不到。这里把契约钉在源码上。
//
// vitest 用 http 提供模块，import.meta.url 不是 file: URL；且套件可能从 frontend/ 或仓库根跑，
// 所以照 threadLabel.test.ts 的做法从 cwd 往上找。
function srcRoot(): string {
  let dir = process.cwd();
  for (let hop = 0; hop < 6; hop += 1) {
    if (existsSync(path.join(dir, "src", "components"))) return path.join(dir, "src");
    dir = path.dirname(dir);
  }
  throw new Error(`src/components not found from ${process.cwd()}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 开标签：属性值里允许出现 `>`（如 v-if="a > b"），所以按引号配对扫描。 */
const OPEN_TAG = /<[A-Za-z][\w-]*(?:"[^"]*"|'[^']*'|[^>])*?>/g;

describe("spinner rotation contract", () => {
  it("every is-spinning / thread-status tag binds v-spin", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const file of walk(path.join(srcRoot(), "components")).filter((name) => name.endsWith(".vue"))) {
      const source = readFileSync(file, "utf8");
      for (const needle of ["is-spinning", "thread-status"]) {
        for (const tag of (source.match(OPEN_TAG) ?? []).filter((item) => item.includes(needle))) {
          checked += 1;
          const label = `${path.relative(srcRoot(), file)}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`;
          if (!/\bv-spin\b/.test(tag)) {
            offenders.push(`MISSING v-spin  ${label}`);
          } else if (/:class\s*=\s*"[^"]*is-spinning/.test(tag) && !/\bv-spin="[^"]+"/.test(tag)) {
            // 动态 :class 上绑裸 v-spin = 不管加没加 is-spinning 都会一直转
            offenders.push(`NEEDS A VALUE  ${label}`);
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(40);
    expect(offenders).toEqual([]);
  });

  it("keeps the stylesheet free of a spin animation", () => {
    // CSS animation 会在 DOM 重新插入时从 0 重播（实测 .pi/bin/hitprobe/reorder-spin.html）
    for (const file of walk(path.join(srcRoot(), "styles")).filter((name) => name.endsWith(".css"))) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const name = path.relative(srcRoot(), file);
      expect(css, name).not.toMatch(/animation[^;]*\bsp\b/);
      expect(css, name).not.toMatch(/@keyframes\s+spin/);
    }
  });

  it("imports vSpin wherever the directive is used", () => {
    const missing = walk(path.join(srcRoot(), "components"))
      .filter((name) => name.endsWith(".vue"))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return /\sv-spin[\s=">]/.test(source) && !source.includes("import { vSpin }");
      })
      .map((file) => path.relative(srcRoot(), file));

    expect(missing).toEqual([]);
  });
});
