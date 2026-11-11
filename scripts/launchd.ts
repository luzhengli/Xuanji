// P1-16 部署：launchd 随登录拉起内核、接单程序、飞书通道（设计文档“部署”）。
//   node scripts/launchd.ts render [--work-root <目录>]    把 deploy/ 里的模板填好写到 data/launchd/，只看不装
//   node scripts/launchd.ts install [--work-root <目录>]   填好后装进 ~/Library/LaunchAgents 并启动（会改系统登录项，装前要人点头）
//   node scripts/launchd.ts uninstall                      停掉并移除
//   node scripts/launchd.ts status                         三个服务在不在跑
// launchd 下 PATH 只有系统目录，所以把 node、claude、lark-cli、git 所在的目录写进 PATH；接单程序名固定为 local。
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LABELS = ["com.xuanji.kernel", "com.xuanji.worker", "com.xuanji.feishu"] as const;
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const BINS = ["node", "claude", "lark-cli", "git"];

export interface RenderOptions { repo: string; node: string; path: string; workRoot: string; }

// 填模板：纯字符串替换，方便测试。
export function render(template: string, o: RenderOptions): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return template.replaceAll("__NODE__", esc(o.node)).replaceAll("__REPO__", esc(o.repo))
    .replaceAll("__PATH__", esc(o.path)).replaceAll("__WORK_ROOT__", esc(o.workRoot));
}

// 用当前 shell 里能找到的 node、claude、lark-cli、git 拼 PATH，再补上系统目录。
export function detect(): { node: string; path: string; missing: string[] } {
  const found: string[] = [], missing: string[] = [];
  for (const b of BINS) {
    try { found.push(execFileSync("/usr/bin/which", [b], { encoding: "utf8" }).trim()); } catch { missing.push(b); }
  }
  const dirs = [...new Set([...found.map((f) => dirname(f)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])];
  return { node: process.execPath, path: dirs.join(":"), missing };
}

function renderAll(workRoot: string): string[] {
  const d = detect();
  if (d.missing.length) throw new Error(`找不到 ${d.missing.join("、")}，先确认它们在 PATH 里`);
  if (!existsSync(workRoot)) throw new Error(`工作目录 ${workRoot} 不存在`);
  const out = join(REPO, "data", "launchd");
  mkdirSync(out, { recursive: true });
  mkdirSync(join(REPO, "data", "logs"), { recursive: true });
  return LABELS.map((label) => {
    const file = join(out, `${label}.plist`);
    writeFileSync(file, render(readFileSync(join(REPO, "deploy", `${label}.plist`), "utf8"), { repo: REPO, node: d.node, path: d.path, workRoot }));
    execFileSync("/usr/bin/plutil", ["-lint", file]);
    return file;
  });
}

const domain = () => `gui/${process.getuid!()}`;
const loaded = (label: string) => { try { execFileSync("/bin/launchctl", ["print", `${domain()}/${label}`], { stdio: "ignore" }); return true; } catch { return false; } };

function main(argv: string[]): void {
  const [cmd] = argv;
  const wi = argv.indexOf("--work-root");
  const workRoot = resolve(wi >= 0 ? argv[wi + 1]! : process.env.XJ_WORK_ROOT ?? process.cwd());
  switch (cmd) {
    case "render": {
      for (const f of renderAll(workRoot)) console.log(f);
      console.log(`工作目录 ${workRoot}。检查无误后用 install 安装。`);
      return;
    }
    case "install": {
      const files = renderAll(workRoot);
      mkdirSync(AGENTS_DIR, { recursive: true });
      for (const [i, label] of LABELS.entries()) {
        if (loaded(label)) execFileSync("/bin/launchctl", ["bootout", `${domain()}/${label}`]);
        const dest = join(AGENTS_DIR, `${label}.plist`);
        copyFileSync(files[i]!, dest);
        execFileSync("/bin/launchctl", ["bootstrap", domain(), dest]);
        console.log(`已装 ${label}`);
      }
      return;
    }
    case "uninstall": {
      for (const label of LABELS) {
        if (loaded(label)) execFileSync("/bin/launchctl", ["bootout", `${domain()}/${label}`]);
        const dest = join(AGENTS_DIR, `${label}.plist`);
        if (existsSync(dest)) unlinkSync(dest);
        console.log(`已移除 ${label}`);
      }
      return;
    }
    case "status": {
      for (const label of LABELS) {
        if (!loaded(label)) { console.log(`${label}：没装`); continue; }
        const info = execFileSync("/bin/launchctl", ["print", `${domain()}/${label}`], { encoding: "utf8" });
        const state = /\n\s*state = (.+)/.exec(info)?.[1] ?? "?";
        const pid = /\n\s*pid = (\d+)/.exec(info)?.[1];
        const exit = /\n\s*last exit code = (.+)/.exec(info)?.[1];
        console.log(`${label}：${state}${pid ? `，pid ${pid}` : ""}${exit ? `，上次退出 ${exit}` : ""}`);
      }
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 6).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main(process.argv.slice(2));
