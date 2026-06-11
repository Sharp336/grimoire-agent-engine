"""Host-controlled eval write guard (not user-mutable via os.environ)."""

from __future__ import annotations

from pathlib import Path
from typing import Union

PathLike = Union[str, Path]

_block_source_writes = False
_eval_write_blocked_message = ""
# Host snapshot of PI_EVAL_LOCAL_ROOTS (scheme -> absolute path); not read from os.environ at check time.
_local_roots: dict[str, str] = {}


def _host_set_guard_state(*, block_source_writes: bool, blocked_message: str) -> None:
    """Called only from the OMP runner host (runner.py / kernel init)."""
    global _block_source_writes, _eval_write_blocked_message
    _block_source_writes = block_source_writes
    _eval_write_blocked_message = blocked_message


def _host_set_local_roots(roots: dict[str, str]) -> None:
    """Called only from the OMP runner host when request env is applied."""
    global _local_roots
    _local_roots = {k.lower(): v for k, v in roots.items() if isinstance(k, str) and isinstance(v, str)}


def configure(*, block_source_writes: bool, blocked_message: str) -> None:
    """User-visible stub — guard state is host-controlled only."""
    raise RuntimeError(
        "eval_guard.configure cannot be called from eval cells; "
        "source-write blocking is controlled by the OMP host."
    )


def block_source_writes_enabled() -> bool:
    return _block_source_writes


def blocked_message() -> str:
    return _eval_write_blocked_message


def local_roots_snapshot() -> dict[str, str]:
    return dict(_local_roots)


def is_managed_env_key(key: str) -> bool:
    return key in {
        "PI_SESSION_FILE",
        "PI_ARTIFACTS_DIR",
        "PI_TOOL_BRIDGE_URL",
        "PI_TOOL_BRIDGE_TOKEN",
        "PI_TOOL_BRIDGE_SESSION",
        "PI_EVAL_LOCAL_ROOTS",
        "PI_EVAL_BLOCK_SOURCE_WRITES",
    }