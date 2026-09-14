/** Operations whose transaction-scoped domain path and preflight are live. */
export const LIVE_GEMMA_PROPOSALS = new Set([
  'add_expense', 'log_personal_expense', 'add_sale', 'record_inventory',
  'add_bill', 'create_supplier_payment', 'add_debtor_payment',
  'create_invoice', 'create_receipt', 'add_capital', 'create_drawing',
  'add_debtor', 'add_supplier',
]);
