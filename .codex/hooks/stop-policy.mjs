export function validationDecision({ dirty, signature, previous }) {
  if (!dirty || (previous?.signature === signature && previous.passed === true)) {
    return null;
  }
  return {
    continue: false,
    stopReason:
      'Restura validation evidence is missing or stale. Run npm run validate explicitly before stopping.',
  };
}
