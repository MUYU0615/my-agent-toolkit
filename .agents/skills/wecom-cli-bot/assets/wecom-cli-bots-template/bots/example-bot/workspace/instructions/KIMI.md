# Kimi Code Notes

Use this file for Kimi-specific instruction additions. Do not put secrets here.

Default Docker/Linux install:

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

Default command:

```bash
kimi
```

Bot runtime mode:

- Use Kimi Code CLI login state, not an OpenAI-compatible API provider.
- Authenticate inside the target runtime with `KIMI_CODE_HOME=<bot cli-home> kimi login`.
- Run non-interactively with `kimi -p "{{prompt}}" --output-format text`.
- Do not combine `--auto` with `-p`; Kimi Code rejects that combination.
- Store Kimi runtime data under `workspace/cli-home/kimi` via `KIMI_CODE_HOME`.
- `kimi -p` prints `To resume this session: kimi -r session_...`; the bridge must parse that session id before redaction, hide that line from WeCom, and pass `-r <session>` on later messages from the same user.
- `default_thinking` in `KIMI_CODE_HOME/config.toml` controls whether thinking appears in `kimi -p` output.
