// Cross-cutting renderer types shared by App, the views, and the transcribers.

export type PathPickerTarget = {
  target: 'audio-input' | 'audio-output' | 'image-input' | 'image-output' | 'copy-images';
  allowFiles: boolean;
};

export type MistralBatchStats = {
  inputPath: string;
  uploaded: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
};

export type BatchCostEstimateData = {
  unit: 'page' | 'minute';
  fileCount: number;
  quantity: number;
};

export type MistralBatchQueueRow = MistralBatchStats & {
  outputDir: string;
  modelName: string;
  oldestPendingStartMs: number | null;
  checkBackAtMs: number | null;
};

export type OcrReviewBlock = {
  type: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  text: string;
};

export type OcrReviewWord = {
  text: string;
  confidence: number;
};

export type OcrReviewPage = {
  index: number;
  dimensions: { dpi?: number; width?: number; height?: number };
  blocks: OcrReviewBlock[];
  words: OcrReviewWord[];
  averageConfidence?: number;
  minimumConfidence?: number;
};

export type OcrReviewData = {
  sourceImagePath: string;
  pages: OcrReviewPage[];
};

export type AudioReviewSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export type AudioReviewData = {
  sourceAudioPath: string | null;
  segments: AudioReviewSegment[];
};
