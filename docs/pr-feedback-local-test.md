# PR Feedback Runner 本地验证

此阶段尚未接 GitHub App 或真实 GitHub Webhook。以下步骤用本地请求验证：Jira 项目保存真实 CLI 会话、PR 绑定、评论恢复同一项目会话。

1. 重建 `llm-runner`、`pr-feedback-runner`、`jira-automation-runner`，再用一个新的 Jira Webhook delivery 运行一次目标 Jira。该 Run 会创建持久目录 `system-flows/jira-automation/projects/jira-<JIRA-KEY>/`，并向 PR Feedback Runner 注册真实 CLI 会话。
2. 以本地测试 PR 标识绑定该项目。不要打印 Token：在同一个 shell 加载凭据后直接使用变量。

```bash
set -a
source deploy/compose/.env.credentials
set +a

curl -X POST http://localhost:8920/internal/project-sessions/jira-HIM-22187/bind-pr \
  -H "Authorization: Bearer $JIRA_AUTOMATION_INTERNAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"repository_id":"local-qa-auto-test","pr_number":42}'
```

3. 模拟一条 GitHub `issue_comment` 事件。开发环境未设置 `GITHUB_WEBHOOK_SECRET` 时无需签名；正式环境必须设置该 Secret 并校验 `X-Hub-Signature-256`。

```bash
curl -X POST http://localhost:8920/webhooks/github \
  -H 'Content-Type: application/json' \
  -H 'X-GitHub-Event: issue_comment' \
  -H 'X-GitHub-Delivery: local-him-22187-comment-001' \
  -d '{
    "repository":{"id":"local-qa-auto-test"},
    "issue":{"number":42,"pull_request":{"url":"local"}},
    "comment":{"id":"local-comment-001","body":"检查现有代码的边界处理并给出修复建议"},
    "sender":{"type":"User"}
  }'
```

结果写入持久项目目录的 `feedback/local-comment-001.md`。本地阶段不会 Push 或评论 GitHub；它只恢复同一 CLI 会话并在同一代码目录工作。
