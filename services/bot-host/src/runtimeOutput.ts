const ansiPattern = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const toolStartPattern = /^(?:I will run the following command:|Fetching content from:|Reading file:|Searching for files:|Invoking subagent:|Tool validation failed:|Tool ['"].*['"] validation failed:)/i;
const toolEndPattern = /(?:Completed in\s+\d+(?:\.\d+)?s|Execution failed after\s+\d+(?:\.\d+)?s)/i;
const standaloneDiagnosticPattern = /^(?:Purpose:|Tool validation failed:|Tool ['"].*['"] validation failed:|[✓●⦁-]?\s*Completed in\s+\d+(?:\.\d+)?s|[✓●⦁-]?\s*Execution failed after\s+\d+(?:\.\d+)?s|\(using tool:\s*[^)]+\)|[>⋮✓●⦁])\s*$/i;
const batchFileReadDiagnosticPattern = /^(?:↱\s*Operation\s+\d+:\s*Reading file:|✓\s*Successfully read\s+\d+\s+bytes\s+from\s+|⦁\s*Summary:\s*\d+\s+operations processed\b)/i;
const pythonExceptionPattern = /^(?:[A-Za-z_][\w.]*\.)*[A-Za-z_][\w]*(?:Error|Exception):\s*/;

export interface RuntimeOutputPresentation {
  visibleText: string;
  diagnosticText: string;
  diagnosticInProgress: boolean;
}

export function presentRuntimeOutput(value: string): RuntimeOutputPresentation {
  const normalized = stripRuntimeControlSequences(value)
    .replace(
      /((?:[✓●⦁-]\s*)?Completed in\s+\d+(?:\.\d+)?s)(?=\S)/gi,
      "$1\n",
    )
    .replace(
      /((?:[✓●⦁-]\s*)?Execution failed after\s+\d+(?:\.\d+)?s:?)(?=\S)/gi,
      "$1\n",
    );
  const visible: string[] = [];
  const diagnostics: string[] = [];
  let inToolBlock = false;
  let inPythonTraceback = false;

  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();

    if (inPythonTraceback) {
      diagnostics.push(line);
      if (pythonExceptionPattern.test(trimmed)) {
        inPythonTraceback = false;
      }
      continue;
    }

    if (inToolBlock) {
      diagnostics.push(line);
      if (toolEndPattern.test(trimmed)) {
        inToolBlock = false;
      }
      continue;
    }

    if (toolStartPattern.test(trimmed)) {
      diagnostics.push(line);
      if (!toolEndPattern.test(trimmed)) {
        inToolBlock = true;
      }
      continue;
    }

    if (/^Traceback \(most recent call last\):/i.test(trimmed)) {
      diagnostics.push(line);
      inPythonTraceback = true;
      continue;
    }

    if (
      standaloneDiagnosticPattern.test(trimmed)
      || batchFileReadDiagnosticPattern.test(trimmed)
      || /\(using tool:\s*[^)]+\)/i.test(trimmed)
    ) {
      diagnostics.push(line);
      continue;
    }

    visible.push(line);
  }

  const visibleText = compactVisibleText(visible.join("\n"));
  const diagnosticText = diagnostics.join("\n").trim();
  return {
    visibleText: visibleText || mapKnownRuntimeDiagnostic(normalized),
    diagnosticText,
    diagnosticInProgress: inToolBlock || inPythonTraceback,
  };
}

export function stripRuntimeControlSequences(value: string): string {
  return value
    .replace(ansiPattern, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r/g, "")
    .replace(/^>\s*/gm, "");
}

function compactVisibleText(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mapKnownRuntimeDiagnostic(value: string): string {
  if (
    /Jira credentials are not bound|Missing EASEMOB_JIRA_USERNAME or EASEMOB_JIRA_PASSWORD/i.test(
      value,
    )
  ) {
    return "Jira 凭证未绑定。请在企业微信中发送 /jira bind，绑定后重新发送 Jira 编号。";
  }
  if (/Login verification failed; current user is anonymous/i.test(value)) {
    return "Jira 凭证验证失败。请发送 /jira bind 重新绑定正确的 Jira 登录信息。";
  }
  if (/TLS certificate verification failed/i.test(value)) {
    return "Jira TLS 证书验证失败，请联系管理员检查 Jira 运行环境配置。";
  }
  return "";
}
