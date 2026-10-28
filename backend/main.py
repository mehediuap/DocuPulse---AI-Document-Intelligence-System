"""
DocuPulse — FastAPI REST API Reference Implementation
Module 4: Backend REST API with Background Queue & Audit Trails
"""

import os
import sys
import time
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Query, Path, UploadFile, File, BackgroundTasks, status
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# Add root directory to python path for schema imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from schemas.api_models import (
    JobStatus,
    DocumentUploadResponse,
    DocumentUploadItem,
    DocumentMetadataResponse,
    DocumentResultResponse,
    DocumentListResponse,
    CorrectionRequest,
    CorrectionResponse,
    RetryResponse,
    HealthResponse,
    ErrorResponse,
    ErrorDetail,
    AuditEntry,
)

app = FastAPI(
    title="DocuPulse Backend REST API",
    version="1.0.0",
    description="Enterprise Document Intelligence REST API for uploads, status, extraction, validation, and corrections.",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/api/v1/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory document store and queue for local assessment demo
DOCUMENT_STORE: Dict[str, Dict[str, Any]] = {}
PROCESSING_LOCKS: set = set()


def background_process_document(document_id: str):
    """
    Background worker simulating long-running OCR and LLM extraction.
    Updates document status: queued -> processing -> completed / needs_review / failed.
    """
    doc = DOCUMENT_STORE.get(document_id)
    if not doc:
        return

    PROCESSING_LOCKS.add(document_id)
    doc["status"] = JobStatus.PROCESSING.value
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    try:
        # Simulate processing duration
        time.sleep(0.5)

        # Populate structured extraction
        doc["extraction"] = {
            "invoice_number": f"INV-{document_id[-6:].upper()}",
            "invoice_date": "2026-10-20",
            "supplier_name": "Apex Precision Technologies",
            "customer_name": "Quantum Robotics Corp",
            "subtotal": 1200.00,
            "tax": 96.00,
            "total": 1296.00,
            "currency": "USD",
            "line_items": [
                {"description": "Precision Actuator", "quantity": 2, "unit_price": 600.00, "amount": 1200.00}
            ],
            "evidence": {
                "total": {"snippet": "Total: $1,296.00 USD", "page_reference": 1, "confidence": 0.98}
            },
            "extraction_metadata": {
                "mode": "mock_rule_based",
                "processing_time_ms": 480,
                "warnings": []
            }
        }

        # Validation status
        doc["validation"] = {
            "status": "valid",
            "error_count": 0,
            "warning_count": 0,
            "is_reconciled": True
        }
        doc["status"] = JobStatus.COMPLETED.value
    except Exception as exc:
        doc["status"] = JobStatus.FAILED.value
        doc["errors"].append(str(exc))
    finally:
        PROCESSING_LOCKS.discard(document_id)
        doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@app.get("/health", response_model=HealthResponse, tags=["System"])
def get_health():
    """System health check and queue metrics."""
    counts = {s.value: 0 for s in JobStatus}
    for doc in DOCUMENT_STORE.values():
        counts[doc["status"]] = counts.get(doc["status"], 0) + 1

    return HealthResponse(
        status="ok",
        version="1.0.0",
        service="DocuPulse Backend REST API",
        environment="local_assessment_demo",
        queue_status=counts,
        auth_warning="Local assessment demo - authentication disabled. Not suitable for public deployment without RBAC/OAuth."
    )


@app.post("/api/v1/documents", response_model=DocumentUploadResponse, status_code=status.HTTP_202_ACCEPTED, tags=["Documents"])
async def upload_documents(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(..., description="One or multiple invoice documents (PDF, JPG, PNG, TIFF, XLSX, XLS, CSV)")
):
    """
    Upload one or multiple documents. Creates background jobs and enqueues them.
    """
    if not files:
        raise HTTPException(status_code=400, detail="At least one file must be provided.")

    queued_items: List[DocumentUploadItem] = []
    allowed_extensions = {".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".xlsx", ".xls", ".csv"}

    for upload in files:
        filename = upload.filename or "unnamed_document"
        _, ext = os.path.splitext(filename.lower())

        if ext not in allowed_extensions:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail=f"Unsupported format '{ext}'. Allowed: {', '.join(allowed_extensions)}"
            )

        doc_id = f"doc_{int(time.time())}_{os.urandom(3).hex()}"
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        DOCUMENT_STORE[doc_id] = {
            "id": doc_id,
            "original_filename": filename,
            "sanitized_filename": filename.replace("/", "_").replace("\\", "_"),
            "file_type": ext.lstrip("."),
            "mime_type": upload.content_type or "application/octet-stream",
            "file_size_bytes": 0,
            "status": JobStatus.QUEUED.value,
            "created_at": now,
            "updated_at": now,
            "retry_count": 0,
            "extraction": None,
            "validation": None,
            "audit_trail": [],
            "errors": [],
            "warnings": [],
        }

        # Schedule async background task
        background_tasks.add_task(background_process_document, doc_id)

        queued_items.append(
            DocumentUploadItem(
                document_id=doc_id,
                filename=filename,
                status=JobStatus.QUEUED,
                message="File accepted and processing job queued."
            )
        )

    return DocumentUploadResponse(
        success=True,
        documents=queued_items,
        total_queued=len(queued_items)
    )


@app.get("/api/v1/documents/{document_id}", response_model=DocumentMetadataResponse, tags=["Documents"])
def get_document_metadata(document_id: str = Path(..., description="Unique document ID")):
    """Retrieve metadata and current processing status for a document."""
    doc = DOCUMENT_STORE.get(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document with ID '{document_id}' not found.")

    return DocumentMetadataResponse(**doc)


@app.get("/api/v1/documents/{document_id}/result", response_model=DocumentResultResponse, tags=["Documents"])
def get_document_result(document_id: str = Path(..., description="Unique document ID")):
    """Retrieve extracted structured data and financial validation results."""
    doc = DOCUMENT_STORE.get(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document with ID '{document_id}' not found.")

    return DocumentResultResponse(
        document_id=doc["id"],
        status=doc["status"],
        extraction=doc.get("extraction"),
        validation=doc.get("validation"),
        audit_trail=doc.get("audit_trail", []),
        errors=doc.get("errors", []),
        warnings=doc.get("warnings", []),
    )


@app.get("/api/v1/documents", response_model=DocumentListResponse, tags=["Documents"])
def list_documents(
    page: int = Query(default=1, ge=1, description="Page number (1-indexed)"),
    limit: int = Query(default=10, ge=1, le=100, description="Items per page"),
    status: Optional[JobStatus] = Query(default=None, description="Filter by status"),
    search: Optional[str] = Query(default=None, description="Search keyword in filename, supplier, or invoice number"),
):
    """Retrieve paginated document list with optional status filtering and keyword search."""
    items = list(DOCUMENT_STORE.values())

    if status:
        items = [d for d in items if d["status"] == status.value]

    if search:
        s = search.lower().strip()
        items = [
            d for d in items
            if s in d["original_filename"].lower()
            or s in d["id"].lower()
            or (d.get("extraction") and s in str(d["extraction"].get("supplier_name", "")).lower())
            or (d.get("extraction") and s in str(d["extraction"].get("invoice_number", "")).lower())
        ]

    total = len(items)
    total_pages = max(1, (total + limit - 1) // limit)
    offset = (page - 1) * limit
    paginated = [DocumentMetadataResponse(**d) for d in items[offset : offset + limit]]

    return DocumentListResponse(
        items=paginated,
        total=total,
        page=page,
        limit=limit,
        total_pages=total_pages,
    )


@app.patch("/api/v1/documents/{document_id}/corrections", response_model=CorrectionResponse, tags=["Documents"])
def apply_corrections(
    document_id: str = Path(...),
    req: CorrectionRequest = ...
):
    """Apply manual corrections with immutable audit log."""
    doc = DOCUMENT_STORE.get(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document with ID '{document_id}' not found.")

    if not doc.get("extraction"):
        raise HTTPException(status_code=400, detail="Cannot apply corrections to unextracted document.")

    updated_fields = []
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    for field, new_val in req.corrections.items():
        prev_val = doc["extraction"].get(field)
        doc["extraction"][field] = new_val
        doc["audit_trail"].append(
            {
                "field": field,
                "previous_value": prev_val,
                "new_value": new_val,
                "updated_at": now,
                "reason": req.reason or "Manual correction",
                "author": "auditor"
            }
        )
        updated_fields.append(field)

    doc["updated_at"] = now
    doc["status"] = JobStatus.COMPLETED.value

    return CorrectionResponse(
        success=True,
        document_id=doc["id"],
        status=doc["status"],
        updated_fields=updated_fields,
        audit_trail=doc["audit_trail"],
        validation_status="valid"
    )


@app.post("/api/v1/documents/{document_id}/retry", response_model=RetryResponse, tags=["Documents"])
def retry_job(
    background_tasks: BackgroundTasks,
    document_id: str = Path(...)
):
    """Safely retry a failed or flagged job with duplicate concurrency protection."""
    doc = DOCUMENT_STORE.get(document_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document with ID '{document_id}' not found.")

    if document_id in PROCESSING_LOCKS or doc["status"] == JobStatus.PROCESSING.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Job is currently processing. Duplicate retry rejected."
        )

    doc["retry_count"] += 1
    doc["status"] = JobStatus.QUEUED.value
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    background_tasks.add_task(background_process_document, document_id)

    return RetryResponse(
        success=True,
        document_id=doc["id"],
        status=JobStatus.QUEUED,
        message=f"Document {document_id} requeued for reprocessing (attempt #{doc['retry_count']})."
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
