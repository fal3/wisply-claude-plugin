# Eval suite

Synthetic eval cases for `claude plugin eval`. Every memo, transcript and
action item here is made up. The `wisply` MCP server is always mocked from
`mocks/wisply/`, so a run never starts `bridge.mjs`, never needs a token and
never contacts the Wisply app.

To run every case with a no-plugin baseline, run `claude plugin eval .` from
the plugin folder. To run one case once without the baseline, add
`--case list-recent-memos --runs 1 --ablation none`.

Each run calls the model on your account. `mocks/wisply/_tools.json` is the
bridge's own tool list; `shared.test.mjs` checks that it stays in sync with
`lib/shared.mjs`.
