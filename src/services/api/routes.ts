/**
 * Express REST API Routes for DocuPulse
 * Endpoints: /api/v1/documents, /api/v1/documents/:id, /api/v1/openapi.json, /health
 */

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { documentController, HttpError } from './documentController.ts';
import { JobStatus } from './types.ts';
import { apiAuthenticationMiddleware, getAuthenticatedActor } from './authentication.ts';
import { getIncomingUploadDirectory } from '../document/sourceStorage.ts';

export const apiRouter = express.Router();
apiRouter.use('/api/v1/documents', apiAuthenticationMiddleware);

const MAX_UPLOAD_REQUEST_BYTES = 35 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;
const multipartUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      try {
        const directory = getIncomingUploadDirectory();
        mkdirSync(directory, { recursive: true });
        callback(null, directory);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), '');
      }
    },
    filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`),
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: MAX_UPLOAD_FILES,
    fields: 0,
    fieldNameSize: 100,
  },
});

function stagedFiles(req: Request): Express.Multer.File[] {
  return Array.isArray(req.files) ? req.files : [];
}

function removeStagedFiles(files: Express.Multer.File[]): void {
  for (const file of files) {
    try {
      rmSync(file.path, { force: true });
    } catch (error) {
      console.error(`Could not remove temporary upload ${file.filename}:`, error);
    }
  }
}

function handleMultipartUpload(req: Request, res: Response, next: NextFunction): void {
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_REQUEST_BYTES) {
    next(new HttpError(413, 'UPLOAD_REQUEST_TOO_LARGE', 'Upload request exceeds the 35 MB request limit.'));
    return;
  }

  multipartUpload.array('files', MAX_UPLOAD_FILES)(req, res, error => {
    if (!error) {
      next();
      return;
    }

    removeStagedFiles(stagedFiles(req));
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE' || error.code === 'LIMIT_FILE_COUNT';
      next(new HttpError(
        tooLarge ? 413 : 400,
        tooLarge ? 'UPLOAD_LIMIT_EXCEEDED' : 'INVALID_MULTIPART_UPLOAD',
        tooLarge
          ? 'Upload exceeds the per-file size or file-count limit.'
          : 'Multipart upload must contain files in the "files" field.'
      ));
      return;
    }
    next(error);
  });
}

export function createDocumentUploadHandler(
  controller = documentController
): RequestHandler[] {
  return [
    handleMultipartUpload,
    async (req: Request, res: Response, next: NextFunction) => {
      const files = stagedFiles(req);
      try {
        if (files.length === 0) {
          throw new HttpError(400, 'NO_FILES_PROVIDED', 'At least one multipart file is required in the "files" field.');
        }

        const totalBytes = files.reduce((total, file) => total + file.size, 0);
        if (totalBytes > MAX_UPLOAD_REQUEST_BYTES) {
          throw new HttpError(413, 'UPLOAD_REQUEST_TOO_LARGE', 'Combined uploaded file data exceeds the 35 MB request limit.');
        }

        const result = await controller.uploadDocumentsFromDisk(files.map(file => ({
          originalName: file.originalname,
          size: file.size,
          type: file.mimetype,
          path: file.path,
        })));
        res.status(202).json(result);
      } catch (err) {
        next(err);
      } finally {
        removeStagedFiles(files);
      }
    },
  ];
}

// 1. POST /api/v1/documents: Upload one or multiple files
apiRouter.post('/api/v1/documents', ...createDocumentUploadHandler());

// 2. GET /api/v1/documents/search/semantic: Genuine vector semantic search
apiRouter.get('/api/v1/documents/search/semantic', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q || req.query.query || '');
    const minSim = req.query.min_similarity === undefined ? 0.2 : Number(req.query.min_similarity);
    const result = await documentController.semanticSearchDocuments(q, minSim);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 3. POST /api/v1/documents/cross-verify: Cross-verification of PDF/Excel documents
apiRouter.post('/api/v1/documents/cross-verify', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sourceId, targetId } = req.body || {};
    if (typeof sourceId !== 'string' || !sourceId.trim() || typeof targetId !== 'string' || !targetId.trim()) {
      throw new HttpError(400, 'MISSING_DOCUMENTS', 'Both sourceId and targetId must be provided in request body.');
    }
    const result = documentController.crossVerifyDocuments(sourceId, targetId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 4. GET /api/v1/documents/:document_id: Metadata and status
apiRouter.get('/api/v1/documents/:document_id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const metadata = documentController.getDocumentMetadata(req.params.document_id);
    res.json(metadata);
  } catch (err) {
    next(err);
  }
});

// 3. GET /api/v1/documents/:document_id/result: Extraction and validation result
apiRouter.get('/api/v1/documents/:document_id/result', (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = documentController.getDocumentResult(req.params.document_id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 4. GET /api/v1/documents: Paginated list, filter by status, search
apiRouter.get('/api/v1/documents', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsePositiveInteger = (value: unknown, fallback: number, field: string): number => {
      if (value === undefined) return fallback;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new HttpError(400, 'INVALID_QUERY_PARAMETER', `${field} must be a positive integer.`, field);
      }
      return parsed;
    };
    const page = parsePositiveInteger(req.query.page, 1, 'page');
    const limit = parsePositiveInteger(req.query.limit, 10, 'limit');
    const validStatuses: JobStatus[] = ['queued', 'processing', 'completed', 'needs_review', 'invalid', 'failed'];
    const statusValue = req.query.status;
    if (statusValue !== undefined && (typeof statusValue !== 'string' || !validStatuses.includes(statusValue as JobStatus))) {
      throw new HttpError(400, 'INVALID_STATUS_FILTER', 'status must be one of the supported document statuses.', 'status');
    }
    if (req.query.search !== undefined && typeof req.query.search !== 'string') {
      throw new HttpError(400, 'INVALID_SEARCH_QUERY', 'search must be a single text value.', 'search');
    }
    const status = statusValue as JobStatus | undefined;
    const search = req.query.search as string | undefined;

    const list = documentController.listDocuments({ page, limit, status, search });
    res.json(list);
  } catch (err) {
    next(err);
  }
});

// 5. PATCH /api/v1/documents/:document_id/corrections: Validated manual correction
apiRouter.patch('/api/v1/documents/:document_id/corrections', (req: Request, res: Response, next: NextFunction) => {
  try {
    const response = documentController.applyCorrections(
      req.params.document_id,
      req.body,
      getAuthenticatedActor(res)
    );
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// 6. POST /api/v1/documents/:document_id/retry: Safely retry failed job
apiRouter.post('/api/v1/documents/:document_id/retry', (req: Request, res: Response, next: NextFunction) => {
  try {
    const response = documentController.retryJob(req.params.document_id);
    res.json(response);
  } catch (err) {
    next(err);
  }
});

// 7. GET /health
apiRouter.get('/health', (_req: Request, res: Response) => {
  const health = documentController.getHealth();
  res.json(health);
});

// 8. GET /api/v1/openapi.json: OpenAPI Specification reflecting all schemas and endpoints
apiRouter.get('/api/v1/openapi.json', (_req: Request, res: Response) => {
  res.json(openApiSpecification);
});

/**
 * Defensive error handling middleware.
 * Never leaks server paths, stack traces, or internal secrets.
 */
export function safeErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const knownError = err instanceof HttpError;
  if (!knownError) console.error('Unhandled API request failure:', err);
  const publicError = toPublicApiError(err);
  const { statusCode, ...error } = publicError;

  res.status(statusCode).json({
    success: false,
    error,
  });
}

export function toPublicApiError(err: unknown): {
  statusCode: number;
  code: string;
  message: string;
  field?: string;
} {
  if (!(err instanceof HttpError)) {
    return {
      statusCode: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected server error occurred.',
    };
  }
  return {
    statusCode: err.statusCode,
    code: err.errorCode,
    message: err.message,
    ...(err.field ? { field: err.field } : {}),
  };
}

const openApiSpecification = {
  openapi: '3.0.3',
  info: {
    title: 'DocuPulse Backend REST API',
    version: '1.0.0',
    description: 'Document intelligence ingestion, status, extraction, validation, and correction REST API.',
  },
  paths: {
    '/health': {
      get: {
        summary: 'System health check',
        responses: { '200': { description: 'Health status' } },
      },
    },
    '/api/v1/documents': {
      post: {
        summary: 'Upload documents and enqueue processing jobs',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['files'],
                properties: {
                  files: { type: 'array', items: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
        },
        responses: { '202': { description: 'Jobs queued successfully' } },
      },
      get: {
        summary: 'List documents with pagination, status filtering, and keyword search',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued', 'processing', 'completed', 'needs_review', 'invalid', 'failed'] } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Paginated document metadata list' } },
      },
    },
    '/api/v1/documents/{document_id}': {
      get: {
        summary: 'Retrieve document processing status and metadata',
        parameters: [{ name: 'document_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Document metadata' }, '404': { description: 'Document not found' } },
      },
    },
    '/api/v1/documents/{document_id}/result': {
      get: {
        summary: 'Retrieve structured extraction and validation results',
        parameters: [{ name: 'document_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Extraction and validation result' }, '404': { description: 'Document not found' } },
      },
    },
    '/api/v1/documents/{document_id}/corrections': {
      patch: {
        summary: 'Apply validated manual field corrections with audit trail',
        parameters: [{ name: 'document_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Corrections applied' } },
      },
    },
    '/api/v1/documents/{document_id}/retry': {
      post: {
        summary: 'Retry failed or flagged processing job',
        parameters: [{ name: 'document_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Job requeued' }, '409': { description: 'Concurrency conflict' } },
      },
    },
    '/api/v1/documents/search/semantic': {
      get: {
        summary: 'Perform vector semantic search over stored documents using dense embeddings',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'min_similarity', in: 'query', schema: { type: 'number', default: 0.2 } },
        ],
        responses: { '200': { description: 'Ranked semantic search results' } },
      },
    },
    '/api/v1/documents/cross-verify': {
      post: {
        summary: 'Cross-verify two documents (PDF vs Excel or PDF vs PDF) for line items, PO numbers, and amounts',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sourceId', 'targetId'],
                properties: {
                  sourceId: { type: 'string' },
                  targetId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Detailed cross-reconciliation report' } },
      },
    },
  },
};
