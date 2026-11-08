#!/usr/bin/env python3
"""从 wails 生成的 TS 绑定 + Go 源码交叉生成 API 方法表（markdown）。

用法: python3 gen_api.py [仓库根]
"""
import os, re, sys

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
BDIR = os.path.join(ROOT, "frontend/bindings/pi-desk/internal/appservice")

# 绑定文件名 -> Go receiver 类型
SVC = {
    "agentservice.ts": "AgentService",
    "browserservice.ts": "BrowserService",
    "catalogservice.ts": "CatalogService",
    "desktopservice.ts": "DesktopService",
    "managedskillservice.ts": "ManagedSkillService",
    "mcpconfigservice.ts": "McpConfigService",
    "modelconfigservice.ts": "ModelConfigService",
    "orphansessionservice.ts": "OrphanSessionService",
    "piextensionservice.ts": "PiExtensionService",
    "pimaintenanceservice.ts": "PiMaintenanceService",
    "prompttemplateservice.ts": "PromptTemplateService",
    "remoteworkspaceservice.ts": "RemoteWorkspaceService",
    "repositoryservice.ts": "RepositoryService",
    "terminalservice.ts": "TerminalService",
    "taskservice.ts": "TaskService",
}

# 1) 扫描非 test 的 Go 文件，建 (Type, Method) -> (relpath, line)
pat = re.compile(r"^func \((?:\w+ )?\*?(\w+)\) (\w+)\(")
methods = {}
for dp, dns, fns in os.walk(ROOT):
    if "node_modules" in dp or dp.endswith(os.path.join("build", "remote-helper")):
        dns[:] = [d for d in dns if d != "node_modules"]
    for f in fns:
        if not f.endswith(".go") or f.endswith("_test.go"):
            continue
        path = os.path.join(dp, f)
        rel = os.path.relpath(path, ROOT)
        try:
            with open(path, encoding="utf-8") as fh:
                for i, line in enumerate(fh, 1):
                    m = pat.match(line)
                    if m:
                        methods.setdefault((m.group(1), m.group(2)), (rel, i))
        except OSError:
            pass

FN = re.compile(r"^export function (\w+)\((.*?)\): \$CancellablePromise<(.*?)> \{", re.M)
total = 0
for f in sorted(SVC):
    src = os.path.join(BDIR, f)
    if not os.path.exists(src):
        continue
    rows = FN.findall(open(src, encoding="utf-8").read())
    if not rows:
        continue
    svc = SVC[f]
    print(f"\n### {svc} — {len(rows)} 个方法\n")
    print(f"绑定：`frontend/bindings/pi-desk/internal/appservice/{f}`\n")
    print("| 方法 | 入参 | 返回 | Go 实现 |")
    print("|---|---|---|---|")
    for name, params, ret in rows:
        p = params.replace("domain$0.", "domain.")
        r = ret.replace("domain$0.", "domain.").replace("void", "—")
        loc = methods.get((svc, name))
        cell = f"`{loc[0]}:{loc[1]}`" if loc else "⚠️ 未定位"
        print(f"| `{name}` | {p or '—'} | {r} | {cell} |")
        total += 1
print(f"\n<!-- TOTAL_METHODS={total} -->")
