# 安全策略

## 报告漏洞

请**不要**用公开 issue 报告安全漏洞。优先使用 GitHub 的私密漏洞报告：

<https://github.com/NAXG/Cairn_X/security/advisories/new>

（若该入口不可用，可开一个不含细节的 issue 说明需要私密渠道，维护者会联系你。）

## 什么算漏洞

本项目按设计把 shell 执行能力交给模型，**以下不是漏洞**：

- Worker 在容器内执行模型给出的 `bash` / `read` / `edit` / `write` 命令
- 评测与靶场场景中对授权目标发起的主动测试行为
- 模型自身给出的错误或危险建议（由决策与沙箱边界约束，不由模型保证）

**以下属于漏洞**：

- 控制面鉴权绕过、令牌伪造或越权访问（`cairn-x/src/server/auth.ts`、`cairn-x/src/control/`）
- 从 Worker 容器逃逸到宿主机，或跨项目读取/写入数据（`cairn-x/src/worker/`、`cairn-x/src/environments/`）
- 对不可信输入的处理错误：路径穿越、注入、请求体资源耗尽（上传、图谱 API、受限模型代理）
- 凭据隔离失效：长期模型 key、数据库凭据或平台 token 出现在 Worker 容器内

## 部署方须知

控制面**不要**直接暴露到公网。请用反代 + HTTPS，并设置非空的
`CAIRN_WEB_PASSWORD` 与 `CAIRN_API_TOKEN`（见 README 的「公网加固」一节）。
以不安全方式暴露部署实例（例如无 HTTPS、弱密码、未设 API token）导致的后果不在漏洞范围内。

## 支持范围

只有 `main` 分支的最新提交接受安全修复。
