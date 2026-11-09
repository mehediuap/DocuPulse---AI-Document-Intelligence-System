import type { GoogleGenAI } from '@google/genai';
import { createGoogleGenAIClient } from '../extraction/googleGenAIConfig.ts';

export const OCR_LOW_CONFIDENCE_THRESHOLD = 0.65;

export interface OcrResult {
  text: string;
  confidence: number | null;
  engineUsed: 'gemini_vision' | 'tesseract' | 'fallback_diagnostic';
  wordCount: number;
  lineCount: number;
  tested: boolean;
  warnings?: string[];
}

export interface OcrOptions {
  filename?: string;
  mimeType?: string;
  isScanned?: boolean;
}

interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}

type TesseractWorkerFactory = () => Promise<TesseractWorker>;
type GeminiOcrTranscriber = (mimeType: string, base64Data: string) => Promise<string | undefined>;

export class OcrService {
  private static instance: OcrService;
  private ai: GoogleGenAI | null = null;
  private workerPromise: Promise<TesseractWorker> | null = null;

  public constructor(
    private readonly createTesseractWorker: TesseractWorkerFactory = async () => {
      const { createWorker, PSM } = await import('tesseract.js');
      const env = getRuntimeEnvironment();
      const workerOptions: Record<string, string> = {};
      if (env.TESSERACT_LANG_PATH) workerOptions.langPath = env.TESSERACT_LANG_PATH;
      if (env.TESSERACT_WORKER_PATH) workerOptions.workerPath = env.TESSERACT_WORKER_PATH;
      if (env.TESSERACT_CORE_PATH) workerOptions.corePath = env.TESSERACT_CORE_PATH;
      if (typeof process !== 'undefined' && process.versions?.node) {
        const tempDirectory = (env.TEMP || env.TMPDIR || env.TMP || process.cwd())
          .replace(/[\\/]+$/, '');
        const cachePath = env.TESSERACT_CACHE_PATH || `${tempDirectory}/docupulse-tesseract`;
        const filesystemPackage = 'node:fs/promises';
        const { mkdir } = await import(/* @vite-ignore */ filesystemPackage);
        await mkdir(cachePath, { recursive: true });
        workerOptions.cachePath = cachePath;
      } else if (env.TESSERACT_CACHE_PATH) {
        workerOptions.cachePath = env.TESSERACT_CACHE_PATH;
      }
      const worker = await createWorker('eng', 1, workerOptions);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      return worker;
    },
    private readonly transcribeWithGemini?: GeminiOcrTranscriber
  ) {}

  public static getInstance(): OcrService {
    if (!OcrService.instance) OcrService.instance = new OcrService();
    return OcrService.instance;
  }

  public async performOcr(
    data: Uint8Array | string,
    options: OcrOptions = {},
    fallbackImage?: Uint8Array | readonly Uint8Array[]
  ): Promise<OcrResult> {
    const warnings: string[] = [];
    const env = getRuntimeEnvironment();
    const configuredProvider = env.OCR_PROVIDER?.trim().toLowerCase();
    const provider = configuredProvider || 'auto';

    if (!['auto', 'gemini', 'tesseract', 'mock'].includes(provider)) {
      throw new Error('OCR_PROVIDER must be one of: auto, gemini, tesseract, mock.');
    }

    if (provider === 'mock') {
      warnings.push('OCR provider is disabled in mock mode; no image text was inferred.');
      return this.createResult(this.generateDiagnosticNotice(options), 0, 'fallback_diagnostic', warnings);
    }

    let best: { text: string; confidence: number | null } | null = null;
    const image = typeof data === 'string'
      ? Buffer.from(data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data, 'base64')
      : Buffer.from(data);
    const candidates = [image];
    if (fallbackImage) {
      const fallbacks = Array.isArray(fallbackImage) ? fallbackImage : [fallbackImage];
      candidates.push(...fallbacks.map(candidate => Buffer.from(candidate)));
    }

    try {
      const worker = await this.getTesseractWorker();
      for (const [index, candidate] of candidates.entries()) {
        try {
          const result = await worker.recognize(candidate);
          const confidence = Number.isFinite(result.data.confidence)
            ? Math.max(0, Math.min(1, result.data.confidence / 100))
            : null;
          if (!best || (confidence ?? -1) > (best.confidence ?? -1)) {
            best = { text: result.data.text.trim(), confidence };
          }
          if (confidence !== null && confidence >= OCR_LOW_CONFIDENCE_THRESHOLD &&
            (index === 0 || confidence >= 0.75) && result.data.text.trim()) break;
        } catch {
          warnings.push('OCR failed on an image variant; trying the next available variant.');
        }
      }
    } catch (error) {
      this.workerPromise = null;
      warnings.push(`Tesseract OCR failed: ${errorMessage(error)}`);
    }

    const confidence = best?.confidence ?? null;
    const isLowConfidence = confidence === null || confidence < OCR_LOW_CONFIDENCE_THRESHOLD;
    if (isLowConfidence) {
      warnings.push(
        confidence === null
          ? 'Local OCR confidence was unavailable; manual review is recommended.'
          : `Local OCR confidence (${Math.round(confidence * 100)}%) is below the ${Math.round(OCR_LOW_CONFIDENCE_THRESHOLD * 100)}% review threshold.`
      );
    }

    if (isLowConfidence && provider !== 'tesseract' && canUseGeminiFallback(env, this.transcribeWithGemini)) {
      try {
        const base64Data = image.toString('base64');
        const transcriber = this.transcribeWithGemini;
        const text = transcriber
          ? await transcriber(resolveMimeType(options.mimeType), base64Data)
          : await this.transcribeImageWithGemini(resolveMimeType(options.mimeType), base64Data, env);
        const transcript = text?.trim();
        if (transcript) {
          warnings.push('Gemini Vision supplied the low-confidence local OCR fallback; its transcript is not independently confidence-calibrated.');
          return this.createResult(transcript, confidence, 'gemini_vision', warnings);
        }
        warnings.push('Gemini Vision returned no OCR text for the low-confidence page.');
      } catch (error) {
        warnings.push(`Gemini OCR fallback failed: ${errorMessage(error)}`);
      }
    }

    if (!best) warnings.push('Tesseract could not complete OCR on any image variant.');
    else if (!best.text) warnings.push('Tesseract completed but found no readable text.');
    if (!best?.text) warnings.push('OCR did not produce text; no invoice values were inferred.');

    return this.createResult(
      best?.text || this.generateDiagnosticNotice(options),
      confidence,
      'tesseract',
      warnings
    );
  }

  private async transcribeImageWithGemini(
    mimeType: string,
    base64Data: string,
    env: Record<string, string | undefined>
  ): Promise<string | undefined> {
    const ai = this.ai ||= createGoogleGenAIClient();
    if (!ai) {
      throw new Error('Gemini API key is invalid or unavailable.');
    }
    const response = await ai.models.generateContent({
      model: env.GEMINI_OCR_MODEL || 'gemini-3.1-flash-lite',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          {
            text: 'Transcribe visible document text verbatim. Do not infer obscured or missing values. Preserve page breaks, labels, dates, currency codes, and amounts.',
          },
        ],
      }],
    });
    return response.text;
  }

  private async getTesseractWorker(): Promise<TesseractWorker> {
    if (!this.workerPromise) {
      this.workerPromise = this.createTesseractWorker();
    }
    return this.workerPromise;
  }

  public async close(): Promise<void> {
    if (!this.workerPromise) return;
    const worker = await this.workerPromise;
    this.workerPromise = null;
    await worker.terminate();
  }

  private createResult(
    text: string,
    confidence: number | null,
    engineUsed: OcrResult['engineUsed'],
    warnings: string[]
  ): OcrResult {
    return {
      text,
      confidence,
      engineUsed,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      lineCount: text.split(/\r?\n/).filter(line => line.trim()).length,
      tested: true,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  private generateDiagnosticNotice(options: OcrOptions): string {
    return `[OCR TEXT UNAVAILABLE]\n` +
      `File: ${options.filename || 'Scanned_Doc'}\n` +
      `Detected Format: ${options.mimeType || 'Raster Image'}\n` +
      `No text was inferred because OCR could not produce a transcription.`;
  }
}

function getRuntimeEnvironment(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : process.env;
}

function resolveMimeType(mimeType = 'application/octet-stream'): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('pdf')) return 'application/pdf';
  if (normalized.includes('png')) return 'image/png';
  if (normalized.includes('tiff')) return 'image/tiff';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'image/jpeg';
  return mimeType;
}

function canUseGeminiFallback(
  env: Record<string, string | undefined>,
  transcriber?: GeminiOcrTranscriber
): boolean {
  const apiKey = env.GEMINI_API_KEY?.trim();
  return Boolean(transcriber || (apiKey && apiKey !== 'MY_GEMINI_API_KEY'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ocrService = OcrService.getInstance();
