"""eval_guard modules are importable next to runner.py (kernel cache layout)."""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "src" / "eval" / "py"
guard_src = (ROOT / "eval_guard.py").read_text(encoding="utf-8")
io_src = (ROOT / "eval_io_guard.py").read_text(encoding="utf-8")

tmpdir = tempfile.mkdtemp()
cache = os.path.join(tmpdir, "bundle-test")
os.makedirs(cache)
Path(cache, "eval_guard.py").write_text(guard_src, encoding="utf-8")
Path(cache, "eval_io_guard.py").write_text(io_src, encoding="utf-8")
Path(cache, "runner.py").write_text("# stub\n", encoding="utf-8")

sys.path.insert(0, cache)
import eval_guard  # noqa: E402
import eval_io_guard  # noqa: E402

eval_guard._host_set_guard_state(block_source_writes=True, blocked_message="blocked")
eval_io_guard.install()
print("kernel guard layout ok")