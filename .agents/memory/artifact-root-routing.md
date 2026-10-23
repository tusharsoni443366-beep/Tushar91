---
name: Artifact root routing
description: Root service paths can conflict with registering a root web artifact.
---

Before registering a web artifact with preview path `/`, check the `paths` owned by every existing artifact service. A temporary `paths = ["/"]` entry in another artifact can block root artifact creation.

**Why:** Artifact creation failed while the API artifact also claimed `/`; restoring its `/api`-only routing allowed the root web artifact to register.

**How to apply:** Keep the API service scoped to `/api` and reserve `/` for the root public web artifact. Remove or relocate temporary root service mappings before creating a root artifact.
