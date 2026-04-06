#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shlex
import sys
import threading
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_APP_NAME = "mobius-runtime"
DEFAULT_CACHE_VOLUME = "mobius-modal-cache"
DEFAULT_CPU = 2.0
DEFAULT_MEMORY_MB = 8192
DEFAULT_TIMEOUT_SECONDS = 60 * 60 * 8

IGNORE_PATTERNS = [
    ".git",
    ".next",
    "node_modules",
    "**/node_modules",
    ".turbo",
    "dist",
    "build",
    ".DS_Store",
]

PASS_THROUGH_ENV = [
    "CI",
    "NODE_ENV",
    "NEXT_TELEMETRY_DISABLED",
    "TZ",
    "LANG",
    "LC_ALL",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a command in a Modal CPU sandbox while streaming terminal output."
    )
    parser.add_argument(
        "--cwd",
        default=".",
        help="Working directory (absolute or relative to current shell dir). Default: current dir.",
    )
    parser.add_argument(
        "--port",
        action="append",
        default=[],
        help="Port(s) to expose via Modal tunnel, e.g. --port 3000 or --port 3000,3001",
    )
    parser.add_argument("--cpu", type=float, default=DEFAULT_CPU, help="Sandbox CPU request.")
    parser.add_argument(
        "--memory", type=int, default=DEFAULT_MEMORY_MB, help="Sandbox memory in MiB."
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="Sandbox timeout in seconds.",
    )
    parser.add_argument(
        "--skip-install",
        action="store_true",
        help="Skip package manager auto-install step.",
    )
    parser.add_argument(
        "--app-name",
        default=DEFAULT_APP_NAME,
        help=f"Modal app name. Default: {DEFAULT_APP_NAME}",
    )
    parser.add_argument(
        "--cache-volume",
        default=DEFAULT_CACHE_VOLUME,
        help=f"Modal volume for npm/bun cache. Default: {DEFAULT_CACHE_VOLUME}",
    )
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="Command to execute (use -- before command).",
    )
    args = parser.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("missing command. Example: ./modal/run -- npm run dev")
    return args


def parse_ports(raw_ports: list[str]) -> list[int]:
    ports: list[int] = []
    for raw in raw_ports:
        for item in raw.split(","):
            value = item.strip()
            if not value:
                continue
            port = int(value)
            if port < 1 or port > 65535:
                raise ValueError(f"invalid port: {port}")
            ports.append(port)
    # stable de-dupe
    seen: set[int] = set()
    unique: list[int] = []
    for port in ports:
        if port in seen:
            continue
        seen.add(port)
        unique.append(port)
    return unique


def resolve_local_cwd(raw_cwd: str) -> Path:
    input_path = Path(raw_cwd).expanduser()
    if not input_path.is_absolute():
        input_path = (Path.cwd() / input_path).resolve()
    else:
        input_path = input_path.resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"cwd does not exist: {input_path}")
    if not input_path.is_dir():
        raise NotADirectoryError(f"cwd is not a directory: {input_path}")
    try:
        input_path.relative_to(REPO_ROOT)
    except ValueError as exc:
        raise ValueError(f"cwd must be inside repository: {REPO_ROOT}") from exc
    return input_path


def repo_relative(path: Path) -> str:
    rel = path.resolve().relative_to(REPO_ROOT)
    return rel.as_posix() or "."


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].strip()
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        values[key] = value
    return values


def collect_env(local_cwd: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    env_files = [REPO_ROOT / ".env", REPO_ROOT / ".env.local"]
    if local_cwd != REPO_ROOT:
        env_files.extend([local_cwd / ".env", local_cwd / ".env.local"])
    for env_file in env_files:
        env.update(parse_env_file(env_file))

    # Shell environment wins over file values.
    for key in list(env.keys()):
        if key in os.environ:
            env[key] = os.environ[key]

    for key in PASS_THROUGH_ENV:
        if key in os.environ:
            env.setdefault(key, os.environ[key])

    rewrite_repo_paths(env, local_cwd)
    return env


def rewrite_repo_paths(env: dict[str, str], local_cwd: Path) -> None:
    for key, value in list(env.items()):
        if "://" in value:
            continue
        if "/" not in value and "\\" not in value and not value.startswith("."):
            continue
        candidate = Path(value).expanduser()
        if not candidate.is_absolute():
            candidate = (local_cwd / candidate).resolve()
        else:
            candidate = candidate.resolve()
        if not candidate.exists():
            continue
        try:
            rel = candidate.relative_to(REPO_ROOT)
        except ValueError:
            continue
        env[key] = f"/workspace/{rel.as_posix()}"


def build_bootstrap_script(rel_cwd: str, command: str, skip_install: bool) -> str:
    lines: list[str] = [
        "set -euo pipefail",
        "mkdir -p /workspace",
        "cp -a /workspace-src/. /workspace/",
        f"cd /workspace/{rel_cwd}",
        "export NPM_CONFIG_CACHE=/cache/npm",
        "export BUN_INSTALL_CACHE_DIR=/cache/bun",
        "export XDG_CACHE_HOME=/cache/xdg",
    ]
    if not skip_install:
        lines.extend(
            [
                'if [ -f "bun.lock" ]; then',
                "  bun install --frozen-lockfile || bun install",
                'elif [ -f "package-lock.json" ]; then',
                "  npm ci || npm install",
                'elif [ -f "pnpm-lock.yaml" ]; then',
                "  corepack enable",
                "  pnpm install --frozen-lockfile || pnpm install",
                'elif [ -f "yarn.lock" ]; then',
                "  corepack enable",
                "  yarn install --immutable || yarn install",
                "fi",
            ]
        )
    lines.append(f"exec {command}")
    return "\n".join(lines)


def pump_output(stream: Iterable[object], writer) -> None:
    for chunk in stream:
        if isinstance(chunk, bytes):
            writer.buffer.write(chunk)
            writer.buffer.flush()
            continue
        writer.write(chunk)
        writer.flush()


def attach_stdin(sandbox) -> None:
    if not sys.stdin.isatty():
        return
    try:
        while True:
            data = os.read(sys.stdin.fileno(), 1024)
            if not data:
                break
            sandbox.stdin.write(data.decode("utf-8", errors="ignore"))
            sandbox.stdin.drain()
    except OSError:
        return
    except Exception:
        return


def main() -> int:
    args = parse_args()
    local_cwd = resolve_local_cwd(args.cwd)
    rel_cwd = repo_relative(local_cwd)
    command = shlex.join(args.command)
    ports = parse_ports(args.port)

    # Delay import so --help still works if modal is not installed.
    try:
        import modal
    except ModuleNotFoundError:
        print(
            "modal python package is not installed. Install with: python3 -m pip install modal",
            file=sys.stderr,
        )
        return 2

    env_vars = collect_env(local_cwd)
    secret = modal.Secret.from_dict(env_vars) if env_vars else None

    image = (
        modal.Image.debian_slim(python_version="3.11")
        .apt_install("bash", "curl", "git", "ca-certificates", "build-essential")
        .run_commands(
            "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
            "apt-get install -y nodejs",
            "npm install -g bun@latest",
        )
        .add_local_dir(str(REPO_ROOT), remote_path="/workspace-src", ignore=IGNORE_PATTERNS)
    )

    app = modal.App.lookup(args.app_name, create_if_missing=True)
    cache = modal.Volume.from_name(args.cache_volume, create_if_missing=True)

    bootstrap = build_bootstrap_script(rel_cwd=rel_cwd, command=command, skip_install=args.skip_install)
    sandbox_kwargs = {
        "app": app,
        "image": image,
        "cpu": args.cpu,
        "memory": args.memory,
        "timeout": args.timeout,
        "volumes": {"/cache": cache},
        "pty": True,
    }
    if ports:
        sandbox_kwargs["encrypted_ports"] = ports
    if secret:
        sandbox_kwargs["secrets"] = [secret]

    print(f"[modal] running in app '{args.app_name}'")
    print(f"[modal] cwd: /workspace/{rel_cwd}")
    print(f"[modal] command: {command}")

    with modal.enable_output():
        sandbox = modal.Sandbox.create("bash", "-lc", bootstrap, **sandbox_kwargs)

        if ports:
            tunnels = sandbox.tunnels(timeout=30)
            for port in ports:
                tunnel = tunnels.get(port)
                if tunnel:
                    print(f"[modal] port {port} -> {tunnel.url}")
                else:
                    print(f"[modal] port {port} tunnel unavailable", file=sys.stderr)

        stdout_thread = threading.Thread(
            target=pump_output, args=(sandbox.stdout, sys.stdout), daemon=True
        )
        stderr_thread = threading.Thread(
            target=pump_output, args=(sandbox.stderr, sys.stderr), daemon=True
        )
        stdin_thread = threading.Thread(target=attach_stdin, args=(sandbox,), daemon=True)

        stdout_thread.start()
        stderr_thread.start()
        stdin_thread.start()

        try:
            sandbox.wait(raise_on_termination=False)
        except KeyboardInterrupt:
            print("\n[modal] interrupted, terminating sandbox...", file=sys.stderr)
            sandbox.terminate()
            sandbox.wait(raise_on_termination=False)

        stdout_thread.join(timeout=2)
        stderr_thread.join(timeout=2)

        return_code = sandbox.returncode
        if return_code is None:
            return_code = 1
        return int(return_code)


if __name__ == "__main__":
    raise SystemExit(main())
