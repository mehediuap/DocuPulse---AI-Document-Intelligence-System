"""
Pydantic Schema for AI-Powered Document Intelligence System
Module 2: Invoice Information Extraction Schema
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field, field_validator


class LineItem(BaseModel):
    """Represents a single line item extracted from an invoice or financial table."""
    description: Optional[str] = Field(
        default=None,
        description="Detailed description or name of the product or service. Null if absent."
    )
    quantity: Optional[float] = Field(
        default=None,
        description="Number of units billed. Null if absent."
    )
    unit_price: Optional[float] = Field(
        default=None,
        description="Unit price per item excluding taxes. Null if absent."
    )
    amount: Optional[float] = Field(
        default=None,
        description="Total monetary amount for this line item. Null if absent."
    )
    evidence: Optional[str] = Field(
        default=None,
        description="Verbatim source snippet from document text supporting this line item."
    )
    page_reference: Optional[int] = Field(
        default=None,
        description="1-indexed page or sheet number where this line item appears."
    )


class FieldEvidence(BaseModel):
    """Source provenance and confidence score for an extracted field."""
    snippet: Optional[str] = Field(
        default=None,
        description="Verbatim text quote from the document providing proof of the value."
    )
    page_reference: Optional[int] = Field(
        default=None,
        description="1-indexed page or sheet number where the evidence is located."
    )
    confidence: float = Field(
        default=1.0,
        ge=0.0,
        le=1.0,
        description="Extraction confidence between 0.0 and 1.0."
    )


class ExtractionMetadata(BaseModel):
    """Execution telemetry and runtime adapter information."""
    mode: str = Field(
        description="Extraction mode used: 'mock_rule_based' or 'gemini_llm'."
    )
    model_used: Optional[str] = Field(
        default=None,
        description="Specific LLM model alias or rule version."
    )
    processing_time_ms: int = Field(
        description="Duration of extraction in milliseconds."
    )
    warnings: List[str] = Field(
        default_factory=list,
        description="Processing warnings or notices about missing/uncertain fields."
    )


class InvoiceExtraction(BaseModel):
    """
    Standardized schema for structured invoice extraction.
    All fields default to null if not explicitly present in the source text.
    """
    invoice_number: Optional[str] = Field(
        default=None,
        description="Unique identifier assigned to the invoice by the supplier. Null if absent."
    )
    invoice_date: Optional[str] = Field(
        default=None,
        description="Issue date of the invoice in ISO-8601 (YYYY-MM-DD) format or verbatim string. Null if absent."
    )
    supplier_name: Optional[str] = Field(
        default=None,
        description="Legal or commercial name of the issuing entity / vendor. Null if absent."
    )
    customer_name: Optional[str] = Field(
        default=None,
        description="Legal or commercial name of the recipient / client. Null if absent."
    )
    subtotal: Optional[float] = Field(
        default=None,
        description="Net monetary amount before tax and shipping. Null if absent."
    )
    tax: Optional[float] = Field(
        default=None,
        description="Total tax amount (VAT, GST, sales tax). Null if absent."
    )
    total: Optional[float] = Field(
        default=None,
        description="Final gross payable amount including all taxes and fees. Null if absent."
    )
    currency: Optional[str] = Field(
        default=None,
        description="Three-letter ISO 4217 currency code (e.g. USD, EUR, GBP) or standard symbol. Null if absent."
    )
    line_items: List[LineItem] = Field(
        default_factory=list,
        description="List of individual goods or services listed on the invoice."
    )
    evidence: Dict[str, FieldEvidence] = Field(
        default_factory=dict,
        description="Mapping of field names to their source evidence quotes and page references."
    )
    extraction_metadata: Optional[ExtractionMetadata] = Field(
        default=None,
        description="Telemetry indicating extraction mode, duration, and warnings."
    )

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, v: Optional[str]) -> Optional[str]:
        if not v:
            return None
        v = v.strip().upper()
        symbol_map = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR"}
        return symbol_map.get(v, v)
