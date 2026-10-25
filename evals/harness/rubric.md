# Harness eval judge rubric

You are grading the final answer of a code-review run. The review was asked to check one or
more branches before merge. The case says whether it is a DEFECT case or a CONTROL.

In a DEFECT case the fixture contains exactly one known **seam defect**: a bug that appears
only where two PRs meet, or where a change was wired into one harness (web Worker, Electron,
CLI) or one consumer but not another. The case describes that defect, the files a correct
review must cite, and the severity the review must not miss. Grade only whether the review
found **this** defect. Other findings, right or wrong, neither add nor subtract, except that a
review which mentions the defect only inside a long list of speculative "maybe check" items has
not really found it.

CONTROL cases are graded with their own section below.

## Score for defect cases (0-3)

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

For a defect case, `caught` is `true` when score >= 2 and the review presents the defect as a real problem rather
than a hypothetical. A finding that is correct but explicitly dismissed ("probably fine",
"out of scope") is not caught.

The harness separately requires the review to name an expected file or symbol (a
`mustMention` pattern), so judge on substance and do not lower the score only because wording
differs.

## Control cases (type: CONTROL)

Some cases are controls: a real merged PR that was genuinely fine and needed no follow-up fix.
There is no defect to find. Grade whether the review **raised a false alarm** about the
fixture's files.

- **3**: no defect reported in the fixture files (READY, or only findings elsewhere).
- **2**: only low-severity remarks, nits or suggestions about the fixture files.
- **1**: a medium-severity defect claimed in the fixture files.
- **0**: a high, critical or blocking defect claimed in the fixture files.

For a control, `caught` means "correctly left clean": `true` when score >= 2. Gate failures
caused by the eval environment (missing tools, network, an unrelated flaky test) are not
defects in the fixture and do not lower the score.

## Output

Reply with ONLY this JSON object, no prose before or after:

```json
{ "caught": true, "score": 3, "reason": "<one or two sentences quoting the review's own words>" }
```
