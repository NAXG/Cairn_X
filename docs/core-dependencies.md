# 核心依赖规则

本仓库没有 CI，分层靠本地脚本守护。`npm run check:deps`
（`cairn-x/scripts/check-deps.ts`）用 TypeScript Compiler API 解析
`cairn-x/src/` 与 `cairn-x/tests/` 的静态 import、`export ... from`、
`import type`、动态 `import()` 与 `require()`，构建模块图后执行下面的规则；
任何违规都会打印文件与行列并让命令失败。

## 规则

| 规则                 | 约束                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `contracts-boundary` | `src/contracts/**` 只能依赖 `src/contracts/**`。                                          |
| `shared-boundary`    | `src/shared/**` 只能依赖 `src/shared/**` 或 `src/contracts/**`。                          |
| `runtime-boundary`   | `src/worker/**` 与 `src/agents/runtime/**` 不得依赖 `src/server/**`、`src/scheduler/**`，含 type-only 引用。 |
| `web-boundary`       | `src/web/**` 只能依赖 `src/web/**`、`src/contracts/**`、`src/shared/**`。                    |
| `loop-import`        | 只有 CLI（`src/cli.ts` 与 `src/cli/**`）与测试可以按名 import `DispatcherLoop` / `DispatcherLoopOptions`；`scheduler/loop.ts` 不得再导出其它公共入口。 |
| `runtime-cycle`      | `src/` 的运行时 import 图必须无环（type-only 边不计入）。                                  |
| `unresolved-import`  | 相对 import 必须能解析（`css/svg/png` 等资源扩展名除外）。                                 |
| `web-browser-safe`   | 从 `src/web` 可达的模块（含 `shared`）不得 import Node 内置模块（`node:*` 或裸名），否则只有打包/运行时才会暴露。 |

`web-browser-safe` 靠可达性判断：未被前端引用的后端模块 import `node:*` 不会报。
它只检查 Node 内置模块，不检查 `@earendil-works/pi-*` 这类 Node-only 包。

## 与 knip / oxlint 的分工

- `check:deps`：谁能依赖谁、是否存在运行时循环、`loop` 公共入口是否被收窄。
- `oxlint`：correctness 类静态规则（见 `.oxlintrc.json`，已关掉在本仓库会产生误报的两条 `unicorn` 规则）。
- `knip`：没人引用的文件、依赖与导出（死代码），以及未声明/未使用的依赖。

三者都通过 `npm run check` 触发。

## 改动时的注意

- 把某个模块从一层挪到另一层时，先跑 `npm run check:deps`，让规则而不是构建产物告诉你越界。
- 新增跨层调用优先走 `contracts/`（协议类型）或 `shared/`（无运行时上层依赖的工具），不要反向 import。
- `scripts/check-deps.ts` 依赖 TypeScript 的 `typescript/unstable/sync` 与
  `typescript/unstable/ast`（当前钉在 `typescript@7.0.2`）。升级 TypeScript
  时必须同步验证该脚本仍可运行。
