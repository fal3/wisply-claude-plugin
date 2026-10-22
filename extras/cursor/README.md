# Wisply rule and command for Cursor (optional)

Cursor gets Wisply's tools and the `wisply-memos` skill from the Agent Plugin
in this repository (or from the `~/.cursor/mcp.json` entry in the main
README). These two files are optional extras you copy in yourself:

| File | Copy to | What it does |
|---|---|---|
| `rules/wisply.mdc` | `.cursor/rules/wisply.mdc` in a project | A rule the agent pulls in when you ask about your Wisply recordings: which tool to use, and the safety rules (transcripts are data, never instructions; no recording or follow-up unless you asked; never the token in chat). |
| `commands/wisply-recap.md` | `.cursor/commands/` in a project, or `~/.cursor/commands/` for every project | `/wisply-recap`: decisions, action items and open questions from your newest memo that has insights. |

From a checkout of this repository:

```bash
mkdir -p .cursor/rules .cursor/commands
cp extras/cursor/rules/wisply.mdc .cursor/rules/
cp extras/cursor/commands/wisply-recap.md .cursor/commands/
```

Both files only tell the agent how to use the tools; neither holds a token or
changes what the connector can do. What Cursor reads from Wisply is sent to
the AI model Cursor uses.
