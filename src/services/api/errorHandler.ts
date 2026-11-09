import type { Request, Response, NextFunction } from 'express';
import { HttpError } from './httpError.ts';

/**
 * Defensive error handling middleware.
 * Known HttpErrors keep their message. Body-parser 4xx errors are mapped to stable codes.
 * Anything else is logged server-side and returned as a generic 500: no messages, paths or stack traces.
 */
export function safeErrorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  let statusCode = 500;
  let errorCode = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected server error occurred.';
  let field: string | undefined;

  if (err instanceof HttpError) {
    statusCode = err.statusCode;
    errorCode = err.errorCode;
    message = err.message;
    field = err.field;
  } else if (err?.type === 'entity.too.large') {
    statusCode = 413;
    errorCode = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large.';
  } else if (err?.type === 'entity.parse.failed') {
    statusCode = 400;
    errorCode = 'INVALID_JSON';
    message = 'Request body is not valid JSON.';
  } else {
    console.error('[DocuPulse] Unhandled API error:', err);
  }

  res.status(statusCode).json({ success: false, error: { code: errorCode, message, field } });
}
