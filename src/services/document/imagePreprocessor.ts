const MAX_IMAGE_PIXELS = 100_000_000;

export interface OcrImageVariants {
  enhanced: Uint8Array;
  highContrast: Uint8Array;
  warning?: string;
}

export async function createOcrImageVariants(
  input: Uint8Array,
  page?: number
): Promise<OcrImageVariants> {
  if (typeof window !== 'undefined') {
    return { enhanced: input, highContrast: input };
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
    const enhanced = await sharp(sourceImage, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'error',
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();

    const highContrast = await sharp(enhanced, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: 'error',
    })
      .linear(1.25, -18)
      .threshold(175)
      .png()
      .toBuffer();

    return {
      enhanced: new Uint8Array(enhanced),
      highContrast: new Uint8Array(highContrast),
    };
  } catch {
    return {
      enhanced: sourceImage,
      highContrast: sourceImage,
      warning: 'Image preprocessing failed; OCR is using the original image.',
    };
  }
}
