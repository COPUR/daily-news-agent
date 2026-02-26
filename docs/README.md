# Daily News Agent Documentation

This folder contains the active, implementation-level documentation for the Node.js runtime.

## Documents

- `ARCHITECTURE_UML.md`
  - System context
  - Component design
  - Use cases
  - UML diagrams (class, state, sequence)
  - API surface map

- `INTEGRATION_MAP.md`
  - Inbound/outbound integration boundaries
  - Provider and connector mapping
  - Health probe and observability coverage
  - Error/recovery paths

- `DEPENDENCY_MAP.md`
  - Runtime package dependency layers
  - Internal module dependency graph
  - Critical-path dependency chains
  - Upgrade and risk notes

- `IMPLEMENTATION_DOCUMENTATION.md`
  - Module-by-module implementation details
  - Pipeline and newsletter runtime behavior
  - API service and persistence implementation
  - Extension and customization guide

- `MIGRATION_GUARDRAILS.md`
  - Public-repo safety rules for migration
  - No business/database data policy
  - SQL creation-script-only policy
  - CI enforcement command

- `DATA_JOURNEY.md`
  - End-to-end data lineage from source ingestion to posting
  - Stage-by-stage transformations and persistence boundaries
  - Lineage IDs, auditability, and recovery paths

- `RUNTIME_OPERATIONS.md`
  - Startup and runtime behavior
  - Scheduler and pipeline execution model
  - Health, observability, logs, and runbooks
  - Runtime config and secrets operations

- `DEPLOYMENT_GUIDE.md`
  - Local and container deployment models
  - Release/rollback process
  - Storage persistence and backup strategy
  - Hardening checklist

- `CI_CD.md`
  - Current GitHub Actions pipelines
  - CI gates and local parity commands
  - Release flow and gap analysis for Node image publishing

- `SECURITY_CMMI_BASELINE.md`
  - Internal JWT lifecycle service security controls
  - CMMI-oriented validation, risk, and auditability mapping
  - Configuration and residual risk checklist

- `openapi/internal-jwt-lifecycle.yaml`
  - OpenAPI 3.0 signature for internal JWT lifecycle endpoints

- `openapi/keycloak-gateway-aaa.yaml`
  - OpenAPI 3.0 signature for Keycloak gateway AAA endpoints
  - Public auth config and role-based introspection routes

## Scope

These docs reflect the Node runtime under:

- `src/`
- `prisma/schema.prisma`
- `.github/workflows/ci.yml`
- `Dockerfile` and `docker-compose.yml`
