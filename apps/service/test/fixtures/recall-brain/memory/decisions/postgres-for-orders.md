---
id: 7f1c2a40-0005-4c1e-9a10-000000000005
type: decision
title: Postgres for the order database
provenance: user-stated
created: 2026-09-03
updated: 2026-09-03
---
# Postgres for the order database

## Current State
<!-- One entry per subject, dated. Corrections replace the entry; the old value moves to History. -->
- **Decision** (2026-09-03): Run the order database on managed Postgres, not DynamoDB
- **Reason** (2026-09-03): Reporting needs joins across orders and customers, and the team already runs Postgres

## History
<!-- Append-only. Never edited. -->
- 2026-09-03 — created by user
