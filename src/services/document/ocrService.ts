import type { GoogleGenAI } from '@google/genai';
import { createGoogleGenAIClient } from '../extraction/googleGenAIConfig.ts';

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
      const { createWorker } = await import('tesseract.js');
      const env = getRuntimeEnvironment();
      const workerOptions: Record<string, string> = {};
      if (env.TESSERACT_LANG_PATH) workerOptions.langPath = env.TESSERACT_LANG_PATH;
      if (env.TESSERACT_WORKER_PATH) workerOptions.workerPath = env.TESSERACT_WORKER_PATH;
      if (env.TESSERACT_CORE_PATH) workerOptions.corePath = env.TESSERACT_CORE_PATH;
      if (env.TESSERACT_CACHE_PATH) workerOptions.cachePath = env.TESSERACT_CACHE_PATH;
      return createWorker('eng', 1, workerOptions);
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
    fallbackImage?: Uint8Array
  ): Promise<OcrResult> {
    const warnings: string[] = [];
    const env = getRuntimeEnvironment();
    const configuredProvider = env.OCR_PROVIDER?.trim().toLowerCase();
    const provider = configuredProvider ||
      (typeof process === 'undefined' || env.EXTRACTION_MODE === 'mock' ? 'mock' : 'auto');

    if (!['auto', 'gemini', 'tesseract', 'mock'].includes(provider)) {
      throw new Error('OCR_PROVIDER must be one of: auto, gemini, tesseract, mock.');
    }

    if (provider === 'mock') {
      warnings.push('OCR provider is disabled in mock mode; no image text was inferred.');
      return this.createResult(this.generateDiagnosticNotice(options), 0, 'fallback_diagnostic', warnings);
    }

    const isPdf = options.mimeType?.toLowerCase().includes('pdf') === true;
    const shouldTryGemini = provider === 'gemini' || provider === 'auto';
    if (shouldTryGemini) {
      try {
        const base64Data = typeof data === 'string'
          ? (data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data)
          : Buffer.from(data).toString('base64');
        if (base64Data.length <= 50) throw new Error('OCR input is empty or too small.');

        let text: string | undefined;
        if (this.transcribeWithGemini) {
          text = await this.transcribeWithGemini(resolveMimeType(options.mimeType), base64Data);
        } else {
          const ai = this.ai ||= createGoogleGenAIClient();
          if (!ai) {
            warnings.push('Gemini OCR was unavailable because no Gemini API key or Vertex AI credentials are configured.');
          } else {
            const response = await ai.models.generateContent({
              model: env.GEMINI_OCR_MODEL || 'gemini-3.1-flash-lite',
              contents: [{
                role: 'user',
                parts: [
                  {
                    inlineData: {
                      mimeType: resolveMimeType(options.mimeType),
                      data: base64Data,
                    },
                  },
                  {
                    text: 'Transcribe visible document text verbatim. Do not infer obscured or missing values. Preserve page breaks, labels, dates, currency codes, and amounts.',
                  },
                ],
              }],
            });
            text = response.text;
          }
        }

        text = text?.trim();
        if (text) {
          warnings.push('Gemini Vision does not provide calibrated OCR confidence; extracted fields require review.');
          return this.createResult(text, null, 'gemini_vision', warnings);
        }
        warnings.push('Gemini Vision returned no OCR text.');
      } catch (error) {
        warnings.push(`Gemini OCR failed: ${errorMessage(error)}`);
      }
    }

    const shouldTryTesseract = provider === 'tesseract' || provider === 'auto' || provider === 'gemini';
    if (!isPdf && shouldTryTesseract) {
      try {
        const image = typeof data === 'string'
          ? Buffer.from(data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data, 'base64')
          : Buffer.from(data);
        const worker = await this.getTesseractWorker();
        const candidates = [image];
        if (fallbackImage) candidates.push(Buffer.from(fallbackImage));
        let best: { text: string; confidence: number | null } | null = null;

        for (const candidate of candidates) {
          try {
            const result = await worker.recognize(candidate);
            const text = result.data.text.trim();
            const confidence = Number.isFinite(result.data.confidence)
              ? Math.max(0, Math.min(1, result.data.confidence / 100))
              : null;
            if (text && (!best || (confidence ?? 0) > (best.confidence ?? 0))) {
              best = { text, confidence };
            }
            if (confidence !== null && confidence >= 0.75) break;
          } catch {
            warnings.push('OCR failed on an image variant; trying the next available variant.');
          }
        }

        if (best) {
          if (best.confidence !== null && best.confidence < 0.65 && fallbackImage) {
            warnings.push('OCR confidence remained low after image enhancement; manual review is recommended.');
          }
          return this.createResult(best.text, best.confidence, 'tesseract', warnings);
        }
        warnings.push('Tesseract completed but found no readable text.');
      } catch (error) {
        this.workerPromise = null;
        warnings.push(`Tesseract OCR failed: ${errorMessage(error)}`);
      }
    } else if (isPdf && shouldTryTesseract) {
      warnings.push('Local Tesseract does not process PDF containers; render scanned pages to images before OCR.');
    }

    warnings.push('OCR did not produce text; no invoice values were inferred.');
    return this.createResult(this.generateDiagnosticNotice(options), 0, 'fallback_diagnostic', warnings);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ocrService = OcrService.getInstance();
