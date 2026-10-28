"""
DocuPulse — SQLAlchemy Database Models
Supports SQLite locally and PostgreSQL via DATABASE_URL configuration.
"""

from datetime import datetime
from sqlalchemy import (
    Column,
    String,
    Integer,
    BigInteger,
    Float,
    DateTime,
    ForeignKey,
    Text,
    Index,
    Boolean,
)
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class DocumentModel(Base):
    """Stores document metadata, lifecycle state, and storage references."""
    __tablename__ = "documents"

    id = Column(String(64), primary_key=True)
    original_filename = Column(String(255), nullable=False)
    sanitized_filename = Column(String(255), nullable=False)
    file_type = Column(String(32), nullable=False)
    mime_type = Column(String(128), nullable=False)
    file_size_bytes = Column(BigInteger, nullable=False)
    storage_path = Column(String(512), nullable=True)
    status = Column(String(32), nullable=False, default="queued")
    uploaded_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    processing_duration_ms = Column(Integer, nullable=True)
    retry_count = Column(Integer, default=0, nullable=False)

    # Privacy-conscious raw text retention
    raw_text = Column(Text, nullable=True)

    # Relationships
    extraction = relationship("ExtractionModel", uselist=False, back_populates="document", cascade="all, delete-orphan")
    validation = relationship("ValidationModel", uselist=False, back_populates="document", cascade="all, delete-orphan")
    history = relationship("ProcessingHistoryModel", back_populates="document", cascade="all, delete-orphan")
    audit_trail = relationship("AuditEntryModel", back_populates="document", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_documents_status", "status"),
        Index("idx_documents_uploaded_at", "uploaded_at"),
        Index("idx_documents_file_type", "file_type"),
    )


class ExtractionModel(Base):
    """Stores structured invoice extraction fields with decimal-safe integer cents."""
    __tablename__ = "extractions"

    id = Column(String(64), primary_key=True)
    document_id = Column(String(64), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, unique=True)
    invoice_number = Column(String(128), nullable=True)
    invoice_date = Column(String(64), nullable=True)
    supplier_name = Column(String(255), nullable=True)
    customer_name = Column(String(255), nullable=True)

    # Decimal-safe amounts: stored both as floating decimal and integer cents
    subtotal = Column(Float, nullable=True)
    subtotal_cents = Column(BigInteger, nullable=True)
    tax = Column(Float, nullable=True)
    tax_cents = Column(BigInteger, nullable=True)
    total = Column(Float, nullable=True)
    total_cents = Column(BigInteger, nullable=True)

    currency = Column(String(8), nullable=True)

    # Serialized structures
    line_items_json = Column(Text, nullable=True)
    evidence_json = Column(Text, nullable=True)
    extraction_metadata_json = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    document = relationship("DocumentModel", back_populates="extraction")

    __table_args__ = (
        Index("idx_extractions_supplier_invoice", "supplier_name", "invoice_number"),
        Index("idx_extractions_invoice_date", "invoice_date"),
        Index("idx_extractions_total_cents", "total_cents"),
    )


class ValidationModel(Base):
    """Stores financial reconciliation results, issue codes, and review flags."""
    __tablename__ = "validations"

    id = Column(String(64), primary_key=True)
    document_id = Column(String(64), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, unique=True)
    status = Column(String(32), nullable=False)
    error_count = Column(Integer, default=0, nullable=False)
    warning_count = Column(Integer, default=0, nullable=False)
    is_reconciled = Column(Boolean, default=False, nullable=False)
    issues_json = Column(Text, nullable=True)
    reconciliation_json = Column(Text, nullable=True)
    validated_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    document = relationship("DocumentModel", back_populates="validation")


class ProcessingHistoryModel(Base):
    """Maintains immutable log of all processing attempts and retry runs."""
    __tablename__ = "processing_history"

    id = Column(String(64), primary_key=True)
    document_id = Column(String(64), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    attempt_number = Column(Integer, nullable=False)
    status = Column(String(32), nullable=False)
    duration_ms = Column(Integer, nullable=True)
    started_at = Column(DateTime, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    error_message = Column(Text, nullable=True)

    document = relationship("DocumentModel", back_populates="history")

    __table_args__ = (
        Index("idx_history_doc_attempt", "document_id", "attempt_number"),
    )


class AuditEntryModel(Base):
    """Stores manual field corrections and auditor justification."""
    __tablename__ = "audit_trail"

    id = Column(String(64), primary_key=True)
    document_id = Column(String(64), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False)
    field = Column(String(128), nullable=False)
    previous_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    reason = Column(Text, nullable=True)
    author = Column(String(128), default="auditor", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    document = relationship("DocumentModel", back_populates="audit_trail")

    __table_args__ = (
        Index("idx_audit_document_id", "document_id"),
    )
