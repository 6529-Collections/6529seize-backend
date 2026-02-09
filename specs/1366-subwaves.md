# Subwaves Feature Spec (Decision-Complete)

## Summary
Add first-class one-level subwaves to organize conversations inside a wave, with explicit parent-child linkage, strict validation, and access controls that preserve independent subwave groups while granting parent admins implicit moderation powers.

## Critique Of Original Draft (Resolved Here)
1. Request model naming was ambiguous: current create endpoint uses `ApiCreateNewWave`, not `ApiCreateWaveRequest`.
2. Read/admin permissions needed exact enforcement points (wave fetch, list, update/delete, drop deletion).
3. List semantics were ambiguous (`include_sub_waves` vs `subwaves_of_wave_id`).
4. Parent delete behavior was unspecified.
5. DM-wave compatibility was unspecified.
6. Parent visibility leakage behavior was unspecified.

## Public API / Interface Changes

### 1) New wave schema fields
1. Add `parent_wave_id: string | null` to DB wave entity and API create model.
2. Add new API schema/model `ApiWaveLight` with fields:
1. `id: string`
2. `name: string`
3. `picture: string | null`
3. Add to `ApiWave`:
1. `parent_wave: ApiWaveLight | null`
2. `subwaves: ApiWaveLight[]`
4. Add to `ApiWaveMin`:
1. `parent_wave: ApiWaveLight | null`
2. `subwaves: ApiWaveLight[]`

### 2) Query params
1. Add `include_sub_waves: boolean` (default `false`) to:
1. `GET /waves`
2. `GET /waves-overview`
3. `GET /waves-overview/hot`
2. Add `subwaves_of_wave_id: string` (optional) to `GET /waves`.
3. Rule: if `subwaves_of_wave_id` is set, ignore `include_sub_waves` and return only direct subwaves of that parent.

### 3) Create wave request
1. Add optional `parent_wave_id: string | null` to `ApiCreateNewWave`.
2. If present, creation is “create subwave” and uses subwave authorization/validation rules below.
3. `parent_wave_id` is immutable on update.

## Data Model

### 1) DB changes
1. Add nullable column `parent_wave_id varchar(100)` to `waves` and `waves_archive`.
2. Add index `idx_waves_parent_wave_id` on `waves(parent_wave_id)`.
3. No foreign key constraint (project rule).
4. Default for existing rows is `NULL`.

### 2) Entity/type changes
1. Extend `WaveBaseType`/`WaveBase`/`WaveEntity`/archive insert-read mappings with `parent_wave_id`.
2. Extend `InsertWaveEntity` and mapper inputs to carry `parent_wave_id`.

## Authorization and Access Rules

### 1) Create subwave
1. Allowed only if caller is:
1. parent wave creator, or
2. member of parent wave `admin_group_id`.
2. If parent has `admin_group_id = null`, only parent creator can create subwave.
3. Proxies follow existing create-wave proxy rules (no additional bypass).

### 2) Implicit rights from parent
1. Members of parent `admin_group_id` get implicit rights on each direct subwave:
1. implicit read access (as if in subwave visibility group),
2. implicit admin rights (as if in subwave admin group).
2. Parent creator does not receive implicit rights unless they also satisfy group/admin checks.
3. Parent admins additionally can update subwave config (`POST /waves/{id}`).

### 3) Subwave groups
1. Subwave `visibility/participation/chat/voting/admin` groups remain independent from parent.
2. They are not required to be subsets of parent groups.

## Validation Rules

1. Parent must exist when `parent_wave_id` is provided.
2. Parent must be non-DM (`is_direct_message = false`).
3. Child must be non-DM (subwaves are disallowed for DM waves).
4. Parent must be top-level (`parent_wave_id IS NULL`) because hierarchy depth is strictly one level.
5. A wave that is already a subwave cannot have subwaves.
6. `parent_wave_id` cannot be changed on wave update.
7. Self-parenting is invalid (`parent_wave_id !== id`).
8. Existing create/update wave validations remain unchanged unless explicitly overridden above.

## Endpoint Semantics

### 1) `GET /waves`
1. Default behavior (`include_sub_waves=false`, no `subwaves_of_wave_id`): return only top-level waves.
2. `include_sub_waves=true`: return top-level + eligible direct subwaves in same list.
3. `subwaves_of_wave_id=<id>`: return only eligible direct subwaves of parent `<id>`.
4. Combine existing filters with subwave filters safely (name/author/group/direct_message remain supported where valid).

### 2) `GET /waves-overview` and `/hot`
1. Default: only top-level waves.
2. With `include_sub_waves=true`: include eligible direct subwaves in returned list.
3. Ranking logic remains existing; inclusion filter only changes candidate set.

### 3) Wave representation fields
1. `parent_wave`:
1. If no parent, `null`.
2. If parent exists and caller can read parent, map from parent.
3. If parent exists but caller cannot read parent, still return limited parent `ApiWaveLight` (explicit product decision).
2. `subwaves`:
1. Return only direct subwaves caller can read (including implicit parent-admin read rule).
2. Always present; empty array if none eligible.

### 4) Mutating endpoints
1. `POST /waves` supports creating subwaves via `parent_wave_id`.
2. `POST /waves/{id}` cannot modify parent relation.
3. `DELETE /waves/{id}` for parent with children: reject (block delete) with 409/400 until subwaves are removed.

## Internal Implementation Plan (Code Areas)

1. `src/entities/IWave.ts`: add `parent_wave_id`.
2. `src/api-serverless/src/waves/waves.api.db.ts`:
1. read/write/archive SQL include `parent_wave_id`,
2. add helper queries:
1. `findDirectSubwaves(parentId, visibility/admin context)`,
2. `findParentWaveLight(parentId)`,
3. `countSubwaves(parentId)`,
4. apply top-level/subwave filters across search/overview/hot query builders.
3. `src/api-serverless/src/waves/wave.api.service.ts`:
1. validate subwave creation constraints,
2. enforce parent-based create authorization,
3. enforce parent-admin implicit read/admin checks for subwave operations (read/update/delete),
4. block parent delete when children exist.
4. `src/api-serverless/src/waves/waves.mappers.ts`:
1. map `parent_wave` and `subwaves` for `ApiWave`,
2. include access filtering.
5. `src/api-serverless/src/drops/drops.mappers.ts`:
1. include new `ApiWaveMin` fields (`parent_wave`, `subwaves`) in all `ApiWaveMin` mapping paths.
6. `src/drops/delete-drop.use-case.ts`:
1. allow parent-admin implicit admin rights for deleting drops in subwaves.
7. `src/api-serverless/src/waves/waves.routes.ts` and `waves-overview.routes.ts`:
1. add Joi params (`include_sub_waves`, `subwaves_of_wave_id`),
2. pass through to services.
8. `src/api-serverless/openapi.yaml`:
1. add params and schema fields/models.
9. Regenerate models:
1. `cd src/api-serverless && npm run restructure-openapi && npm run generate`

## Testing and Acceptance Criteria

### Unit/Service tests
1. Create subwave succeeds for parent creator.
2. Create subwave succeeds for parent admin-group member.
3. Create subwave fails for non-admin/non-creator.
4. Create subwave fails if parent is DM.
5. Create subwave fails if parent is already a subwave.
6. Update wave request containing `parent_wave_id` change fails.
7. Parent delete fails while children exist.
8. Parent-admin can update subwave.
9. Parent-admin can delete subwave.
10. Parent-admin can delete subwave drop (when admin delete flow used).

### API behavior tests
1. `GET /waves` default excludes subwaves.
2. `GET /waves?include_sub_waves=true` includes both top-level and subwaves.
3. `GET /waves?subwaves_of_wave_id=X` returns only direct subwaves of X.
4. `GET /waves-overview` and `/hot` default exclude subwaves; include with flag.
5. `parent_wave` and `subwaves` are present in `ApiWave` and `ApiWaveMin`.
6. `subwaves` list contains only eligible/readable children.
7. Inaccessible parent still yields limited `parent_wave` object.
8. Existing non-subwave wave behavior remains unchanged for auth and filters.

### Regression checks
1. Existing DM creation/listing still works.
2. Existing wave search filters still work.
3. OpenAPI generation compiles and TypeScript build passes.
4. No foreign keys introduced by migration.

## Assumptions and Defaults Locked In
1. Hierarchy depth is strictly one level.
2. Deleting parent with subwaves is blocked (no cascade, no orphaning).
3. Implicit rights are granted to parent admin group members only.
4. Parent admins can fully update subwaves.
5. DM waves cannot be parents or children in subwave relationships.
6. `subwaves_of_wave_id` takes precedence and ignores `include_sub_waves`.
7. `include_sub_waves=true` returns parent and child rows together in list responses.
8. If parent is not readable, still return limited `parent_wave` (`ApiWaveLight`).
