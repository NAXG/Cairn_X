# Cairn 工作台

React + TypeScript + Vite 前端，生产环境由现有 Hono 服务同源提供。

## 开发与生产

在 `cairn-x/` 中运行：

```sh
npm ci
npm run build:web
# 按项目 README 配置凭据和 dispatch.yaml，然后启动现有服务
npm run cli -- serve --config dispatch.yaml
```

访问服务根路径。`dist-web/` 为生成目录，不提交；缺少构建时返回明确的 503 提示。Dockerfile 使用独立前端构建阶段，无须在运行期启动 Vite。机器接口 URL 和 Cookie 认证保持不变。

开发热更新：先启动端口 8000 的服务，再运行 `npm run dev:web`，访问 Vite 输出地址。Vite 将 `/projects`、`/settings`、`/login` 和 `/logout` 代理至 Hono。未登录时自动跳转 Vite 的 `/auth` 代理登录页；登录后返回热更新界面。

## 功能组织

- `App.tsx`：URL hash 导航、工作台布局、项目搜索、项目状态与视图组合。侧栏底部是 pi-web 风格的 dock（模型 / 技能 / 设置），右侧分隔符后是退出；dock 直接打开设置并定位到对应分区。概览用一条运行状态指标带加四项计数，起点／目标、规划、时间线、补充提示各自成块；执行记录在页内渲染完整轨迹，原始 HTML 导出降为执行头部的次要按钮。
- `features/graph`：纯图元素构建、增量同步、Cytoscape 生命周期与回放。轮询保留节点位置与视角；回放固定数据快照。缺少精确时间的历史状态仅作近似显示。
- `features/traces`：结构化消息、显式工具 ID 关联、Markdown、按需读取大消息。原始 HTML 不执行。
- `features/projects`：创建／上传重试。
- `features/settings`：设置中心（pi-web 布局：顶部分区 + 图标 + 左列表右详情），分区为 常规 / 模型 / 技能 / 子代理 / 插件 / 运行。常规页是四套以上主题的外观网格与轨迹宽度、字号滑块；模型页管理供应商（自定义端点 / API Key / 订阅账号 OAuth 登录）与模型目录（发现、测试），添加供应商是按图标与模型数分组的卡片网格；技能页只读展示当前插件版本里各 SKILL.md 的名称与描述；子代理页沿用 Dispatcher / Execute 配置（模型、提示词、工具集，窗口与时限收进折叠区）；插件页按角色分栏并展开包含的包，失败只留下操作与状态行，堆栈收进「查看原始输出」折叠区，不在页面上直接展示；运行页调整并发、规划间隔与 Worker 资源，服务端接口见 `src/control/routes.ts` 与 `src/server/modules/skills.ts`。
- `icons.tsx` / `features/settings/ProviderIcon.tsx`：设置分区图标与供应商图标，形状取自 pi-web（供应商 sprite 打包在 `src/web/public/provider-icons.svg`），未收录的供应商退回首字母色块。
- `features/Files.tsx`：项目输入附件（网页上传）清单。
- `hooks`：从 pi-web 固定提交适配的主题与面板调整逻辑，来源及许可证见 `THIRD_PARTY_NOTICES.md`。

列表／详情轮询每 3 秒，当前轨迹每 5 秒，每轮完成后再调度。隐藏页面暂停，切换项目取消旧请求。提示保存不代表 Worker 已处理。

普通页面使用概览、单条记录与分页列表，打开单条轨迹不再读取完整项目详情或全部执行历史。列表每页 50 条，支持“更早记录”“上一页”“返回最新”，不累计全部页面。画布仅携带完整拓扑和短标签，检查器按 ID 获取全文，深链接可以打开当前列表页以外的记录。

支持 ETag 的接口使用条件轮询：304 复用已有对象；写入、退出和 401 清理浏览器缓存。缓存最多 32 项、约 32 MiB 文本估算。环境状态独立轮询，避免仅因时间变化而遗漏状态。

## 主题

主题直接采用 pi-web 的取值，沿用它的 token 命名（页面背景、面板、悬停、选中、边框、正文、弱化文本、强调色），在 `styles.css` 里定义五套取值，由 `<html data-theme>` 选中：

| 主题    | 明暗 | 说明                                                  |
| ------- | ---- | ----------------------------------------------------- |
| `light` | 浅色 | 默认。中性灰表面 + 蓝色强调色，最接近 pi-web 默认外观 |
| `dark`  | 深色 | 中性深灰                                              |
| `mist`  | 浅色 | 雾青，绿系浅色                                        |
| `rose`  | 浅色 | 蔷薇，玫红系浅色                                      |
| `pine`  | 深色 | 松夜，绿系深色                                        |

`auto` 不是独立主题，它跟随系统解析为 `light` 或 `dark` 并显式写入 `data-theme`。主题只在 **设置 → 常规 → 外观** 切换，保存在 `localStorage` 的 `cairn-theme`；`data-theme` 始终有值，深色主题（`dark` / `pine`）同时给 `<html>` 加 `dark` 类，供图谱配色等直接读取。

未登录页（`src/web/login.ts` 里的静态 `LOGIN_HTML`，由服务端在无会话时直接返回）不加载 React，但会读同一份 `cairn-theme` 偏好并设置 `data-theme`，因此五套主题在登录前后一致；没有偏好或偏好为 `auto` 时按系统解析后显式写入。

## 轨迹显示偏好

**设置 → 常规 → 对话** 的三项都只影响当前浏览器：`cairn-trace-thinking-open`（思考块默认展开）、`cairn-trace-width`（轨迹内容宽度，480–1200，默认 820）、`cairn-trace-font`（轨迹字号，12–20，默认 14）。后两项写成文档级 CSS 变量 `--transcript-max-width` 与 `--cairn-trace-font`，由 `App.tsx` 在首屏应用。

## 提示词更新与生效范围

`src/agents/prompts/decide.md` 与 `execute.md` 仅在数据库首次初始化时播种默认提示词。此后以数据库中的 Agent 配置为准，修改文件或重启服务不会自动覆盖已保存的提示词；启动时发现差异会打印 `agent prompt drift` 警告。这也可能只是你在控制台有意定制了模板。

需要应用仓库中的新模板时：

1. 先备份需要保留的自定义提示词。
2. 打开 **设置 → Agents → Dispatcher / Execute**，在提示词编辑区域点击 **恢复内置模板**。
3. 检查内容并保存；也可直接编辑后保存，无需删除或重新初始化数据库。

新活动使用保存后的配置快照，已经运行的活动不受影响。更新两种 Agent 的提示词需要分别操作。

## 思考等级

首次从 `dispatch.yaml` 导入模型时，Dispatcher 与 Execute 的默认思考等级均为 `high`，并按模型能力规约；未配置模型时为 `off`。已有数据库中的设置不会被默认值变更覆盖，需要在 Agents 中手动选择 `high` 并保存。模型不支持思考时仍以其实际能力为准。

1. **设置 → 模型**：选择供应商及目录模型，开启「支持思考」。思考等级映射采用 pi-web 的逐行布局：彩色等级标记 + `Default / Disabled / Custom`。
2. `Default` 删除覆盖并使用 SDK 默认规则；`Disabled` 保存为 `null`，禁止该等级；`Custom` 保存供应商要求的非空字符串。`xhigh` / `max` 只有显式设置 Custom 才可用。支持清除全部映射，至少应保留一个等级。
3. 保存供应商后，在 **Agents → Dispatcher / Execute → 模型旁的「思考等级」** 选择实际使用等级，两种 Agent 分别保存。未启用思考的模型保留可见的 off 控件及说明，不再隐藏入口。
4. 新活动使用保存后的配置快照，运行中活动不受后续编辑影响。映射变化导致旧等级不可用时，编辑器提示重新选择；运行时按 SDK 规则规约到可用等级。`off` 在模型调用中作为关闭处理，不作为非空 reasoning 字符串发送。

映射只描述上游支持的控制，不能让不支持思考的模型获得思考能力。不同 API 是否接受某个供应商值，仍以实际端点为准。

## 新增只读接口

全部受现有认证保护，不使用 Worker 内部令牌接口。

- `GET /projects/page?query=…&cursor=…&limit=50`：项目侧栏与服务端标题搜索。
- `GET /projects/:id/overview`：项目元信息、计数、用量、最多 50 条活动执行和最近成果／失败摘要。
- `GET /projects/:id/records/:type/:recordId`：单条 Fact/Finding/Goal/Step/Hint/Route 的完整记录；`type=node` 按工作台节点 ID 定位记录。
- `GET /projects/:id/graph/canvas`：画布节点、关系与短标签，保留步骤尝试数。
- `GET /projects/:id/timeline`、`/findings/page`、`/hints/page`、`/goals/page`、`/activities/page`：游标分页视图。activity 可带 `kind=all|decide|execute` 与 `step`。
- `GET /projects/:id/executions/:eid/detail`：选中执行的摘要与前后邻居。

这些列表返回 `items` 与 `next_cursor`，默认 50 条、最大 100 条。游标绑定过滤条件，按时间与 ID 排序；这是实时分页，新增或删除记录后可返回最新。activity 的分页时间不随执行结束或文件追加移动。消息接口使用独立的分页协议。

- `GET /projects/:id/executions/:eid/messages?after_seq=0&limit=100`：按事件序号读取数据库中的执行中与终态记录。
- `GET /projects/:id/executions/:eid/messages/:seq`：读取延迟加载的完整事件。
- `GET /projects/:id/sessions/:file/messages?cursor=…&limit=100`：全部会话文件的原始记录（唯一读取入口），游标使用文件身份和字节位置，尾部未写完的行不推进游标。
- `GET /settings/agents/:role/skills`：该角色当前插件版本的技能清单，读取每个 SKILL.md 的 frontmatter，返回名称、描述、相对路径与来源包；路径越出 release 或文件不可读时跳过该条，插件停用或未安装时返回空数组。

消息分页返回 `entries`、`next_cursor`、`has_more`。最大 200 条、常规响应约 512 KiB；超过 64 KiB 的单条记录提供 `content_url`，原始数据不截断。文件单行超过 16 MiB 返回明确错误；完整内容接口最多返回一个原始记录。文件被替换或截短返回 409，前端提供重新加载。

旧的前端解析接口 `GET /projects/:id/sessions/:file` 已退役：消息读取统一走原始分页接口，工作台列表走 `/activities/page`。持久化版本与 session 元数据索引随数据库启动自动创建；目录同步仍需扫描文件元数据，但未变化文件不再重复读取正文。

旧的全量项目、执行、活动、会话列表和完整图谱 HTTP 入口已删除。创建项目只返回 `{ project }` 元信息，起点与目标从单条 records 接口读取。

## 验证

```sh
npm run typecheck
npm test -- tests/server tests/web tests/orchestrator/execution-protocol.test.ts tests/orchestrator/execution-regressions.test.ts
```

`tests/web/` 保留图谱构建、标签、链接与读取缓存等单元测试；浏览器交互、布局和主题通过实际工作台手动验收。
