#!/usr/bin/env python3
import argparse
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable, List, Optional, Set, Tuple


REPO_ROOT = Path(__file__).resolve().parents[1]

EXCLUDE_DIR_NAMES = {
    ".git",
    ".idea",
    ".next",
    ".pytest_cache",
    ".venv",
    ".vscode",
    "__pycache__",
    "node_modules",
    "out",
}
EXCLUDE_FILE_NAMES = {
    ".DS_Store",
    "Nielsen, Martin 2019-07-23.xml",
}
EXCLUDE_RELATIVE_PATHS = {
    "clip_template.docx",
    "transcript_template.docx",
    "frontend-next/public/icon-192.png",
    "frontend-next/public/icon-512.png",
}

COMPACT_EXCLUDE_FILE_NAMES = {
    "package-lock.json",
}
COMPACT_EXCLUDE_EXTENSIONS = {
    ".tsbuildinfo",
}
COMPACT_EXCLUDE_RELATIVE_PATHS = {
    "codebase_export.txt",
}
COMPACT_JSON_ALLOWLIST = {
    "frontend-next/.eslintrc.json",
    "frontend-next/package.json",
    "frontend-next/public/manifest.json",
    "frontend-next/src-tauri/capabilities/default.json",
    "frontend-next/src-tauri/tauri.conf.json",
    "frontend-next/tsconfig.json",
}

OUTLINE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".mjs", ".html"}
OUTLINE_PATTERNS = (
    re.compile(r"^\s*import\s+"),
    re.compile(r"^\s*export\s+"),
    re.compile(r"^\s*(async\s+)?def\s+\w+\("),
    re.compile(r"^\s*class\s+\w+"),
    re.compile(r"^\s*(async\s+)?function\s+\w+\("),
    re.compile(r"^\s*const\s+\w+\s*=\s*(async\s*)?\("),
    re.compile(r"^\s*interface\s+\w+"),
    re.compile(r"^\s*type\s+\w+\s*="),
    re.compile(r"^\s*@router\.(get|post|put|patch|delete|options|head)\("),
    re.compile(r"^\s*router\.(get|post|put|patch|delete|options|head)\("),
)
OUTLINE_CONTAINS = (
    "/api/",
    "authenticatedFetch(",
    "fetch(",
    "axios.",
    "include_router(",
    "APIRouter(",
    "Depends(",
)


PART_SPECS = {
    "transcriber": [
        "backend/api/transcripts.py",
        "backend/transcriber.py",
        "backend/gemini.py",
        "backend/transcript_formatting.py",
        "backend/transcript_utils.py",
        "backend/models.py",
        "backend/media_processing.py",
        "backend/rev_ai_sync.py",
        "frontend-next/src/components/TranscribeForm.tsx",
        "frontend-next/src/utils/auth.ts",
    ],
    "editor": [
        "backend/api/transcripts.py",
        "backend/rev_ai_sync.py",
        "backend/transcript_formatting.py",
        "backend/transcript_utils.py",
        "backend/storage.py",
        "backend/models.py",
        "frontend-next/src/components/TranscriptEditor.tsx",
        "frontend-next/src/components/TranscribeForm.tsx",
        "frontend-next/src/utils/auth.ts",
    ],
    "clip_creator": [
        "backend/api/clips.py",
        "backend/api/media.py",
        "backend/media_processing.py",
        "backend/transcript_formatting.py",
        "backend/transcript_utils.py",
        "backend/storage.py",
        "backend/models.py",
        "frontend-next/src/components/ClipCreator.tsx",
        "frontend-next/src/components/TranscribeForm.tsx",
        "frontend-next/src/utils/auth.ts",
    ],
}


def run_git(args: List[str], *, check: bool = True, input_text: Optional[str] = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(REPO_ROOT), *args],
        check=check,
        capture_output=True,
        text=True,
        input=input_text,
    )


def load_origin_main_paths() -> Set[str]:
    try:
        result = run_git(["ls-tree", "-r", "--name-only", "origin/main"])
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        message = "Failed to list files from origin/main."
        if stderr:
            message = f"{message} {stderr}"
        raise RuntimeError(message) from exc
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def find_git_ignored_paths(paths: Iterable[str]) -> Set[str]:
    path_list = [path for path in paths if path]
    if not path_list:
        return set()
    input_text = "".join(f"{path}\n" for path in path_list)
    result = run_git(["check-ignore", "--stdin", "--no-index"], check=False, input_text=input_text)
    if result.returncode not in {0, 1}:
        stderr = (result.stderr or "").strip()
        message = "Failed to evaluate .gitignore patterns."
        if stderr:
            message = f"{message} {stderr}"
        raise RuntimeError(message)
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def filter_files_by_git_rules(files: Iterable[Path]) -> List[Path]:
    origin_main_paths = load_origin_main_paths()
    rel_path_to_file: dict[str, Path] = {}
    for path in files:
        rel_path_to_file[path.relative_to(REPO_ROOT).as_posix()] = path
    ignored_paths = find_git_ignored_paths(rel_path_to_file.keys())
    filtered = [
        path
        for rel_path, path in rel_path_to_file.items()
        if rel_path in origin_main_paths and rel_path not in ignored_paths
    ]
    return sorted(filtered, key=lambda path: path.relative_to(REPO_ROOT).as_posix())


def is_binary_bytes(data: bytes) -> bool:
    if b"\x00" in data:
        return True
    sample = data[:4096]
    if not sample:
        return False
    text_chars = set(b"\n\r\t\f\b")
    text_chars.update(range(0x20, 0x7F))
    non_text = sum(1 for b in sample if b not in text_chars)
    return non_text / len(sample) > 0.3


def should_exclude(path: Path) -> bool:
    rel_path = path.relative_to(REPO_ROOT).as_posix()
    if rel_path in EXCLUDE_RELATIVE_PATHS:
        return True
    if path.name in EXCLUDE_FILE_NAMES:
        return True
    for part in Path(rel_path).parts:
        if part in EXCLUDE_DIR_NAMES:
            return True
    return False


def iter_files_under(root: Path) -> Iterable[Path]:
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if should_exclude(path):
            continue
        yield path


def expand_specs(specs: Iterable[str]) -> List[Path]:
    files: Set[Path] = set()
    for spec in specs:
        candidate = (REPO_ROOT / spec).resolve()
        if any(ch in spec for ch in "*?["):
            for match in REPO_ROOT.glob(spec):
                if match.is_file() and not should_exclude(match):
                    files.add(match)
                elif match.is_dir():
                    files.update(iter_files_under(match))
            continue
        if candidate.is_dir():
            files.update(iter_files_under(candidate))
        elif candidate.is_file() and not should_exclude(candidate):
            files.add(candidate)
    return sorted(files, key=lambda path: path.relative_to(REPO_ROOT).as_posix())


def collect_files(args: argparse.Namespace, output_path: Path) -> List[Path]:
    files: Set[Path] = set()

    if args.backend:
        files.update(iter_files_under(REPO_ROOT / "backend"))
        main_py = REPO_ROOT / "main.py"
        if main_py.exists():
            files.add(main_py)
    if args.frontend:
        files.update(iter_files_under(REPO_ROOT / "frontend-next"))
    if args.transcriber:
        files.update(expand_specs(PART_SPECS["transcriber"]))
    if args.editor:
        files.update(expand_specs(PART_SPECS["editor"]))
    if args.clip_creator:
        files.update(expand_specs(PART_SPECS["clip_creator"]))

    if not any((args.backend, args.frontend, args.transcriber, args.editor, args.clip_creator)):
        files.update(iter_files_under(REPO_ROOT))
        main_py = REPO_ROOT / "main.py"
        if main_py.exists():
            files.add(main_py)

    files = {path for path in files if path.resolve() != output_path.resolve()}
    return filter_files_by_git_rules(files)


def apply_compact_filters(files: Iterable[Path]) -> Tuple[List[Path], List[str]]:
    kept: List[Path] = []
    omitted: List[str] = []
    for path in files:
        rel_path = path.relative_to(REPO_ROOT).as_posix()
        suffix = path.suffix.lower()
        if rel_path in COMPACT_EXCLUDE_RELATIVE_PATHS:
            omitted.append(rel_path)
            continue
        if path.name in COMPACT_EXCLUDE_FILE_NAMES:
            omitted.append(rel_path)
            continue
        if suffix in COMPACT_EXCLUDE_EXTENSIONS:
            omitted.append(rel_path)
            continue
        if suffix == ".json" and rel_path not in COMPACT_JSON_ALLOWLIST:
            omitted.append(rel_path)
            continue
        kept.append(path)
    return sorted(kept, key=lambda path: path.relative_to(REPO_ROOT).as_posix()), sorted(omitted)


def should_outline_file(path: Path, text: str, args: argparse.Namespace) -> bool:
    if not args.compact or args.no_outline:
        return False
    if path.suffix.lower() not in OUTLINE_EXTENSIONS:
        return False
    return len(text) >= args.outline_threshold


def build_outline(rel_path: str, text: str, args: argparse.Namespace) -> str:
    lines = text.splitlines()
    head_count = max(10, args.outline_head_lines)
    tail_count = max(10, args.outline_tail_lines)
    key_line_limit = max(20, args.outline_key_line_limit)

    output: List[str] = []
    output.append(
        f"[large file summarized for compact export: {len(text):,} chars, {len(lines):,} lines]"
    )
    output.append(
        f"[full file available in repo at {rel_path}; rerun with --no-compact or with --no-outline for full text]"
    )

    output.append("")
    output.append(f"--- FILE HEAD (first {min(head_count, len(lines))} lines) ---")
    for line in lines[:head_count]:
        output.append(line)

    all_key_lines: List[Tuple[int, str]] = []
    for index, line in enumerate(lines, start=1):
        if any(pattern.search(line) for pattern in OUTLINE_PATTERNS) or any(token in line for token in OUTLINE_CONTAINS):
            all_key_lines.append((index, line))

    key_lines = all_key_lines
    sampled = False
    if len(all_key_lines) > key_line_limit:
        sampled = True
        if key_line_limit == 1:
            key_lines = [all_key_lines[0]]
        else:
            max_index = len(all_key_lines) - 1
            selected_indices = {
                round((position * max_index) / (key_line_limit - 1))
                for position in range(key_line_limit)
            }
            key_lines = [all_key_lines[idx] for idx in sorted(selected_indices)]

    output.append("")
    output.append(f"--- KEY STRUCTURE LINES ({len(key_lines)} shown, limit {key_line_limit}) ---")
    if key_lines:
        for line_number, line in key_lines:
            output.append(f"{line_number:>6}: {line}")
        if sampled:
            output.append("[key lines sampled across file to preserve whole-file coverage]")
    else:
        output.append("[no structure lines matched]")

    output.append("")
    output.append(f"--- FILE TAIL (last {min(tail_count, len(lines))} lines) ---")
    tail = lines[-tail_count:] if len(lines) > tail_count else lines
    for line in tail:
        output.append(line)

    return "\n".join(output) + "\n"


def write_export(
    output_path: Path,
    files: List[Path],
    *,
    args: argparse.Namespace,
    omitted_by_compact: List[str],
) -> Tuple[int, List[str]]:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    total_chars = 0
    outlined_files: List[str] = []
    with output_path.open("w", encoding="utf-8", newline="\n") as handle:
        def write_chunk(text: str) -> None:
            nonlocal total_chars
            handle.write(text)
            total_chars += len(text)

        if args.compact:
            write_chunk("===== COMPACT EXPORT METADATA =====\n")
            write_chunk(f"included_files: {len(files)}\n")
            write_chunk(f"omitted_files: {len(omitted_by_compact)}\n")
            if omitted_by_compact:
                write_chunk("omitted_file_paths:\n")
                for rel_path in omitted_by_compact:
                    write_chunk(f"- {rel_path}\n")
            write_chunk("===== END COMPACT EXPORT METADATA =====\n\n")

        for path in files:
            rel_path = path.relative_to(REPO_ROOT).as_posix()
            write_chunk(f"===== FILE: {rel_path} =====\n")
            try:
                data = path.read_bytes()
            except OSError as exc:
                write_chunk(f"[unreadable file: {exc}]\n")
                write_chunk("===== END FILE =====\n\n")
                continue
            if is_binary_bytes(data):
                write_chunk("[binary file omitted]\n")
                write_chunk("===== END FILE =====\n\n")
                continue
            text = data.decode("utf-8", errors="replace")
            if should_outline_file(path, text, args):
                outlined_files.append(rel_path)
                write_chunk(build_outline(rel_path, text, args))
            else:
                write_chunk(text)
                if not text.endswith("\n"):
                    write_chunk("\n")
            write_chunk("===== END FILE =====\n\n")
    return total_chars, outlined_files


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export TranscribeAlpha source files into a single plain text file.",
    )
    parser.add_argument(
        "--output",
        default=str(REPO_ROOT / "codebase_export.txt"),
        help="Output file path (default: %(default)s)",
    )
    parser.add_argument("--backend", action="store_true", help="Include backend sources (plus main.py).")
    parser.add_argument("--frontend", action="store_true", help="Include frontend sources.")
    parser.add_argument("--transcriber", action="store_true", help="Include transcriber-related files (backend + frontend).")
    parser.add_argument("--editor", action="store_true", help="Include editor-related files (backend + frontend).")
    parser.add_argument(
        "--clip-creator",
        "--clip_creator",
        dest="clip_creator",
        action="store_true",
        help="Include clip creator-related files (backend + frontend).",
    )
    parser.set_defaults(compact=True)
    parser.add_argument(
        "--compact",
        dest="compact",
        action="store_true",
        help=(
            "Enable compact LLM-focused export (default): exclude lock/build artifacts "
            "and summarize very large source files."
        ),
    )
    parser.add_argument(
        "--no-compact",
        dest="compact",
        action="store_false",
        help="Disable compact export and include full file contents.",
    )
    parser.add_argument(
        "--no-outline",
        action="store_true",
        help="With --compact, keep full text for large files instead of structural outlines.",
    )
    parser.add_argument(
        "--outline-threshold",
        type=int,
        default=35000,
        help="With --compact, summarize files at or above this character count (default: %(default)s).",
    )
    parser.add_argument(
        "--outline-key-line-limit",
        type=int,
        default=260,
        help="With --compact, maximum extracted structure lines per outlined file (default: %(default)s).",
    )
    parser.add_argument(
        "--outline-head-lines",
        type=int,
        default=50,
        help="With --compact, number of leading lines retained for outlined files (default: %(default)s).",
    )
    parser.add_argument(
        "--outline-tail-lines",
        type=int,
        default=30,
        help="With --compact, number of trailing lines retained for outlined files (default: %(default)s).",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    output_path = Path(args.output).expanduser()

    if args.compact:
        if args.outline_threshold < 1000:
            parser.error("--outline-threshold must be at least 1000")
        if args.outline_key_line_limit < 20:
            parser.error("--outline-key-line-limit must be at least 20")
        if args.outline_head_lines < 10:
            parser.error("--outline-head-lines must be at least 10")
        if args.outline_tail_lines < 10:
            parser.error("--outline-tail-lines must be at least 10")

    try:
        files = collect_files(args, output_path)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    omitted_by_compact: List[str] = []
    if args.compact:
        files, omitted_by_compact = apply_compact_filters(files)
    if not files:
        print("No files matched the selected filters.", file=sys.stderr)
        return 1

    total_chars, outlined_files = write_export(
        output_path,
        files,
        args=args,
        omitted_by_compact=omitted_by_compact,
    )
    token_estimate = (total_chars + 3) // 4
    rel_output = output_path
    try:
        rel_output = output_path.relative_to(REPO_ROOT)
    except ValueError:
        pass
    print(f"Wrote {len(files)} files to {rel_output}")
    if args.compact:
        print(f"Compact filter omitted {len(omitted_by_compact)} files")
        print(f"Large-file outlines applied to {len(outlined_files)} files")
    print(f"Characters: {total_chars:,}")
    print(f"Estimated tokens (4 chars/token): {token_estimate:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
