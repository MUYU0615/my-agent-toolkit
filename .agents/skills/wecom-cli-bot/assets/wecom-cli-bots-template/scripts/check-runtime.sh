#!/usr/bin/env bash
set -euo pipefail

bot_name="${1:-example-bot}"
config_path="bots/${bot_name}/workspace/private/bot.config.yaml"

echo "Checking base runtime..."
node --version
npm --version

if [ ! -f "${config_path}" ]; then
  echo "Missing ${config_path}" >&2
  exit 1
fi

provider="$(node -e "const fs=require('fs'); const YAML=require('yaml'); const c=YAML.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(c.cli.provider)" "${config_path}")"
command_name="$(node -e "const fs=require('fs'); const YAML=require('yaml'); const c=YAML.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(c.cli.command)" "${config_path}")"

echo "Checking CLI provider: ${provider}"
if ! command -v "${command_name}" >/dev/null 2>&1; then
  echo "Missing CLI command: ${command_name}" >&2
  echo "Install the selected CLI in Dockerfile or on the host, then rerun this check." >&2
  exit 1
fi

"${command_name}" --version || true
echo "Runtime check completed."
