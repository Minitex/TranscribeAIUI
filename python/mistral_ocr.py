#!/usr/bin/env python3
"""
OCR PDFs or images via the Mistral OCR API.

This script can process a single file, an entire folder, recurse through
subfolders, or run via the batch endpoint for large workloads.

Env:
    MISTRAL_API_KEY must be set in your environment or supplied via a .env file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Iterable, List, Tuple
import sys

from dotenv import load_dotenv
import httpx
from mistralai import Mistral
from appdirs import user_data_dir
import subprocess
import tempfile
from pathlib import Path
import shutil
try:
    from PIL import Image
except ImportError:
    import PIL.Image as Image

# Import cv2 with comprehensive error handling for PyInstaller compatibility
try:
    import cv2
except ImportError as e:
    print(f"[ERR] OpenCV not available: {e}")
    print("[ERR] Please install opencv-python: pip install opencv-python")
    sys.exit(1)
except Exception as e:
    print(f"[ERR] Error importing cv2: {e}")
    sys.exit(1)

load_dotenv()  # read .env if present

SUPPORTED_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif"}
OCR_MODEL = "mistral-ocr-latest"


def preprocess_image_for_ocr(input_path: str, temp_dir: str) -> str:
    """
    Convert input image to grayscale PNG format for OCR processing using cv2.
    Returns the path to the converted PNG file.
    """
    if not os.path.isfile(input_path):
        raise RuntimeError(f"Input file not found: {input_path}")
    
    # Generate output filename
    base_name = os.path.splitext(os.path.basename(input_path))[0]
    output_path = os.path.join(temp_dir, f"{base_name}.png")
    
    try:
        # Use cv2 for image processing like the original working code
        image = cv2.imread(input_path)
        if image is None:
            raise RuntimeError(f"Unable to load image: {input_path}")
        
        # Convert to grayscale
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        
        # Ensure temp directory exists
        os.makedirs(temp_dir, exist_ok=True)
        
        # Write PNG directly to temp_dir
        success = cv2.imwrite(output_path, gray)
        if not success:
            raise RuntimeError(f"Failed to write processed image: {output_path}")
            
        print(f"[OK] Page preprocessed {output_path}")
        return output_path
        
    except Exception as e:
        raise RuntimeError(f"Failed to preprocess {input_path}: {e}")



def chunk_files(files: list, chunk_size: int) -> list[list]:
    """Split files into chunks of specified size"""
    return [files[i:i + chunk_size] for i in range(0, len(files), chunk_size)]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run OCR using Mistral OCR API")
    parser.add_argument(
        "--input",
        dest="input_path",
        help="Path to a PDF/image file OR a directory. "
             "If omitted, falls back to MDL_Image_5.jpg next to this script.",
    )
    parser.add_argument("--recursive", action="store_true", help="Scan subfolders when input is a directory.")
    parser.add_argument(
        "--outdir",
        type=Path,
        help="Directory to write .txt outputs into (mirrors folder structure when input is a directory).",
    )
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing .txt files.")
    parser.add_argument("--batch", action="store_true", help="Use Mistral Batch API for OCR at scale.")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=10,
        help="Number of files to process per batch (default: 10).",
    )
    parser.add_argument(
        "--batch-file",
        type=Path,
        help="Where to write the batch JSONL (default: ocr_batch.jsonl in CWD).",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=2.0,
        help="Seconds between batch status checks (default: 2.0).",
    )
    parser.add_argument(
        "--app-data-dir",
        type=Path,
        help="App data directory for storing temporary files.",
    )
    return parser.parse_args()


def resolve_input_path(requested: str | None) -> Path:
    if requested:
        p = Path(requested).expanduser()
        if p.exists():
            return p
        raise FileNotFoundError(f"Input path not found: {p}")

    default_path = Path(__file__).with_name("MDL_Image_5.jpg")
    if default_path.exists():
        return default_path

    raise FileNotFoundError("No --input provided and MDL_Image_5.jpg not found next to this script.")


def iter_files(root: Path, recursive: bool) -> Iterable[Path]:
    """
    Yield supported files from a file or directory path.
    """
    if root.is_file():
        if root.suffix.lower() in SUPPORTED_EXTS:
            yield root
        else:
            raise ValueError(f"Unsupported file type: {root.suffix} (supported: {sorted(SUPPORTED_EXTS)})")
        return

    if not root.is_dir():
        raise ValueError(f"--input is neither file nor directory: {root}")

    walker = root.rglob("*") if recursive else root.glob("*")
    for p in walker:
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS:
            yield p


def output_path_for(src: Path, base_input: Path, outdir: Path | None) -> Path:
    """
    Determine where to write the .txt file.
    - If outdir is None: alongside the source file.
    - If outdir is set and base_input is a directory: mirror src's relative path under outdir.
    - If outdir is set and base_input is a single file: <outdir>/<src.stem>.txt
    """
    if outdir is None:
        return src.with_suffix(".txt")

    outdir = outdir.resolve()
    if base_input.is_file():
        return outdir / f"{src.stem}.txt"

    rel = src.resolve().relative_to(base_input.resolve())
    return outdir / rel.with_suffix(".txt")


def ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def clean_markdown(text: str) -> str:
    """
    Convert markdown to clean plain text while preserving meaning and proper currency formatting.
    Handles tables, formatting, and common OCR errors.
    """
    if not text:
        return ""

    cleaned = text
    
    # Clean OCR artifacts (but preserve actual currency)
    ocr_replacements = {
        r'\\\$': 'S',  # \$ -> S (escaped dollar should be S)
        r'\\mathfrak\{([^}]+)\}': r'\1',  # Remove mathfrak formatting
        r'\\([a-zA-Z])': r'\1',  # Remove backslash escapes from letters
        r'([A-Za-z])\s+([a-z])': r'\1\2',  # Fix broken words like "B a l l" -> "Ball"
    }
    
    for pattern, replacement in ocr_replacements.items():
        cleaned = re.sub(pattern, replacement, cleaned)
    
    # Convert markdown tables to readable text format
    def convert_table(match):
        table_text = match.group(0)
        lines = table_text.strip().split('\n')
        
        processed_lines = []
        for line in lines:
            # Skip header separator line (contains :-- or similar)
            if re.match(r'\|[\s:\-|]+\|', line):
                continue
            
            # Process table row
            if '|' in line:
                cells = [cell.strip() for cell in line.split('|')[1:-1]]  # Remove empty first/last
                if cells and any(cell.strip() for cell in cells):  # Only if row has content
                    # Clean each cell and join with spacing that preserves readability
                    cleaned_cells = []
                    for cell in cells:
                        # Clean markdown from individual cells
                        cell_clean = cell.replace('**', '').replace('*', '').replace('`', '')
                        cell_clean = re.sub(r'\$([^$]*)\$', r'\1', cell_clean)  # Remove math mode $ delimiters
                        cleaned_cells.append(cell_clean.strip())
                    
                    # Format as "Name: Amount" for two-column tables, or space-separated for others
                    if len(cleaned_cells) == 2:
                        processed_lines.append(f"{cleaned_cells[0]}: {cleaned_cells[1]}")
                    else:
                        processed_lines.append('  '.join(cleaned_cells))
        
        return '\n'.join(processed_lines)
    
    # Match markdown tables
    table_pattern = r'\|[^|\n]+\|[^|\n]*\|\n\|[:\-\s|]+\|\n(?:\|[^|\n]*\|[^|\n]*\|\n?)+'
    cleaned = re.sub(table_pattern, convert_table, cleaned, flags=re.MULTILINE)
    
    # Remove standard markdown formatting while preserving content
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", cleaned)  # Images
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)  # Links -> just the text
    cleaned = re.sub(r"^\s{0,3}#{1,6}\s+", "", cleaned, flags=re.MULTILINE)  # Headers
    
    # Remove formatting markers but preserve the text
    for marker in ("**", "__", "*", "_", "`"):
        cleaned = cleaned.replace(marker, "")
    
    # Clean math mode delimiters ($ around math expressions) but preserve actual dollar amounts
    cleaned = re.sub(r'\$([^$\d][^$]*[^$\d])\$', r'\1', cleaned)  # Math mode like $\mathfrak{...}$
    
    # Clean up whitespace while preserving paragraph structure
    cleaned = re.sub(r"\n\s*\n\s*\n+", "\n\n", cleaned)  # Multiple newlines to double
    cleaned = re.sub(r"[ \t]+", " ", cleaned)             # Multiple spaces to single
    cleaned = re.sub(r" \n", "\n", cleaned)               # Remove trailing spaces before newlines
    
    return cleaned.strip()


def _extract_markdown_sections(payload: dict | list | str | None) -> list[str]:
    sections: list[str] = []

    def visit(node):
        if isinstance(node, str):
            return
        if isinstance(node, dict):
            md = node.get("markdown")
            if isinstance(md, str):
                sections.append(md)
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(payload)
    return sections


def ocr_file(client: Mistral, file_path: Path) -> List[str]:
    """
    Uploads the file, runs OCR, and returns a list of page markdown strings.
    Uses signed URL + document_url so it works for single or multi-page docs.
    """
    with file_path.open("rb") as file_obj:
        uploaded = client.files.upload(
            file={"file_name": file_path.name, "content": file_obj},
            purpose="ocr",
        )

    resp = client.ocr.process(
        model=OCR_MODEL,
        document={"type": "document_id", "document_id": uploaded.id},
        include_image_base64=False,  # keep responses small
    )

    pages = getattr(resp, "pages", []) or []
    return [getattr(p, "markdown", "") for p in pages]


def preprocess_inputs(
    base_input: Path,
    files: list[Path],
    outdir: Path | None,
    overwrite: bool,
    app_data_dir: Path | None = None,
) -> Tuple[list[Tuple[Path, Path]], Path]:
    base_input = base_input.resolve()
    
    # Use app data directory for temp files if provided
    if app_data_dir:
        temp_parent = Path(app_data_dir).resolve() / "temp"
        source_name = base_input.name if base_input.is_dir() else base_input.stem
    else:
        # Fall back to original behavior
        if outdir:
            transcript_dir = Path(outdir).expanduser().resolve()
            temp_parent = transcript_dir.parent if transcript_dir.parent != transcript_dir else transcript_dir
        else:
            temp_parent = base_input.parent if base_input.is_dir() else base_input.parent
        source_name = base_input.name if base_input.is_dir() else base_input.parent.name
    
    temp_dir = temp_parent / f"_temp{source_name}"
    temp_dir.mkdir(parents=True, exist_ok=True)
    pairs: list[Tuple[Path, Path]] = []
    total = len(files)
    for idx, src in enumerate(files, start=1):
        rel = src.name if base_input.is_file() else src.resolve().relative_to(base_input.resolve())
        dest = temp_dir / rel
        dest = dest.with_suffix(".png")
        dest.parent.mkdir(parents=True, exist_ok=True)
        
        if dest.exists() and not overwrite:
            print(f"[prep] {idx}/{total} {src} (cached)")
            sys.stdout.flush()
        else:
            print(f"[prep] {idx}/{total} {src}")
            sys.stdout.flush()
            # Use the new preprocess function that takes temp_dir as directory, not file path
            processed_path = preprocess_image_for_ocr(str(src), str(dest.parent))
            # The preprocess function returns the full path to the PNG file
            if not processed_path or not os.path.exists(processed_path):
                raise RuntimeError(f"Failed to preprocess {src}")
            # Move the processed file to the expected destination if needed
            if processed_path != str(dest):
                import shutil
                shutil.move(processed_path, str(dest))
        pairs.append((src, dest))
    return pairs, temp_dir


def run_non_batch_flow(
    client: Mistral,
    base_input: Path,
    processed_files: list[Tuple[Path, Path]],
    outdir: Path | None,
    overwrite: bool
) -> None:
    processed = 0
    for original, processed_path in processed_files:
        try:
            out_txt = output_path_for(original, base_input, outdir)
            if out_txt.exists() and not overwrite:
                print(f"[skip] {original} -> {out_txt} (exists; use --overwrite to replace)")
                continue

            print(f"[ocr]  {original} ...")
            pages = [clean_markdown(md) for md in ocr_file(client, processed_path)]

            ensure_parent_dir(out_txt)
            with open(out_txt, "w", encoding="utf-8") as w:
                for md in pages:
                    w.write((md or "").rstrip() + "\n\n")

            print(f"[done] {out_txt}")
            processed += 1

        except Exception as e:
            print(f"[fail] {original} -> {e}")


def build_batch_jsonl(
    client: Mistral,
    processed_files: list[Tuple[Path, Path]],
    base_input: Path,
    out_path: Path
) -> Path:
    """
    Upload each file for OCR, get a signed URL, and write one JSONL line per file.
    custom_id holds the file's relative path (when directory input) or filename (single-file input).
    """
    base_input = base_input.resolve()
    with open(out_path, "w", encoding="utf-8") as f:
        for original, processed in processed_files:
            try:
                with processed.open("rb") as file_obj:
                    uploaded = client.files.upload(
                        file={"file_name": processed.name, "content": file_obj},
                        purpose="ocr",
                    )
            except Exception as exc:
                raise RuntimeError(f"Failed to upload {processed}: {exc}") from exc
            custom_id = str(original.name if base_input.is_file() else original.resolve().relative_to(base_input))
            try:
                signed_url = client.files.get_signed_url(file_id=uploaded.id).url
            except Exception as exc:
                raise RuntimeError("Failed to obtain signed URL") from exc
            line = {
                "custom_id": custom_id,
                "body": {
                    "document": {"type": "document_url", "document_url": signed_url},
                    "include_image_base64": False
                }
            }
            f.write(json.dumps(line) + "\n")
    return out_path


def wait_for_job(client: Mistral, job_id: str, interval: float = 2.0):
    while True:
        j = client.batch.jobs.get(job_id=job_id)
        done = (j.succeeded_requests or 0) + (j.failed_requests or 0)
        total = max(j.total_requests or 0, 1)
        print(f"Status={j.status}  {done}/{total} ({(done/total)*100:.1f}%)")
        if j.status in ("SUCCESS", "FAILED", "CANCELLED"):
            return j
        time.sleep(interval)


def parse_results_and_write_texts(results_jsonl: Path, base_input: Path, outdir: Path | None) -> None:
    written = 0
    with open(results_jsonl, "r", encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            rel = rec.get("custom_id")
            if not rel:
                continue
            resp_obj = rec.get("response")
            body = {}
            if isinstance(resp_obj, dict):
                body = resp_obj.get("body") or {}
            pages = _extract_markdown_sections(body)
            text = "\n\n".join([clean_markdown(section) for section in pages]).strip()

            # Build output path using the same helper semantics
            src = (base_input / rel) if base_input.is_dir() else base_input
            out_txt = output_path_for(src, base_input, outdir)
            ensure_parent_dir(out_txt)
            with open(out_txt, "w", encoding="utf-8") as w:
                w.write(text + ("\n" if text else ""))

            print(f"[write] {out_txt}")
            written += 1

    print(f"Parsed & wrote {written} transcript(s) from batch results.")


def run_chunked_batch_flow(
    client: Mistral,
    base_input: Path,
    todo_files: list[Path],
    outdir: Path | None,
    batch_size: int,
    batch_file: Path | None,
    poll_interval: float,
    app_data_dir: Path | None,
    overwrite: bool,
) -> None:
    """Process files in chunks with detailed logging (no state persistence)"""
    
    print(f"[batch] Processing {len(todo_files)} files in batches of {batch_size}")
    sys.stdout.flush()
    
    # Split into chunks
    file_chunks = chunk_files(todo_files, batch_size)
    total_chunks = len(file_chunks)
    total_processed = 0
    
    for chunk_idx, current_chunk in enumerate(file_chunks, 1):
        batch_label = f"Batch {chunk_idx}/{total_chunks}"
        print(f"[batch] === Starting {batch_label} ({len(current_chunk)} files) ===")
        sys.stdout.flush()
        
        try:
            # Preprocess this chunk
            print(f"[batch] [{batch_label}] Preprocessing {len(current_chunk)} files...")
            sys.stdout.flush()
            preprocessed, temp_dir = preprocess_inputs(
                base_input,
                current_chunk,
                outdir,
                overwrite,
                app_data_dir,
            )
            
            # Run batch processing for this chunk
            print(f"[batch] [{batch_label}] Starting Mistral OCR processing...")
            sys.stdout.flush()
            app_dir = Path(user_data_dir("TranscribeAI", False))
            app_dir.mkdir(parents=True, exist_ok=True)
            batch_file_chunk = batch_file or app_dir / f"ocr_batch_chunk_{chunk_idx}.jsonl"
            
            run_batch_flow(
                client=client,
                base_input=base_input,
                processed_files=preprocessed,
                outdir=outdir,
                batch_file=batch_file_chunk,
                poll_interval=poll_interval,
            )
            
            # Clean up temp files for this chunk
            try:
                if temp_dir and temp_dir.exists():
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    print(f"[batch] [{batch_label}] Cleaned up temporary files")
            except Exception as e:
                print(f"[batch] [{batch_label}] Warning: Could not clean up temp files: {e}")
            
            # Report completion with details
            files_processed = len(current_chunk)
            total_processed += files_processed
            print(f"[batch] [{batch_label}] [OK] COMPLETED - Processed {files_processed} files ({total_processed}/{len(todo_files)} total)")
            sys.stdout.flush()
            print(f"[batch] [{batch_label}] Progress: {(total_processed/len(todo_files)*100):.1f}% complete")
            sys.stdout.flush()
            
        except KeyboardInterrupt:
            print(f"[batch] [{batch_label}] [ERR] Processing interrupted. {total_processed}/{len(todo_files)} files completed.")
            sys.stdout.flush()
            raise
        except Exception as e:
            print(f"[batch] [{batch_label}] [ERR] Error: {e}")
            sys.stdout.flush()
            raise
    
    print(f"[batch] [DONE] Successfully processed all {len(todo_files)} files in {total_chunks} batches!")
    sys.stdout.flush()


def run_batch_flow(
    client: Mistral,
    base_input: Path,
    processed_files: list[Tuple[Path, Path]],
    outdir: Path | None,
    batch_file: Path | None,
    poll_interval: float,
) -> None:
    app_dir = Path(user_data_dir("TranscribeAI", False))
    app_dir.mkdir(parents=True, exist_ok=True)
    batch_file = (batch_file or app_dir / "ocr_batch.jsonl").resolve()
    results_path = app_dir / "ocr_results.jsonl"

    print(f"[batch] Preparing JSONL: {batch_file}")
    sys.stdout.flush()
    build_batch_jsonl(client, processed_files, base_input, batch_file)

    print("[batch] Uploading JSONL...")
    sys.stdout.flush()
    up = client.files.upload(
        file={"file_name": batch_file.name, "content": open(batch_file, "rb")},
        purpose="batch",
    )

    print("[batch] Creating job...")
    sys.stdout.flush()
    job = client.batch.jobs.create(
        input_files=[up.id],
        model=OCR_MODEL,
        endpoint="/v1/ocr",
        metadata={"job_type": "ocr"},
    )
    print(f"[batch] Job ID: {job.id}")
    sys.stdout.flush()

    print("[batch] Waiting for completion...")
    sys.stdout.flush()
    job = wait_for_job(client, job.id, interval=poll_interval)
    if job.status != "SUCCESS":
        raise RuntimeError(f"Batch ended with status {job.status}")

    print("[batch] Downloading results...")
    sys.stdout.flush()
    resp = client.files.download(file_id=job.output_file)

    # Try to persist results to a deterministic filename
    try:
        content = getattr(resp, "content", None)
        if content:
            with open(results_path, "wb") as w:
                w.write(content)
        else:
            # Fallback: pick the most recent *.jsonl that isn't our batch_file
            candidates = [p for p in Path(".").glob("*.jsonl") if p.resolve() != batch_file]
            if not candidates:
                raise RuntimeError("Could not locate results JSONL on disk.")
            results_path = max(candidates, key=lambda p: p.stat().st_mtime).resolve()
    except httpx.ResponseNotRead:
        resp.read()
        with open(results_path, "wb") as w:
            w.write(resp.content or b"")
    except Exception:
        candidates = [p for p in Path(".").glob("*.jsonl") if p.resolve() != batch_file]
        if not candidates:
            raise RuntimeError("Could not locate results JSONL on disk.")
        results_path = max(candidates, key=lambda p: p.stat().st_mtime).resolve()

    print(f"[batch] Results at: {results_path}")
    parse_results_and_write_texts(results_path, base_input, outdir)
    try:
        if batch_file.exists():
            batch_file.unlink()
    except Exception:
        pass
    try:
        if results_path.exists():
            results_path.unlink()
    except Exception:
        pass


def main() -> None:
    args = parse_args()

    base_input = resolve_input_path(args.input_path)
    api_key = os.getenv("MISTRAL_API_KEY")
    if not api_key:
        raise ValueError("MISTRAL_API_KEY not set in environment variables or .env file.")

    client = Mistral(api_key=api_key)

    original_files = list(iter_files(base_input, recursive=args.recursive))
    # Sort files alphabetically for consistent processing order like Gemini
    original_files.sort(key=lambda f: f.name.lower())
    if not original_files:
        if base_input.is_dir():
            raise FileNotFoundError(
                f"No supported files found under directory: {base_input}\n"
                f"Supported extensions: {sorted(SUPPORTED_EXTS)}"
            )
        raise FileNotFoundError(f"No files to process for: {base_input}")

    print(f"Found {len(original_files)} file(s) to OCR.")

    outdir_path = Path(args.outdir).expanduser().resolve() if args.outdir else None

    todo_files: list[Path] = []
    for f in original_files:
        out_txt = output_path_for(f, base_input, outdir_path)
        if out_txt.exists() and not args.overwrite:
            print(f"[skip] transcript exists: {out_txt}")
            continue
        todo_files.append(f)

    if not todo_files:
        print("[batch] Nothing to transcribe; all transcripts already exist.")
        sys.stdout.flush()
        return

    try:
        if args.batch:
            # Use chunked batch processing instead of preprocessing everything at once
            run_chunked_batch_flow(
                client=client,
                base_input=base_input,
                todo_files=todo_files,
                outdir=outdir_path,
                batch_size=getattr(args, 'batch_size', 10),
                batch_file=args.batch_file,
                poll_interval=args.poll_interval,
                app_data_dir=args.app_data_dir,
                overwrite=args.overwrite,
            )
        else:
            # Non-batch flow: preprocess all files then process individually
            print(f"[prep] Preprocessing {len(todo_files)} files...")
            sys.stdout.flush()
            preprocessed, temp_dir = preprocess_inputs(
                base_input,
                todo_files,
                outdir_path,
                args.overwrite,
                args.app_data_dir,
            )
            cleanup_temp = True
            try:
                run_non_batch_flow(
                    client=client,
                    base_input=base_input,
                    processed_files=preprocessed,
                    outdir=outdir_path,
                    overwrite=args.overwrite,
                )
            except Exception:
                cleanup_temp = False
                raise
            finally:
                if cleanup_temp:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                else:
                    print(f"[warn] Preserving temporary artifacts at: {temp_dir}")
                    sys.stdout.flush()
    except KeyboardInterrupt:
        print("[ERR] Processing interrupted by user.")
        sys.stdout.flush()
        sys.exit(1)
    except Exception as e:
        print(f"[ERR] Error: {e}")
        sys.stdout.flush()
        sys.exit(1)

    print("[OK] All processing completed successfully!")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
