# Retired membership infrastructure inventory

These files preserve the original worker/dispatcher CloudFormation resource
layout and Serverless resolver for audit. They are **not deployable packages**:
relative paths describe the original source layout, no artifacts/handlers are
provided, and neither service is in the application deployment catalog.
Do not deploy an empty or modified template over an existing stack.

Use the actual deployed CloudFormation templates and stack IDs for a separately
authorized retirement: inspect exports/imports and retention requirements,
remove monitoring references, delete the dispatcher stack, wait for completion,
then delete the worker stack. The full shutdown, rollout, rollback and database
boundaries are in [membership retirement](../../../docs/membership-retirement.md).
No cloud resource is deleted by moving these files.
