"""
Pydantic API Request and Response Schemas for DocuPulse Backend REST API
Endpoints: /api/v1/documents, /api/v1/documents/{id}, /health
"""

from typing import List, Optional, Dict, Any
from enum import Enum
from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    NEEDS_REVIEW = "needs_review"
    FAILED = "failed"


class ErrorDetail(BaseModel):
    code: str = Field(description="Machine-readable error code")
    message: str = Field(description="Human-readable explanation of error")
    field: Optional[str] = Field(default=None, description="Request field that caused the error")


class ErrorResponse(BaseModel):
    success: bool = False
    error: ErrorDetail


class DocumentMetadataResponse(BaseModel):
    id: str = Field(description="Unique identifier for the document")
    original_filename: str = Field(description="Original uploaded filename")
    sanitized_filename: str = Field(description="Sanitized safe filename")
    file_type: str = Field(description="Detected format (pdf, image, xlsx, xls, csv)")
    mime_type: str = Field(description="MIME type")
    file_size_bytes: int = Field(description="File size in bytes")
    status: JobStatus = Field(description="Current job processing status")
    created_at: str = Field(description="ISO-8601 creation timestamp")
    updated_at: str = Field(description="ISO-8601 last updated timestamp")
    processing_duration_ms: Optional[int] = Field(default=None, description="Processing duration in milliseconds")
    retry_count: int = Field(default=0, description="Number of retry attempts")


class DocumentUploadItem(BaseModel):
    document_id: str
    filename: str
    status: JobStatus
    message: str


class DocumentUploadResponse(BaseModel):
    success: bool = True
    documents: List[DocumentUploadItem]
    total_queued: int


class DocumentResultResponse(BaseModel):
    document_id: str
    status: JobStatus
    extraction: Optional[Dict[str, Any]] = Field(default=None, description="Extracted invoice data matching InvoiceExtraction schema")
    validation: Optional[Dict[str, Any]] = Field(default=None, description="Data validation and financial reconciliation summary")
    audit_trail: List[Dict[str, Any]] = Field(default_factory=list, description="Historical record of manual corrections")
    errors: List[str] = Field(default_factory=list, description="Processing or validation error messages")
    warnings: List[str] = Field(default_factory=list, description="Processing warnings or review triggers")


class DocumentListResponse(BaseModel):
    items: List[DocumentMetadataResponse]
    total: int
    page: int
    limit: int
    total_pages: int


class AuditEntry(BaseModel):
    field: str
    previous_value: Any
    new_value: Any
    updated_at: str
    reason: Optional[str] = None
    author: str = "auditor"


class CorrectionRequest(BaseModel):
    corrections: Dict[str, Any] = Field(
        description="Key-value mapping of field corrections (e.g. {'invoice_number': 'INV-999', 'subtotal': 1200.00})"
    )
    reason: Optional[str] = Field(
        default=None,
        description="Audit reason explaining why manual correction was applied"
    )
    revalidate: bool = Field(
        default=True,
        description="Whether to immediately rerun mathematical and business validation rules after applying corrections"
    )


class CorrectionResponse(BaseModel):
    success: bool = True
    document_id: str
    status: JobStatus
    updated_fields: List[str]
    audit_trail: List[AuditEntry]
    validation_status: str


class RetryResponse(BaseModel):
    success: bool
    document_id: str
    status: JobStatus
    message: str


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "1.0.0"
    service: str = "DocuPulse Backend REST API"
    environment: str = "local_assessment_demo"
    queue_status: Dict[str, int]
    auth_warning: str = "Local assessment demo - authentication disabled. Not suitable for public deployment without RBAC/OAuth."
