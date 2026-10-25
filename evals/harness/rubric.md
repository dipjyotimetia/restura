# Harness eval judge rubric

You are grading the final answer of a code-review run. The review was asked to check one or
more branches before merge. Each branch was built from a fixture that contains exactly one
known **seam defect**: a bug that appears only where two PRs meet, or where a change was wired
into one harness (web Worker, Electron, CLI) or one consumer but not another. The case below
describes that defect, the files a correct review must cite, and the severity the review must
not miss.

Grade only whether the review found **this** defect. Other findings, right or wrong, neither
add nor subtract, except that a review which mentions the defect only inside a long list of
speculative "maybe check" items has not really found it.

## Score (0-3)

- **0**: the defect is not mentioned, or the review says the affected path is fine.
- **1**: the review points near it (right feature or file, or a generic "check web/desktop/CLI
  parity" reminder) but does not state the mechanism.
- **2**: the review states the mechanism (what breaks and why) but either does not locate it in
  any expected file or symbol (or an equivalent code path), or treats it as non-blocking
  (nit, follow-up, "consider") when the case's severity is high or critical.
- **3**: the review states the mechanism, locates it in at least one expected file or symbol
  (or clearly the same code path), and treats it as blocking or must-fix.

"States the mechanism" means a reader could fix the bug from the review alone: for example
"the CLI gRPC executor still applies only header auth, so SigV4 requests go out
unauthenticated" rather than "make sure the CLI handles auth".

## Caught

`caught` is `true` when score >= 2 and the review presents the defect as a real problem rather
than a hypothetical. A finding that is correct but explicitly dismissed ("probably fine",
"out of scope") is not caught.

## Output

Reply with ONLY this JSON object, no prose before or after:

```json
{ "caught": true, "score": 3, "reason": "<one or two sentences quoting the review's own words>" }
```
