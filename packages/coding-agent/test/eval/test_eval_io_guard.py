"""Contract: eval_io_guard blocks open() writes when eval_guard is on."""
import io
import json
import os
import sys
import tempfile
from pathlib import Path

# Simulate runner bundle layout: eval_guard + eval_io_guard alongside runner
ROOT = Path(__file__).resolve().parents[2] / "src" / "eval" / "py"
sys.path.insert(0, str(ROOT))

import eval_guard  # noqa: E402
import eval_io_guard  # noqa: E402

tmpdir = tempfile.mkdtemp()
target = os.path.join(tmpdir, "src", "foo.py")
os.makedirs(os.path.dirname(target), exist_ok=True)

eval_guard._host_set_guard_state(block_source_writes=True, blocked_message="blocked")
eval_io_guard.install()

try:
    open(target, "w").write("x")
    raise SystemExit("expected ValueError")
except ValueError as e:
    assert "blocked" in str(e).lower() or "edit" in str(e).lower()

p = Path(target)
try:
    open(target, "r+").write("z")
    raise SystemExit("expected ValueError for r+")
except ValueError:
    pass

try:
    with p.open("w") as f:
        f.write("w")
    raise SystemExit("expected ValueError for Path.open")
except ValueError:
    pass

try:
    io.open(target, "w").write("io")
    raise SystemExit("expected ValueError for io.open")
except ValueError:
    pass

try:
    open(target, "rt+").write("rt")
    raise SystemExit("expected ValueError for rt+")
except ValueError:
    pass

try:
    p.write_text("y")
    raise SystemExit("expected ValueError for Path.write_text")
except ValueError:
    pass

try:
    p.unlink()
    raise SystemExit("expected ValueError for Path.unlink")
except ValueError:
    pass


if hasattr(os, "symlink"):
    try:
        os.symlink(target, os.path.join(tmpdir, "alias.py"))
        raise SystemExit("expected ValueError for os.symlink from blocked path")
    except ValueError:
        pass

artifact_root = os.path.join(tmpdir, "artifact-root")
os.makedirs(artifact_root, exist_ok=True)
eval_guard._host_set_local_roots({"local": artifact_root})
artifact_file = os.path.join(artifact_root, "note.txt")
Path(artifact_file).write_text("ok")
assert Path(artifact_file).read_text() == "ok"

# User cannot widen allowlist via os.environ
os.environ["PI_EVAL_LOCAL_ROOTS"] = json.dumps({"local": os.path.dirname(target)})
try:
    open(target, "w").write("spoof")
    raise SystemExit("expected ValueError after env spoof")
except ValueError:
    pass

try:
    fd = os.open(target, os.O_WRONLY | os.O_CREAT)
    os.write(fd, b"x")
    raise SystemExit("expected ValueError for os.open/write")
except ValueError:
    pass
finally:
    try:
        os.close(fd)
    except Exception:
        pass

import subprocess

try:
    subprocess.run(["echo", "hi"])
    raise SystemExit("expected ValueError for subprocess.run")
except ValueError:
    pass

try:
    eval_guard.configure(block_source_writes=False, blocked_message="")
    raise SystemExit("expected RuntimeError for configure from cell")
except RuntimeError:
    pass

if hasattr(os, "replace"):
    try:
        os.replace(target, target + ".moved")
        raise SystemExit("expected ValueError for os.replace")
    except ValueError:
        pass

eval_guard._host_set_guard_state(block_source_writes=False, blocked_message="")
eval_io_guard.install()
subprocess.run(
    [sys.executable, "-c", "pass"],
    check=True,
    capture_output=True,
)
print("subprocess ok when guard off")

print("eval_io_guard ok")
