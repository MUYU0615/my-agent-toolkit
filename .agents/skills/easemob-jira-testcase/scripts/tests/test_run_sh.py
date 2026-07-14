import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent
RUN_SH = SCRIPT_DIR / "run.sh"


class RunShEnvironmentTests(unittest.TestCase):
    def test_run_sh_creates_and_uses_local_venv_python(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fake_bin = tmp_path / "bin"
            fake_bin.mkdir()
            log_path = tmp_path / "python3.log"

            python3 = fake_bin / "python3"
            python3.write_text(
                "\n".join(
                    [
                        "#!/usr/bin/env bash",
                        "set -euo pipefail",
                        f'echo "$@" >> "{log_path}"',
                        'if [[ "$1" == "-m" && "$2" == "venv" ]]; then',
                        '  venv_dir="$3"',
                        '  mkdir -p "${venv_dir}/bin"',
                        "  cat > \"${venv_dir}/bin/python\" <<'PY'",
                        "#!/usr/bin/env bash",
                        "echo \"venv-python:$@\"",
                        "exit 0",
                        "PY",
                        '  chmod +x "${venv_dir}/bin/python"',
                        "  exit 0",
                        "fi",
                        "exit 0",
                    ]
                ),
                encoding="utf-8",
            )
            python3.chmod(python3.stat().st_mode | stat.S_IXUSR)

            venv_dir = SCRIPT_DIR / ".venv"
            if venv_dir.exists():
                self.skipTest("scripts/.venv already exists; behavior is covered in clean checkouts")

            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"

            result = subprocess.run(
                [str(RUN_SH), "--root", "HIM-1", "--dry-readiness"],
                cwd=SCRIPT_DIR,
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )

            self.assertIn("venv-python:jira_issue_network.py --root HIM-1 --dry-readiness", result.stdout)
            self.assertIn("-m venv", log_path.read_text(encoding="utf-8"))

            shutil.rmtree(venv_dir)


if __name__ == "__main__":
    unittest.main()
