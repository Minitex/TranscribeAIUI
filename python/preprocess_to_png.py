#!/usr/bin/env python3
"""Preprocess a single image for OCR by converting it to grayscale."""

import os
import sys
import io
import cv2

# Wrap stdout to UTF-8 on Windows to avoid code page errors
if sys.platform.startswith("win"):
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer,
        encoding="utf-8",
        errors="replace",
        line_buffering=True
    )

VALID_EXTS = ('.tif', '.tiff', '.png', '.jpg', '.jpeg')

def preprocess_image_for_ocr(input_path, output_path):
    """Convert an image to grayscale and write it to disk."""
    if not os.path.isfile(input_path):
        print(f"[ERR] Error: Input file not found: {input_path}")
        return False

    ext = os.path.splitext(input_path)[1].lower()
    if ext not in VALID_EXTS:
        print(f"[ERR] Error: Unsupported file extension: {input_path}")
        return False

    image = cv2.imread(input_path)
    if image is None:
        print(f"[ERR] Error: Unable to load image {input_path}")
        return False

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Ensure output folder exists, then write PNG
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    success = cv2.imwrite(output_path, gray)

    if success:
        print(f"[OK] Page preprocessed {output_path}")
    else:
        print(f"[ERR] Error: Failed to preprocess page {output_path}")

    return success

def print_instructions():
    """Print usage instructions."""
    print(
        "\nUsage Instructions for preprocess_to_png.py\n"
        "This script processes a single image, converts it to grayscale, and saves the processed\n"
        "PNG to the output folder. Provide the path to the image file and the destination folder.\n\n"
        "Required Arguments:\n"
        "  input_file     → Path to the image to process.\n"
        "  output_folder  → Folder where the processed PNG image will be saved.\n\n"
        "  -h, --help              → Show this help message and exit.\n\n"
        "Example:\n"
        "  python3 preprocess_to_png.py /path/to/input.jpg /path/to/output_folder\n"
    )

def main():
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("input_file", nargs="?", help="Path to the image file to process.")
    parser.add_argument("output_folder", nargs="?", help="Folder for the processed PNG image.")
    parser.add_argument("-h", "--help", action="store_true", help="Show usage instructions")

    args = parser.parse_args()
    if args.help or not args.input_file or not args.output_folder:
        print_instructions()
        return

    input_path = args.input_file
    output_folder = args.output_folder
    base = os.path.splitext(os.path.basename(input_path))[0]
    output_path = os.path.join(output_folder, f"{base}.png")

    preprocess_image_for_ocr(input_path, output_path)

if __name__ == "__main__":
    main()
