#!/usr/bin/env python3
import argparse
import os
import sys
from pathlib import Path
from typing import Iterable, List, Set, Tuple


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
    if path.name in EXCLUDE_FILE_NAMES:
        return True
    for part in path.relative_to(REPO_ROOT).parts:
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
    return sorted(files, key=lambda path: path.relative_to(REPO_ROOT).as_posix())


def write_export(output_path: Path, files: List[Path]) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    total_chars = 0
    with output_path.open("w", encoding="utf-8", newline="\n") as handle:
        def write_chunk(text: str) -> None:
            nonlocal total_chars
            handle.write(text)
            total_chars += len(text)

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
            write_chunk(text)
            if not text.endswith("\n"):
                write_chunk("\n")
            write_chunk("===== END FILE =====\n\n")
    return total_chars


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
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    output_path = Path(args.output).expanduser()

    files = collect_files(args, output_path)
    if not files:
        print("No files matched the selected filters.", file=sys.stderr)
        return 1

    total_chars = write_export(output_path, files)
    token_estimate = (total_chars + 3) // 4
    rel_output = output_path
    try:
        rel_output = output_path.relative_to(REPO_ROOT)
    except ValueError:
        pass
    print(f"Wrote {len(files)} files to {rel_output}")
    print(f"Characters: {total_chars:,}")
    print(f"Estimated tokens (4 chars/token): {token_estimate:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
