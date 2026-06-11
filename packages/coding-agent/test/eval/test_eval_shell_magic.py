"""Shell magics blocked when eval source-write guard is on."""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "src" / "eval" / "py"
sys.path.insert(0, str(ROOT))

import eval_guard  # noqa: E402

# Import runner helpers without starting main loop
import runner  # noqa: E402

eval_guard._host_set_guard_state(block_source_writes=True, blocked_message="blocked")

try:
    runner.__omp_shell("echo hi")
    raise SystemExit("expected ValueError for ! shell")
except ValueError:
    pass

try:
    runner._run_shell_body("echo hi", shell_arg="/bin/sh")
    raise SystemExit("expected ValueError for %%bash")
except ValueError:
    pass

print("eval_shell_magic ok")
