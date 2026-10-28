/**
 * Task 3: Data Validation Service Types & Issue Codes
 */

export type ValidationStatus = 'valid' | 'needs_review' | 'invalid';

export type IssueSeverity = 'error' | 'warning' | 'info';

export type ValidationIssueCode =
  | 'MISSING_REQUIRED_FIELD'
  | 'FIELD_UNCERTAIN'
  | 'INVALID_DATE_FORMAT'
  | 'FUTURE_DATE_WARNING'
  | 'INVALID_NUMERIC_VALUE'
  | 'NEGATIVE_AMOUNT_SUSPICIOUS'
  | 'ZERO_AMOUNT_SUSPICIOUS'
  | 'ARITHMETIC_SUBTOTAL_MISMATCH'
  | 'ARITHMETIC_TOTAL_MISMATCH'
  | 'LINE_ITEM_CALCULATION_MISMATCH'
  | 'DUPLICATE_INVOICE_CANDIDATE'
  | 'MISSING_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'ROUNDING_TOLERANCE_EXCEEDED';

export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: IssueSeverity;
  field: string;
  message: string;
  actualValue?: any;
  expectedValue?: any;
  delta?: number;
  evidenceSnippet?: string | null;
  manualReviewReason?: string;
}

export interface ValidationConfig {
  /** Maximum acceptable arithmetic variance in monetary units (default: 0.05 / 5 cents) */
  roundingTolerance: number;
  /** Whether line items must be present and sum to subtotal */
  requireLineItems: boolean;
  /** Whether negative numbers trigger review (default: false, negative values are flagged) */
  allowNegativeAmounts: boolean;
  /** Grace period in days for invoice dates in the future (default: 7 days) */
  futureDateGraceDays: number;
  /** Confidence threshold below which fields are flagged as uncertain (default: 0.70) */
  uncertaintyThreshold: number;
}

export interface FinancialReconciliation {
  lineItemsCalculatedSum: number | null;
  statedSubtotal: number | null;
  subtotalDelta: number | null;
  statedTax: number | null;
  statedTotal: number | null;
  expectedTotal: number | null;
  totalDelta: number | null;
  isReconciled: boolean;
  hasRoundingAdjustment: boolean;
}

export interface ValidationSummary {
  status: ValidationStatus;
  totalIssues: number;
  errorCount: number;
  warningCount: number;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  manualReviewRequired: boolean;
  reasonsForManualReview: string[];
  reconciliation: FinancialReconciliation;
  validatedAt: string;
}
