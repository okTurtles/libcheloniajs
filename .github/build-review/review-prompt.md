@PROJECT_CONTEXT@

Run the `code-review` skill to audit a release build. This is not a normal code review: the audit rules below replace the review focus in Section 3 of the skill. Keep the rest of the skill: its procedure, the split of a massive diff into slices that crush workers review in batches of at most three, the `## Unreviewed files` section and the review format. The audit rules are also in `AGENTS.md` at the repository root.

This is an unattended CI run. Run parameters:

- Nobody can answer questions. If the skill needs user input or hits an error, report the problem in your final response and stop.
- Base ref: `base-build` (pass it as `--base`). HEAD is `release-build`.
- Output file: write the review to `@REVIEW_OUTPUT_FILE@`, not to `REVIEW.md` in the repository root (the repository is read-only).
- Model for the review header: `@REVIEW_MODEL@`.
- Put the complete audit rules in every worker prompt.

@AUDIT_RULES@
