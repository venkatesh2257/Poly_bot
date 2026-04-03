Audit snapshot helper (generated 2026-04-03)

1) FILE MANIFEST
   - Look for: AUDIT_FILE_MANIFEST_<timestamp>.txt in this folder
   - One line per file: relative_path<TAB>bytes<TAB>ISO-timestamp
   - Excludes: node_modules, .git, dist, build, .next, coverage, .turbo (paths containing those segments)

2) DIRECTORY COPY
   - Look for: D:\Poly_bot_audit_copy_<timestamp>\
   - Full tree copy of this repo excluding: node_modules, .git, dist, build, .next, coverage, .turbo
   - Excludes *.tsbuildinfo from copy (regenerable)

3) FULL REPO WITH DEPENDENCIES
   - Not copied (too large): node_modules under each workspace
   - To reproduce: open the audit copy folder and run: npm install

4) SECRETS
   - server\.env is gitignored but may exist locally; audit copies may include it if present.
   - Review before sharing any audit folder.
