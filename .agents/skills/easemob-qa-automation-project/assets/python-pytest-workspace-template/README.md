# Easemob Auto Test

这是 Test-Jira Bot 为当前用户、当前会话、当前 Jira 创建的独立自动化测试项目。项目目录本身即为 `<JIRA-KEY>/`，不读取或复用其他项目。

环境变量示例位于 `env/.env.<env>.example`。真实环境文件、运行时资源和请求日志均不会提交到 Git。

```bash
sh scripts/bootstrap_venv.sh
TEST_ENV=qa sh scripts/run_pytest.sh tests
```

只有已在对话中确认的测试用例才会生成代码。执行报告保存在 `reports/` 目录；Token 等运行时密钥通过 Bot 的 `/env set KEY VALUE` 配置，不写入项目文件。
