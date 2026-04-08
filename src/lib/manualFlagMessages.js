export function formatFlagActor(flaggedBy) {
  const value = String(flaggedBy || '').trim();
  return value || null;
}

export function buildManualFlagSummary(flagColor, flaggedBy) {
  const actor = formatFlagActor(flaggedBy);
  const color = flagColor === 'red' ? 'red' : 'orange';
  const actorText = actor ? ` by ${actor}` : '';
  const followUp = color === 'red'
    ? 'Resolve the flag before issuing an invoice.'
    : 'Review before issuing an invoice.';

  return `This customer has been manually flagged ${color}${actorText}. ${followUp}`;
}

export function buildManualFlagFactor(flagColor, flaggedBy) {
  const actor = formatFlagActor(flaggedBy);
  const color = flagColor === 'red' ? 'red' : 'orange';
  const actorText = actor ? ` by ${actor}` : '';
  const followUp = color === 'red'
    ? 'staff review required before invoicing.'
    : 'staff review recommended before invoicing.';
  return `Customer is manually flagged ${color}${actorText} — ${followUp}`;
}
