const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_PREPROCESSING_DIMENSION = 4_000;
const MAX_PREPROCESSING_PIXELS = 12_000_000;
const SKEW_SAMPLE_WIDTH = 1_000;
const SKEW_SEARCH_LIMIT_DEGREES = 7;

export interface OcrImageVariants {
  original: Uint8Array;
  deskewedOriginal: Uint8Array;
  enhanced: Uint8Array;
  highContrast: Uint8Array;
  warning?: string;
}

export async function createOcrImageVariants(
  input: Uint8Array,
  page?: number
): Promise<OcrImageVariants> {
  if (typeof window !== 'undefined') {
    return { original: input, deskewedOriginal: input, enhanced: input, highContrast: input };
  }

  const sharpPackage = 'sharp';
  const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
  const sourceImage = page === undefined
    ? input
    : new Uint8Array(await sharp(input, {
      page,
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'error',
    }).png().toBuffer());
  const image = sharp(sourceImage, {
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: 'error',
  });
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    throw new Error(`Image dimensions are missing or exceed the ${MAX_IMAGE_PIXELS}-pixel OCR limit.`);
  }

  try {
    const scale = Math.min(
      metadata.width < 1_200 ? 2 : 1,
      MAX_PREPROCESSING_DIMENSION / metadata.width,
      MAX_PREPROCESSING_DIMENSION / metadata.height,
      Math.sqrt(MAX_PREPROCESSING_PIXELS / (metadata.width * metadata.height))
    );
    const width = Math.max(1, Math.round(metadata.width * scale));
    const base = sharp(sourceImage, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'error',
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .grayscale()
      .resize({ width, withoutEnlargement: false })
      .median(3)
      .normalize()
      .sharpen();

    const skewSample = await base.clone()
      .resize({
        width: SKEW_SAMPLE_WIDTH,
        height: SKEW_SAMPLE_WIDTH,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const correction = estimateDeskewAngle(
      skewSample.data,
      skewSample.info.width,
      skewSample.info.height
    );
    const deskewedOriginal = correction === 0
      ? sourceImage
      : new Uint8Array(await sharp(sourceImage)
        .rotate(-correction, { background: '#ffffff' })
        .png()
        .toBuffer());
    const deskewed = correction === 0
      ? base
      : sharp(sourceImage, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' })
        .rotate()
        .flatten({ background: '#ffffff' })
        .grayscale()
        .resize({ width, withoutEnlargement: false })
        .median(3)
        .normalize()
        .sharpen()
        .rotate(-correction, { background: '#ffffff' });

    const enhanced = await deskewed.png().toBuffer();
    const enhancedRaw = await sharp(enhanced, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'error',
    }).grayscale().raw().toBuffer({ resolveWithObject: true });
    const thresholded = adaptiveThreshold(
      enhancedRaw.data,
      enhancedRaw.info.width,
      enhancedRaw.info.height
    );

    const highContrast = await sharp(thresholded, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'error',
      raw: {
        width: enhancedRaw.info.width,
        height: enhancedRaw.info.height,
        channels: 1,
      },
    })
      .png()
      .toBuffer();

    return {
      original: sourceImage,
      deskewedOriginal,
      enhanced: new Uint8Array(enhanced),
      highContrast: new Uint8Array(highContrast),
    };
  } catch {
    return {
      original: sourceImage,
      deskewedOriginal: sourceImage,
      enhanced: sourceImage,
      highContrast: sourceImage,
      warning: 'Image preprocessing failed; OCR is using the original image.',
    };
  }
}

function estimateDeskewAngle(
  pixels: Uint8Array,
  width: number,
  height: number
): number {
  const scores = new Map<number, number>();
  const radiansPerDegree = Math.PI / 180;
  const padding = Math.ceil(width * Math.sin(SKEW_SEARCH_LIMIT_DEGREES * radiansPerDegree));
  for (let angle = -SKEW_SEARCH_LIMIT_DEGREES; angle <= SKEW_SEARCH_LIMIT_DEGREES; angle += 0.5) {
    const radians = angle * radiansPerDegree;
    const sin = Math.sin(radians);
    const cos = Math.cos(radians);
    const rowCounts = new Uint32Array(height + padding * 2);
    let offset = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, offset++) {
        if (pixels[offset] < 145) {
          const row = Math.max(0, Math.min(rowCounts.length - 1, Math.round(y * cos - x * sin) + padding));
          rowCounts[row]++;
        }
      }
    }

    let score = 0;
    for (const count of rowCounts) score += count * count;
    scores.set(angle, score);
  }

  let bestAngle = 0;
  let bestScore = scores.get(0) || 0;
  for (const [angle, score] of scores) {
    if (score > bestScore) {
      bestAngle = angle;
      bestScore = score;
    }
  }

  return Math.abs(bestAngle) < 0.5 ? 0 : bestAngle;
}

function adaptiveThreshold(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      rowSum += pixels[(y - 1) * width + x - 1];
      integral[y * (width + 1) + x] = integral[(y - 1) * (width + 1) + x] + rowSum;
    }
  }

  const output = new Uint8Array(pixels.length);
  const radius = Math.max(12, Math.round(Math.min(width, height) * 0.025));
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const regionWidth = right - left + 1;
      const regionHeight = bottom - top + 1;
      const sum =
        integral[(bottom + 1) * (width + 1) + right + 1] -
        integral[top * (width + 1) + right + 1] -
        integral[(bottom + 1) * (width + 1) + left] +
        integral[top * (width + 1) + left];
      const localMean = sum / (regionWidth * regionHeight);
      output[y * width + x] = pixels[y * width + x] < localMean * 0.9 ? 0 : 255;
    }
  }
  return output;
}
