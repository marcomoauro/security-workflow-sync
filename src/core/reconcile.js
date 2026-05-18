// Precondition: caller must have invoked provider.loadContext() before calling this.
// `onProgress({ processed, total, result })` is invoked after each finding is reconciled.
export async function reconcile(findings, provider, { onProgress } = {}) {
  const existing = await provider.listExistingTickets();

  const result = { created: 0, updated: 0, reopened: 0, closed: 0, skipped: 0, noop: 0 };
  const total = findings.length;

  for (let i = 0; i < total; i++) {
    const finding = findings[i];
    const ticket = existing.get(finding.dedupId);

    if (finding.state === 'OPEN') {
      if (!ticket) {
        await provider.createTicket(finding);
        result.created++;
      } else {
        const { action } = await provider.updateTicket(finding, ticket);
        if (action === 'updated') result.updated++;
        else if (action === 'reopened') result.reopened++;
        else result.noop++;
      }
    } else {
      // FIXED (or any non-OPEN normalized state)
      if (ticket && !ticket.completed) {
        await provider.closeTicket(ticket);
        result.closed++;
      } else {
        result.skipped++;
      }
    }

    onProgress?.({ processed: i + 1, total, result });
  }

  return result;
}
