# Solara 稳定性自动化：安装与手动试跑

本次本地准备针对 `431771129/solara`，基于提交
`f18015be89724e0951ee3319735093da7edab22e`。
**准备好配置 ≠ 已上传 GitHub ≠ 已经运行。**

## 已做什么

- 不改播放器功能，先添加离线基线：音源/音质规范化、搜索参数和错误、
  榜单请求/映射、以及 URL 生成的公开接口测试。
- `npm run verify`：离线 JS/HTML 内联脚本/JSON/shell 语法 + Node 测试。
  不需要 `npm install`，没有新增运行时依赖。
- `Offline checks`：普通 push/PR 自动检查，**不调用模型**。
- `Bounded stability candidate`：只允许手动触发。提案、验证、发布草稿
  使用三个独立的临时运行器；启用前有独立总开关。
- 限制 AI 每轮至多修改 8 个文件 / 300 增删行 / 64 KiB patch。
  AI 步骤最多 12 分钟，最多积压 2 个 AI PR；没有明确问题就不产生补丁。

## 测试范围与盲区

测试只通过 `js/constants.js` 的导出接口，模拟 fetch 响应，不读取真实收藏、
不启动服务、不访问音乐站点。安全辅助工具用临时 Git 仓库验证其 CLI。
语法检查不等于浏览器验证：没有证明真实音频可播放、手机手势正确、
SQLite/D1 同步正常，也没有进行 Workers TypeScript 类型检查。
本次先补现状基线，没有冒称“已复现修复”播放器 Bug。

## 安全边界

AI 只可改 `js/**/*.js`、`css/**/*.css`、`index.html` 和新增顶层
`tests/*.test.mjs`。禁止改 `js/state.js`、`js/core/storage.js`、现有测试、
服务端、Pages Functions、登录、依赖、脚本工具、工作流、文档和部署。
删除、重命名、符号链接、可执行位和二进制补丁都会被拒绝。

模型运行器只有仓库读取权限；上游模型密钥由官方 Codex Action 代理处理，
使用 `:workspace` 权限和 `drop-sudo`。**有沙盒也不等于绝无密钥泄漏风险**；
只用独立限额 Key，不用生产 Key，不给模型 GitHub 写入令牌。
模型输出经结构化 JSON 传到新的验证器，不在模型运行器后执行特权操作。
验证器没有模型密钥或写令牌；执行新测试前固定补丁摘要。发布器重新校验
同一摘要和路径，且不执行应用代码/测试，只创建独立分支和 DRAFT PR。

这是降低风险，不是完全可信的软件供应链。人仍须审查补丁与测试质量。
模型提供商会接收到源码和提示词，确认其隐私政策后再使用。

**不会自动合并、打标签、发布镜像、触发 Docker Publish 或部署。**
但是 Cloudflare 的 Git 集成可能独立自动建立分支预览。它不在本仓库内：
启用前到 Pages 设置排除 `ai/*` 分支预览；确保生产部署只跟踪默认分支。
如果保护分支要求状态检查，bot 使用 `GITHUB_TOKEN` 建的 PR 可能不会自动
触发第二套 push/PR 工作流；本流程内 verify 是独立证据，不要为此关闭保护。
人工需要时可运行 `Offline checks` 的 workflow_dispatch，或在 PR Ready 后核查。

## 1. 把本地配置加入你的仓库

在自己的 Git 环境中先建立分支并应用提供的补丁（补丁文件另附）：

```sh
git clone https://github.com/431771129/solara.git
cd solara
git switch -c automation/stability-bootstrap
git apply --check /path/to/solara-stability-bootstrap.patch
git apply /path/to/solara-stability-bootstrap.patch
npm run verify
git add .github .gitignore package.json tools tests docs/automation.md
git commit -m "ci: add bounded offline stability automation"
git push -u origin automation/stability-bootstrap
```

使用你自己的 GitHub 登录，不要把 PAT、密码或模型密钥放入补丁/聊天。
审查这个启动分支的 PR，再由你手动合入默认分支。`workflow_dispatch` 工作流
须存在于默认分支后才会在 Actions 主列表正常可见。
这是 fork 仓库：如果 GitHub 暂停 Actions，需要你在 Actions 页手动启用。

## 2. 配置星池（不要在聊天粘贴密钥）

仓库 Settings → Secrets and variables → Actions：

**Secrets**

| 名称 | 内容 |
| --- | --- |
| `MODEL_API_KEY` | 单独为此任务创建的星池 Key，配置额度/费用上限 |

**Variables**

| 名称 | 建议值 |
| --- | --- |
| `SOLARA_AI_RESPONSES_ENDPOINT` | `https://api.xingchiapi.com/v1/responses` |
| `SOLARA_AI_MODEL` | `gpt-6.1-sol`（来自当前 Minis 的非敏感模型配置，不代表已实测 CI 兼容） |
| `SOLARA_AI_ENABLED` | 初始保持 `false`；准备齐全后手动设为 `true` |

Codex Action 需要 **Responses API**，仅支持 `/chat/completions` 的服务不能
直接替换。模型需支持工具调用和结构化输出。本地未读取、迁移或使用 Minis
保存的密钥，未发出模型测试请求。可能因网关模型名、工具或 JSON schema
兼容性而试跑失败，应查看日志定位，不能把 workflow 文件当作运行成功。

在 GitHub Settings → Actions → General → Workflow permissions 中，开启
“Allow GitHub Actions to create and approve pull requests”。本流程只创建，
**不会审批**。仓库/组织策略如不允许，保留保护规则，改由人工提交补丁。

## 3. 先手动试一次

1. 完成上述配置，独立 Key 设置好额度上限，确认分支预览已关闭。
2. 将 `SOLARA_AI_ENABLED` 设为 `true`。
3. Actions → **Bounded stability candidate** → Run workflow，选择默认分支。
4. 先看 prepare 的离线基线，再看 propose、verify、publish-draft。
5. 有在范围内、能通过离线测试的候选才会创建 DRAFT PR。
   没有可复现问题、越权修改、测试不通过、超时或兼容失败都会停止；
   不会因为“必须持续运行”而强行提交代码。
6. 人工做浏览器/移动端和播放验证，再决定合并或关闭。自动化不做此决定。

## 4. 关于“全天持续跑”与成本

当前按照用户选择 **先手动试跑**，文件里**没有 schedule**，不存在已经启动
的全天任务。试跑稳定、真实问题队列和预算明确后，再另行增加定时触发。
Actions cron 可能延迟，不是准实时常驻进程；公开 fork 的定时任务长期无活动
还可能被 GitHub 暂停，需关注其最新政策。

- GitHub 托管 Linux runner 在公开仓库的标准配额通常较宽松，但免费不是承诺；
  私有仓库、特殊 runner、制品存储等按账号方案计算。
- **运行超时、文件/行数上限不等于费用上限**。Codex 会进行多次模型请求；
  本工作流不承诺“每轮最多一次 API”，也没有按供应商美元计价的硬结算器。
- 星池公益额度、速率和可用性以其规则为准；不要绕过限制或开多号。
  Key 若没有硬额度上限，不建议无人值守全天运行。
- 停止：把 `SOLARA_AI_ENABLED` 改为 `false` 或在 Actions 禁用该工作流。
  已运行的一轮要点 Cancel，已产生 PR/分支不会被自动删除。

原仓库声明 CC BY-NC-SA，保留其署名与链接，不据此开展被许可条款禁止的商业使用。
