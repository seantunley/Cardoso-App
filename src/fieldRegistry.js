// ==================== FIELD REGISTRY ====================
// Defines all MSSQL→SQLite field mappings. buildFieldPatch iterates this.
// This file must NOT import from any route or service file.

import { parseJsonSafely } from './helpers.js';

export const FIELD_REGISTRY = [
  { key: 'customer_number',    sources: ['customer_number', 'CustomerNumber', 'CUSTOMER_NUMBER'],                                                                       defaultMode: 'sync' },
  { key: 'customer_name',      sources: ['customer_name', 'CustomerName', 'CUSTOMER_NAME', 'name', 'Name'],                                                             defaultMode: 'sync' },
  { key: 'age_analysis',       sources: ['age_analysis', 'AgeAnalysis', 'AGE_ANALYSIS'],                                                                                defaultMode: 'sync' },
  { key: 'outstanding_balance',sources: ['outstanding_balance', 'OutstandingBalance', 'OUTSTANDING_BALANCE', 'Balance', 'BALANCE', 'AMTDUE', 'AMTDUE1', 'AMTDUE1HC', 'AMTOUTSTANDING', 'OUTSTANDING', 'OutstandingAmt', 'outstanding_amt', 'balance_due', 'BalanceDue', 'BALANCEDUE', 'TotalDue', 'TOTALDUE', 'total_due', 'AmountDue', 'AMOUNTDUE', 'amount_due'], defaultMode: 'sync' },
  { key: 'age_current',        sources: ['age_current', 'AgeCurrent', 'AGE_CURRENT', 'Current', 'CURRENT'],                                                             defaultMode: 'sync' },
  { key: 'age_7_days',         sources: ['age_7_days', 'Age7Days', 'AGE_7_DAYS', 'Age7', 'AMTDUE07'],                                                                  defaultMode: 'sync' },
  { key: 'age_14_days',        sources: ['age_14_days', 'Age14Days', 'AGE_14_DAYS', 'Age14', 'AMTDUE14'],                                                               defaultMode: 'sync' },
  { key: 'age_21_days',        sources: ['age_21_days', 'Age21Days', 'AGE_21_DAYS', 'Age21', 'AMTDUE21'],                                                               defaultMode: 'sync' },
  { key: 'terms',              sources: ['terms', 'Terms', 'TERMS', 'PaymentTerms', 'payment_terms', 'PAYMENT_TERMS'],                                                  defaultMode: 'sync' },
  { key: 'sales_rep',          sources: ['sales_rep', 'SalesRep', 'SALEREP', 'SalesRepCode', 'salesrep', 'SalesPerson', 'SalesPersonCode'],                                 defaultMode: 'sync' },
  { key: 'note',               sources: ['note', 'Note', 'notes', 'Notes'],                                                                                             defaultMode: 'local-only' },
  { key: 'custom_field_1',     sources: ['custom_field_1', 'CustomField1', 'CUSTOM_FIELD_1'],                                                                            defaultMode: 'sync-if-empty' },
  { key: 'custom_field_2',     sources: ['custom_field_2', 'CustomField2', 'CUSTOM_FIELD_2'],                                                                            defaultMode: 'sync-if-empty' },
  { key: 'custom_field_3',     sources: ['custom_field_3', 'CustomField3', 'CUSTOM_FIELD_3'],                                                                            defaultMode: 'sync-if-empty' },
];

// Invoice/receipt slot definitions — used by buildFieldPatch to produce JSON arrays
export const INVOICE_SLOTS = [1, 2, 3, 4, 5].map(i => ({
  index: i,
  number_sources: i === 1
    ? [`last_unpaid_invoice_1`, 'LastUnpaidInvoice1', 'LAST_UNPAID_INVOICE_1']
    : [`last_unpaid_invoice_${i}`, `LastUnpaidInvoice${i}`, `LAST_UNPAID_INVOICE_${i}`],
  amount_sources: i === 1
    ? ['last_unpaid_invoice_1_amount', 'LastUnpaidInvoice1Amount', 'LAST_UNPAID_INVOICE_1_AMOUNT']
    : [`last_unpaid_invoice_${i}_amount`, `LastUnpaidInvoice${i}Amount`, `LAST_UNPAID_INVOICE_${i}_AMOUNT`],
  date_sources: i === 1
    ? ['last_unpaid_invoice_1_date', 'LastUnpaidInvoice1Date', 'LAST_UNPAID_INVOICE_1_DATE', 'InvoiceDate', 'INVDATE', 'LastInvoiceDate']
    : [`last_unpaid_invoice_${i}_date`, `LastUnpaidInvoice${i}Date`, `LAST_UNPAID_INVOICE_${i}_DATE`],
}));

export const RECEIPT_SLOTS = [1, 2, 3, 4, 5].map(i => ({
  index: i,
  number_sources: i === 1
    ? ['last_receipt_1', 'LastReceipt1', 'LAST_RECEIPT_1', 'last_receipt_number', 'LastReceiptNumber', 'ReceiptNo', 'RECNO']
    : [`last_receipt_${i}`, `LastReceipt${i}`, `LAST_RECEIPT_${i}`],
  amount_sources: i === 1
    ? ['last_receipt_1_amount', 'LastReceipt1Amount', 'LAST_RECEIPT_1_AMOUNT', 'last_receipt_amount', 'LastReceiptAmount', 'ReceiptAmount', 'RECAMT']
    : [`last_receipt_${i}_amount`, `LastReceipt${i}Amount`, `LAST_RECEIPT_${i}_AMOUNT`],
  date_sources: i === 1
    ? ['last_receipt_1_date', 'LastReceipt1Date', 'LAST_RECEIPT_1_DATE', 'last_receipt_date', 'LastReceiptDate', 'ReceiptDate', 'RECDATE']
    : [`last_receipt_${i}_date`, `LastReceipt${i}Date`, `LAST_RECEIPT_${i}_DATE`],
}));

export function getMappingForKey(fieldMappings, localKey) {
  const mapping = fieldMappings?.[localKey];
  if (!mapping) return null;

  return {
    sourceField: mapping.sourceField || null,
    mode: mapping.mode || 'sync',
    label: mapping.label || localKey,
    type: mapping.type || 'text',
    isCustom: !!mapping.isCustom,
  };
}

export function getRowValue(row, fieldName) {
  if (!fieldName) return undefined;
  return row[fieldName];
}

export function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

export function getMappedOrFallbackValue(row, fieldMappings, localKey, fallbacks = []) {
  const mapping = getMappingForKey(fieldMappings, localKey);
  const mappedValue = getRowValue(row, mapping?.sourceField);

  if (mappedValue !== undefined && mappedValue !== null && mappedValue !== '') {
    return mappedValue;
  }

  for (const key of fallbacks) {
    const fallbackValue = getRowValue(row, key);
    if (fallbackValue !== undefined && fallbackValue !== null && fallbackValue !== '') {
      return fallbackValue;
    }
  }

  return '';
}

export function shouldApplyMappedValue(mode, existingValue, incomingValue) {
  if (mode === 'local-only') return false;
  if (incomingValue === undefined || incomingValue === null) return false;

  if (mode === 'sync') return true;

  if (mode === 'sync-if-empty') {
    return existingValue === undefined || existingValue === null || String(existingValue).trim() === '';
  }

  return true;
}

export function buildFieldPatch(existingRecord, row, fieldMappings, indexField) {
  const patch = {};

  for (const field of FIELD_REGISTRY) {
    const sources = field.key === 'customer_number'
      ? [...field.sources, indexField, 'id'].filter(Boolean)
      : field.sources;
    const mapping = getMappingForKey(fieldMappings, field.key);
    const mode = mapping?.mode || field.defaultMode;
    const incomingValue = getMappedOrFallbackValue(row, fieldMappings, field.key, sources);
    const existingValue = existingRecord?.[field.key];

    if (shouldApplyMappedValue(mode, existingValue, incomingValue)) {
      patch[field.key] = String(incomingValue ?? '');
    } else if (!existingRecord && incomingValue !== undefined && incomingValue !== null && incomingValue !== '') {
      patch[field.key] = String(incomingValue);
    }
  }

  // Build unpaid_invoices JSON array from INVOICE_SLOTS
  const invoiceSlots = INVOICE_SLOTS.map(slot => ({
    number: String(getMappedOrFallbackValue(row, fieldMappings, `last_unpaid_invoice_${slot.index}`, slot.number_sources) ?? ''),
    amount: String(getMappedOrFallbackValue(row, fieldMappings, `last_unpaid_invoice_${slot.index}_amount`, slot.amount_sources) ?? ''),
    date:   String(getMappedOrFallbackValue(row, fieldMappings, `last_unpaid_invoice_${slot.index}_date`,   slot.date_sources)   ?? ''),
  })).filter(s => s.date || s.number || s.amount);
  patch.unpaid_invoices = JSON.stringify(invoiceSlots);

  // Build receipts JSON array from RECEIPT_SLOTS
  const receiptSlots = RECEIPT_SLOTS.map(slot => ({
    number: String(getMappedOrFallbackValue(row, fieldMappings, `last_receipt_${slot.index}`,        slot.number_sources) ?? ''),
    amount: String(getMappedOrFallbackValue(row, fieldMappings, `last_receipt_${slot.index}_amount`, slot.amount_sources) ?? ''),
    date:   String(getMappedOrFallbackValue(row, fieldMappings, `last_receipt_${slot.index}_date`,   slot.date_sources)   ?? ''),
  })).filter(s => s.date || s.number || s.amount);
  patch.receipts = JSON.stringify(receiptSlots);

  return patch;
}

export function buildDynamicLocalFieldsPatch(existingRecord, row, fieldMappings) {
  const existingLocalFields = parseJsonSafely(existingRecord?.local_fields, {});
  const nextLocalFields = { ...existingLocalFields };

  for (const [localKey, mapping] of Object.entries(fieldMappings || {})) {
    if (!mapping?.isCustom) continue;

    const mode = mapping.mode || 'sync';
    const incomingValue = getRowValue(row, mapping.sourceField);
    const existingValue = existingLocalFields[localKey];

    if (!shouldApplyMappedValue(mode, existingValue, incomingValue)) {
      continue;
    }

    if (incomingValue === undefined || incomingValue === null || incomingValue === '') {
      if (mode === 'sync') {
        nextLocalFields[localKey] = '';
      }
      continue;
    }

    nextLocalFields[localKey] = String(incomingValue);
  }

  return nextLocalFields;
}
