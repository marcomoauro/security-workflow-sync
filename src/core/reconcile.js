// Precondition: caller must have invoked provider.loadContext() before calling this.
export async function reconcile(findings, provider) {
  const existing = await provider.listExistingTickets();

  const result = { created: 0, updated: 0, reopened: 0, closed: 0, skipped: 0, noop: 0 };

  for (const finding of findings) {
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
  }

  return result;
}
