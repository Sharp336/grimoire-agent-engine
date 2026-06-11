"""Shim builtin open and pathlib.Path write APIs when eval source writes are blocked."""

from __future__ import annotations

import builtins
import io
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, Union

PathLike = Union[str, os.PathLike[str]]

_WRITE_MODES = frozenset({"w", "a", "x", "+", "wb", "ab", "xb", "w+", "a+", "x+", "w+b", "a+b", "x+b", "r+", "rb+", "r+b"})


def _is_write_mode(mode: str | None) -> bool:
    if mode is None:
        return True
    m = str(mode).strip()
    if not m:
        return True
    if m == "r":
        return False
    if "+" in m:
        return True
    base = re.sub(r"[bt]+$", "", m, flags=re.IGNORECASE)
    return base in _WRITE_MODES or any(ch in base for ch in ("w", "a", "x"))



def _is_under_local_roots(raw_path: str) -> bool:
    import eval_guard

    normalized = os.path.normpath(raw_path)
    for root in eval_guard.local_roots_snapshot().values():
        norm_root = os.path.normpath(root)
        if normalized == norm_root or normalized.startswith(norm_root + os.sep):
            return True
    return False

def _assert_path_allowed(path: PathLike) -> None:
    try:
        import eval_guard
    except ImportError:
        return
    if not eval_guard.block_source_writes_enabled():
        return
    raw = os.fspath(path)
    match = re.match(r"^([a-z][a-z0-9+.-]*)://(.*)$", raw.strip(), re.IGNORECASE)
    if match:
        if match.group(1).lower() in eval_guard.local_roots_snapshot():
            return
    if _is_under_local_roots(raw):
        return
    msg = eval_guard.blocked_message() or "eval cannot write project source when edit is available."
    raise ValueError(msg)



_guarded_write_fds: dict[int, str] = {}


def _is_os_write_flags(flags: int) -> bool:
    """True when os.open flags can write or create/truncate."""
    if flags & getattr(os, "O_WRONLY", 1):
        return True
    if flags & getattr(os, "O_RDWR", 2):
        return True
    if flags & getattr(os, "O_CREAT", 64):
        return True
    if flags & getattr(os, "O_TRUNC", 512):
        return True
    if flags & getattr(os, "O_APPEND", 1024):
        return True
    return False


def _register_guarded_fd(fd: int, raw_path: str) -> None:
    _guarded_write_fds[fd] = raw_path


def _unregister_guarded_fd(fd: int) -> None:
    _guarded_write_fds.pop(fd, None)


def _path_for_guarded_fd(fd: int) -> str | None:
    return _guarded_write_fds.get(fd)


_subprocess_originals: dict[str, object] | None = None


def _restore_subprocess_if_patched() -> None:
    global _subprocess_originals
    if _subprocess_originals is None:
        return
    import subprocess as _subprocess_mod

    for name, value in _subprocess_originals.items():
        setattr(_subprocess_mod, name, value)
    _subprocess_originals = None


def install() -> None:
    try:
        import eval_guard
    except ImportError:
        return
    if not eval_guard.block_source_writes_enabled():
        _restore_subprocess_if_patched()
        return

    _real_open = builtins.open

    def guarded_open(
        file: PathLike,
        mode: str = "r",
        buffering: int = -1,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
        closefd: bool = True,
        opener: Any = None,
    ):
        if _is_write_mode(mode):
            _assert_path_allowed(file)
        return _real_open(
            file,
            mode,
            buffering,
            encoding,
            errors,
            newline,
            closefd,
            opener,
        )

    builtins.open = guarded_open  # type: ignore[assignment]
    io.open = guarded_open  # type: ignore[assignment]

    _orig_write_text = Path.write_text
    _orig_write_bytes = Path.write_bytes
    _orig_unlink = Path.unlink

    def write_text(self: Path, data: str, encoding: str | None = None, errors: str | None = None, newline: str | None = None) -> int:
        _assert_path_allowed(self)
        return _orig_write_text(self, data, encoding=encoding, errors=errors, newline=newline)

    def write_bytes(self: Path, data: bytes) -> int:
        _assert_path_allowed(self)
        return _orig_write_bytes(self, data)

    def path_unlink(self: Path, missing_ok: bool = False) -> None:
        _assert_path_allowed(self)
        return _orig_unlink(self, missing_ok=missing_ok)

    _orig_path_open = Path.open

    def path_open(
        self: Path,
        mode: str = "r",
        buffering: int = -1,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
    ):
        if _is_write_mode(mode):
            _assert_path_allowed(self)
        return _orig_path_open(self, mode, buffering, encoding, errors, newline)

    Path.open = path_open  # type: ignore[method-assign]
    Path.write_text = write_text  # type: ignore[method-assign]
    Path.write_bytes = write_bytes  # type: ignore[method-assign]
    Path.unlink = path_unlink  # type: ignore[method-assign]
    _orig_symlink_to = Path.symlink_to
    _orig_link_to = Path.link_to

    def path_symlink_to(self, target: PathLike, target_is_directory: bool = False) -> None:
        _assert_path_allowed(target)
        _assert_path_allowed(self)
        return _orig_symlink_to(self, target, target_is_directory=target_is_directory)

    def path_link_to(self, target: PathLike) -> None:
        _assert_path_allowed(target)
        _assert_path_allowed(self)
        return _orig_link_to(self, target)

    Path.symlink_to = path_symlink_to  # type: ignore[method-assign]
    Path.link_to = path_link_to  # type: ignore[method-assign]

    _orig_os_remove = os.remove
    _orig_os_rename = os.rename
    _orig_os_replace = getattr(os, "replace", None)
    _orig_os_unlink = os.unlink
    _orig_os_symlink = getattr(os, "symlink", None)
    _orig_os_link = getattr(os, "link", None)
    _orig_shutil_move = shutil.move
    _orig_shutil_rmtree = shutil.rmtree

    def guarded_symlink(src: PathLike, dst: PathLike, target_is_directory: bool = False) -> None:
        _assert_path_allowed(src)
        _assert_path_allowed(dst)
        if _orig_os_symlink is None:
            raise OSError("os.symlink is not available")
        return _orig_os_symlink(src, dst, target_is_directory=target_is_directory)

    def guarded_link(src: PathLike, dst: PathLike) -> None:
        _assert_path_allowed(src)
        _assert_path_allowed(dst)
        if _orig_os_link is None:
            raise OSError("os.link is not available")
        return _orig_os_link(src, dst)

    def guarded_remove(path: PathLike, *, dir_fd: int | None = None) -> None:
        _assert_path_allowed(path)
        if dir_fd is not None:
            return _orig_os_remove(path, dir_fd=dir_fd)
        return _orig_os_remove(path)

    def guarded_rename(src: PathLike, dst: PathLike, *, src_dir_fd: int | None = None, dst_dir_fd: int | None = None) -> None:
        _assert_path_allowed(src)
        _assert_path_allowed(dst)
        if src_dir_fd is not None or dst_dir_fd is not None:
            return _orig_os_rename(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        return _orig_os_rename(src, dst)

    def guarded_replace(src: PathLike, dst: PathLike, *, src_dir_fd: int | None = None, dst_dir_fd: int | None = None) -> None:
        _assert_path_allowed(src)
        _assert_path_allowed(dst)
        if _orig_os_replace is None:
            raise OSError("os.replace is not available")
        if src_dir_fd is not None or dst_dir_fd is not None:
            return _orig_os_replace(src, dst, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        return _orig_os_replace(src, dst)

    def guarded_os_unlink(path: PathLike, *, dir_fd: int | None = None) -> None:
        _assert_path_allowed(path)
        if dir_fd is not None:
            return _orig_os_unlink(path, dir_fd=dir_fd)
        return _orig_os_unlink(path)

    def guarded_move(src: PathLike, dst: PathLike, copy_function=shutil.copy2) -> str:
        _assert_path_allowed(src)
        _assert_path_allowed(dst)
        return _orig_shutil_move(src, dst, copy_function=copy_function)

    def guarded_rmtree(
        path: PathLike,
        ignore_errors: bool = False,
        onerror: Any = None,
        *,
        onexc: Any = None,
        dir_fd: int | None = None,
    ) -> None:
        _assert_path_allowed(path)
        if onexc is not None or dir_fd is not None:
            return _orig_shutil_rmtree(path, ignore_errors=ignore_errors, onerror=onerror, onexc=onexc, dir_fd=dir_fd)
        return _orig_shutil_rmtree(path, ignore_errors=ignore_errors, onerror=onerror)

    os.remove = guarded_remove  # type: ignore[assignment]
    os.rename = guarded_rename  # type: ignore[assignment]
    if _orig_os_replace is not None:
        os.replace = guarded_replace  # type: ignore[assignment]
    os.unlink = guarded_os_unlink  # type: ignore[assignment]
    if _orig_os_symlink is not None:
        os.symlink = guarded_symlink  # type: ignore[assignment]
    if _orig_os_link is not None:
        os.link = guarded_link  # type: ignore[assignment]
    shutil.move = guarded_move  # type: ignore[assignment]
    shutil.rmtree = guarded_rmtree  # type: ignore[assignment]
    _orig_os_open = os.open
    _orig_os_write = os.write
    _orig_os_close = os.close

    def guarded_os_open(path: PathLike, flags: int, mode: int = 0o777, *, dir_fd: int | None = None) -> int:
        if _is_os_write_flags(flags):
            _assert_path_allowed(path)
        if dir_fd is not None:
            fd = _orig_os_open(path, flags, mode, dir_fd=dir_fd)
        else:
            fd = _orig_os_open(path, flags, mode)
        if _is_os_write_flags(flags):
            _register_guarded_fd(fd, os.fspath(path))
        return fd

    def guarded_os_write(fd: int, data: bytes | bytearray, /) -> int:
        tracked = _path_for_guarded_fd(fd)
        if tracked is not None:
            _assert_path_allowed(tracked)
        return _orig_os_write(fd, data)

    def guarded_os_close(fd: int, /) -> None:
        _unregister_guarded_fd(fd)
        return _orig_os_close(fd)

    os.open = guarded_os_open  # type: ignore[assignment]
    os.write = guarded_os_write  # type: ignore[assignment]
    os.close = guarded_os_close  # type: ignore[assignment]
    import subprocess as _subprocess_mod

    global _subprocess_originals
    _spawn_names = (
        "Popen",
        "run",
        "call",
        "check_call",
        "check_output",
        "getoutput",
        "getstatusoutput",
    )
    if _subprocess_originals is None:
        _subprocess_originals = {name: getattr(_subprocess_mod, name) for name in _spawn_names}

    _subprocess_msg = (
        eval_guard.blocked_message()
        or "eval cannot spawn subprocesses that may write project source when the edit tool is available."
    )

    _orig_popen = _subprocess_originals["Popen"]

    class _GuardedPopen:
        def __new__(cls, *args: object, **kwargs: object) -> object:
            if not eval_guard.block_source_writes_enabled():
                return _orig_popen(*args, **kwargs)  # type: ignore[misc,operator]
            raise ValueError(_subprocess_msg)

    _subprocess_mod.Popen = _GuardedPopen  # type: ignore[misc,assignment]

    for _name in _spawn_names:
        if _name == "Popen":
            continue
        _orig_fn = _subprocess_originals[_name]

        def _make_wrapper(fn_name: str, orig: object):
            def _wrapper(*args: object, **kwargs: object) -> object:
                if not eval_guard.block_source_writes_enabled():
                    return orig(*args, **kwargs)  # type: ignore[operator]
                raise ValueError(_subprocess_msg)

            _wrapper.__name__ = fn_name
            return _wrapper

        setattr(_subprocess_mod, _name, _make_wrapper(_name, _orig_fn))

