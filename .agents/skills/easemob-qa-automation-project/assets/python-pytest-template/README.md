# {{JIRA_KEY}} 自动化测试项目

## 项目来源

- Jira: {{JIRA_URL}}
- PRD: `prd/{{PRD_FILENAME}}`
- 测试用例清单: `docs/cases.md`
- 上下文: `docs/context.md`
- 依赖文档: {{RESOURCE_LINKS}}

本项目根据上述 Jira、PRD、Confluence 或外部接口文档生成。若来源文档不足以支撑某个断言，测试应在代码或文档中标记为跳过、待确认或已知环境依赖，不得伪造预期。

## 测试范围

{{TEST_SCOPE}}

## 测试步骤

{{TEST_STEPS}}

测试步骤必须写清楚接口链路，例如注册哪个运行时用户、使用哪种 token、上传哪个 fixture、从哪个响应字段取值、再把该值传给哪个待测接口。

## 预期结果

{{EXPECTED_RESULTS}}

## 环境配置

环境变量在本 Jira 项目根目录的 `env/` 下维护。根据目标环境复制模板：

```bash
cp env/.env.tke.example env/.env.tke
cp env/.env.ebs.example env/.env.ebs
cp env/.env.ngi.example env/.env.ngi
cp env/.env.qa.example env/.env.qa
```

支持 `TEST_ENV=tke|ebs|ngi|qa`。真实 `env/.env.<env>`、token、密码、项目根目录 `.runtime/` 不得提交。每个真实环境文件使用对应前缀：

```env
TKE_BASE_URL=https://example-tke.easemob.com
TKE_APPKEY=org#app
TKE_CLIENT_ID=replace-with-client-id
```

`TKE_CLIENT_SECRET` 等敏感值不写入 `.env`：由 Bot 指定变量名后，通过 `/env set TKE_CLIENT_SECRET <value>` 提供给运行时。

`APPKEY` 必须使用 `org#app` 格式。不要把真实凭据提交到 Git。

## 安装依赖

```bash
sh scripts/bootstrap_venv.sh
```

## 执行方式

执行全部用例：

```bash
TEST_ENV=tke sh scripts/run_pytest.sh tests
```

只执行某一类用例：

```bash
TEST_ENV=tke sh scripts/run_pytest.sh tests/test_{{FEATURE_SLUG}}.py -k "{{TEST_KEYWORD}}"
```

只检查用例收集：

```bash
TEST_ENV=tke sh scripts/run_pytest.sh tests --collect-only
```

## 运行时资源

测试会在运行时创建所需用户、群组、聊天室、文件或其他资源。运行时 ID 只写入项目根目录 `.runtime/{{JIRA_KEY}}/state.json`，不会提交到 Git。

## 报告

每次有意义的真实环境执行后，在 `reports/` 下记录执行摘要，包括命令、目标环境、通过/失败/跳过数量、运行时资源和失败分析。

## 请求日志

每次执行 pytest 会在项目目录 `log/<timestamp>/` 下生成完整请求和响应日志。每个请求一个格式化 JSON 文件，包含完整 URL、请求 header、请求 body、响应 header、响应 body。JSON 响应会尽量格式化输出；二进制上传文件只记录字段名和文件名，不记录文件内容。

日志会脱敏 `Authorization`、`access_token`、`client_secret`、`password` 等敏感字段，不要把真实凭据写入日志或提交到 Git。
