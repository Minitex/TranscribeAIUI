#!/usr/bin/env python3
"""
Preprocess a single image for OCR.

This script processes one image file, applying grayscale conversion and adaptive thresholding,
then saves the result as a PNG in the specified output folder.
"""

import os
import sys
import io
import cv2
import numpy as np

# Wrap stdout to UTF-8 on Windows to avoid code page errors
if sys.platform.startswith("win"):
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer,
        encoding="utf-8",
        errors="replace",
        line_buffering=True
    )

VALID_EXTS = ('.tif', '.tiff', '.png', '.jpg', '.jpeg')

def preprocess_image_for_ocr(input_path, output_path, blur_ksize=3, block_size=15, c=10, simple=True):
    """
    Process an image for OCR. Converts to grayscale and applies preprocessing.
    """
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

    if simple:
        processed = gray
    else:
        # ensure odd blur kernel
        if blur_ksize % 2 == 0:
            blur_ksize += 1
        blurred = cv2.medianBlur(gray, blur_ksize)
        thresh = cv2.adaptiveThreshold(
            blurred,
            maxValue=255,
            adaptiveMethod=cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            thresholdType=cv2.THRESH_BINARY,
            blockSize=block_size,
            C=c
        )
        kernel = np.ones((1, 1), np.uint8)
        processed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    # Ensure output folder exists, then write PNG
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    success = cv2.imwrite(output_path, processed)

    if success:
        print(f"[OK] Page preprocessed {output_path}")
    else:
        print(f"[ERR] Error: Failed to preprocess page {output_path}")

    return success

def print_instructions():
    """Print usage instructions."""
    print(
        "\nUsage Instructions for preprocess_to_jpeg.py\n"
        "This script processes a single image and saves the processed PNG to the output folder.\n"
        "Provide the path to the image file and the destination folder.\n\n"
        "Required Arguments:\n"
        "  input_file     → Path to the image to process.\n"
        "  output_folder  → Folder where the processed PNG image will be saved.\n\n"
        "Optional Arguments:\n"
        "  --simple                → Convert image to grayscale only.\n"
        "  --blur <size>           → Median blur kernel size (default: 3, must be odd).\n"
        "  --blockSize <size>      → Adaptive thresholding block size (default: 15, must be odd and >1).\n"
        "  --C <value>             → Constant subtracted in adaptive thresholding (default: 10).\n"
        "  -h, --help              → Show this help message and exit.\n\n"
        "Example:\n"
        "  python3 preprocess_to_jpeg.py /path/to/input.jpg /path/to/output_folder --simple\n"
    )

def main():
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("input_file", nargs="?", help="Path to the image file to process.")
    parser.add_argument("output_folder", nargs="?", help="Folder for the processed PNG image.")
    parser.add_argument("--blur", type=int, default=3,
                        help="Kernel size for median blur (default: 3, must be odd)")
    parser.add_argument("--blockSize", type=int, default=15,
                        help="Adaptive thresholding block size (default: 15, must be odd and >1)")
    parser.add_argument("--C", type=int, default=10,
                        help="Constant subtracted in adaptive thresholding (default: 10)")
    parser.add_argument("--simple", action="store_true",
                        help="Convert image to grayscale only")
    parser.add_argument("-h", "--help", action="store_true", help="Show usage instructions")

    args = parser.parse_args()
    if args.help or not args.input_file or not args.output_folder:
        print_instructions()
        return

    input_path = args.input_file
    output_folder = args.output_folder
    base = os.path.splitext(os.path.basename(input_path))[0]
    output_path = os.path.join(output_folder, f"{base}.png")

    preprocess_image_for_ocr(
        input_path,
        output_path,
        blur_ksize=args.blur,
        block_size=args.blockSize,
        c=args.C,
        simple=args.simple
    )

if __name__ == "__main__":
    main()