# Release Notes Template

GitHub Release bodies are Restura's canonical release notes. The release
workflow generates a draft with conventional-commit entries; before publishing,
replace the two editorial comments at the top using this structure.

```md
## Highlights

- **Area:** Explain one developer-visible outcome in a single sentence.
- **Area:** Explain another important outcome.

## Upgrade notes

- No action required.

## Added

- **Area:** New capability or workflow.

## Changed

- **Area:** Behaviour, performance, or documentation change.

## Deprecated

- **Area:** What will be removed and the replacement.

## Removed

- **Area:** Removed behaviour and migration path.

## Fixed

- **Area:** Corrected behaviour and user impact.

## Security

- **Area:** Security hardening without exposing sensitive implementation detail.

## Contributors

Thanks to @contributor.
```

Omit empty change sections and optional Contributors. Keep Highlights to two to
five practical outcomes, and use Upgrade notes for compatibility, migration, or
an explicit `No action required.` statement. The app renders these headings as
structured release history; older free-form bodies remain readable as Markdown.
