#!/usr/bin/env python3
"""
Transcribe a single image using Gemini API, with document context.
Requires IMAGE_PROMPT environment variable; will abort if missing.
"""

import os
import sys
import time
import argparse
import logging
import PIL.Image
import google.generativeai as genai

# Configuration constants
MAX_RETRIES = 3
RETRY_DELAY = 5

VALID_EXTS = ('.png', '.jpg', '.jpeg', '.tif', '.tiff')

# Context folder (optional)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONTEXT_FOLDER = os.path.join(SCRIPT_DIR, "OcrDocumentContext")


def load_contexts():
    global_ctx = ""
    ctx_map = {}
    if os.path.isdir(CONTEXT_FOLDER):
        all_path = os.path.join(CONTEXT_FOLDER, "ALL_DOCUMENT_CONTEXT.txt")
        if os.path.exists(all_path):
            with open(all_path, "r", encoding="utf-8") as f:
                global_ctx = f.read().strip()
            print("Using global context.")
        for fname in os.listdir(CONTEXT_FOLDER):
            if fname.lower().endswith("_context.txt") and fname.lower() != "all_document_context.txt":
                base = os.path.splitext(fname)[0].replace("_context", "")
                with open(os.path.join(CONTEXT_FOLDER, fname), "r", encoding="utf-8") as f:
                    ctx_map[base] = f.read().strip()
        if ctx_map:
            print(f"Loaded individual context for {len(ctx_map)} images.")
    else:
        print("Context folder not found; proceeding without context.")
    return global_ctx, ctx_map


def build_final_prompt(image_basename, env_prompt, global_context, context_mapping):
    if not env_prompt:
        print("[ERR] IMAGE_PROMPT environment variable not set or empty. Aborting.")
        return None

    context_parts = []
    if global_context:
        context_parts.append(global_context)
    if image_basename in context_mapping:
        context_parts.append(context_mapping[image_basename])

    if context_parts:
        context_text = "\n".join(context_parts)
        return f"Given the context: {context_text}\n{env_prompt}"
    else:
        return env_prompt


def print_instructions():
    print(
        "\nUsage for transcribe_single_image.py\n"
        "Process a single PNG (or supported) image and save transcription as .txt.\n\n"
        "  python3 transcribe_single_image.py /path/to/image.png /path/to/output_folder --model <model_name>\n"
    )


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("input_file",     nargs="?", help="Path to the image file.")
    parser.add_argument("output_folder",  nargs="?", help="Folder for the output .txt.")
    parser.add_argument("--model",        help="Gemini model to use", required=True)
    parser.add_argument("-h", "--help",   action="store_true", help="Show help")
    args = parser.parse_args()

    if args.help or not args.input_file or not args.output_folder or not args.model:
        print_instructions()
        return

    input_path = args.input_file
    output_dir = args.output_folder
    model_name = args.model

    if not os.path.isfile(input_path) or os.path.splitext(input_path)[1].lower() not in VALID_EXTS:
        print(f"[ERR] Unsupported or missing input file: {input_path}")
        return

    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("[ERR] API key not set. Please open Settings and enter your Gemini API key.")
        sys.exit(1)

    image_prompt_env = os.getenv("IMAGE_PROMPT", "").strip()

    global_ctx, ctx_map = load_contexts()
    prompt = build_final_prompt(os.path.splitext(os.path.basename(input_path))[0], image_prompt_env, global_ctx, ctx_map)
    if not prompt:
        sys.exit(1)

    logging.getLogger("google").setLevel(logging.CRITICAL)
    logging.getLogger("absl").setLevel(logging.CRITICAL)
    genai.configure(api_key=api_key)

    os.makedirs(output_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(input_path))[0]
    output_path = os.path.join(output_dir, f"{base}.txt")

    model = genai.GenerativeModel(model_name)

    success = False
    for attempt in range(MAX_RETRIES):
        try:
            with PIL.Image.open(input_path) as img:
                response = model.generate_content([prompt, img], stream=True)
                if not response:
                    raise ValueError("No response from API")

                with open(output_path, "w", encoding="utf-8") as out_f:
                    for chunk in response:
                        out_f.write(chunk.text)

            if os.path.getsize(output_path) > 0:
                print(f"[OK] Transcription saved: {output_path}")
                try:
                    os.remove(input_path)
                    print(f"[OK] Removed temp image: {input_path}")
                except Exception as e:
                    print(f"[WARN] Failed to remove temp image: {e}")
                success = True
                break
            else:
                raise ValueError("Empty transcription file")
        except Exception as e:
            print(f"[ERR] ERROR (Attempt {attempt+1}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES - 1:
                delay = RETRY_DELAY * (2 ** attempt)
                print(f"Retrying in {delay}s...")
                time.sleep(delay)

    if not success:
        print("[ERR] Failed to transcribe image after retries.")


if __name__ == "__main__":
    main()