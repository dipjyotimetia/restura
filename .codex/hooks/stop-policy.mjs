export function validationDecision({ dirty, signature, previous, passed }) {
  if (!dirty || passed || (previous?.signature === signature && previous.passed === false)) {
    return null;
  }
  return {
    continue: false,
    stopReason:
      'Restura validation is not green. Fix the reported npm run validate failure before stopping.',
  };
}
