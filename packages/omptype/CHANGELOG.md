# Changelog

## [Unreleased]

### Added

- Initial release: ArkType-compatible schema validation with a lazy JIT runtime. Schemas interpret their first two calls and compile a specialized validator via `new Function` on the third, making `type()` construction ~100x cheaper than arktype while beating its hot-path validation speed. Supports the string definition DSL (primitives, literals, unions, arrays, bounds, `number.integer`, `string.url`, inline defaults, value-suffix `?` optionals), object definitions (`"+": "reject"/"delete"`, `"[string]"` index signatures), `type.errors`/`OmpErrors` with per-entry `path`/`problem`, `type.enumerated`, `type.raw`, keyword statics, composition methods (`.or/.and/.array/.pipe/.narrow/.describe/.default/.allows/.assert`), static inference via `typeof schema.infer`, and draft-2020-12 `toJsonSchema()` emission.
- TypeBox-style (`@oh-my-pi/omptype/typebox`) and Zod-style (`@oh-my-pi/omptype/zod`) authoring adapters producing native omptype schemas.
- Added recursive named scopes, modules and runtime generics; fixed/optional/variadic tuples; Date literals and bounds; nested string and parse keyword modules; disjointness-aware intersections; structural mapping, selection, distribution and semantic comparison; separate input/output inference; configurable error codes and `byPath`; and JSON Schema target, dialect and fallback handling.
- npm package now ships transpiled ESM in `dist/js` and declarations in `dist/types`, so it runs on plain Node without Bun or a TS loader; Bun consumers keep resolving TS source via the `bun` export condition.

### Changed

- Expanded the lazy JIT across tuples, refinements, morphs, intersections, instances, and recursive aliases; reused compiled validators for shared IR; added allocation-free statement code generation for `.allows()`; and tightened object, array, number, and literal-union checks.
- Reduced schema construction overhead with direct nested-object parsing, non-Date DSL dispatch guards, and ASCII-fast whitespace and optional-key scans.

### Fixed

- Fixed TS2589 ("type instantiation is excessively deep") on every generic fluent call (`.pipe`/`.narrow`/`.filter`) over schemas embedding other schemas: `InferDef`/`InferDefIn` now cut off `any` up front so TypeScript's permissive instantiation cannot recurse through spread/index members, spread and index-signature recursion is boxed behind an interface member, primitive keyword lookup is a flat map instead of a nested conditional chain, and member inference tail-chains its fallbacks.
- `type.raw()` results (`BaseType`) now expose the fluent composition methods (`.array()`, `.or()`, `.pipe()`, …) instead of only the callable validator surface.
