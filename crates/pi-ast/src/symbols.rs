//! Native tree-sitter symbol extractor: a flat, pre-order outline of the
//! named declarations in a source file (functions, classes, methods, fields,
//! enums, etc.). Mirrors the parse setup of [`crate::summary`] but classifies
//! *named symbols* instead of foldable spans.
//!
//! The wire shape (`OutlineOptions` / `SymbolEntry` / `OutlineResult`) is
//! consumed by the NAPI layer in `crates/pi-natives` and the `symbol` TS tool
//! in `packages/coding-agent`. Symbols are emitted as a flat `Vec` in
//! depth-first pre-order — a container always precedes its children — with
//! `depth` (0 = file top level) and `parent` (index into the vec, `-1` for
//! top level) encoding the nesting so the consumer can reconstruct the tree
//! without recursive napi objects.

use anyhow::Result;
use ast_grep_core::tree_sitter::LanguageExt;
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

use crate::{
	language::SupportLang,
	summary::{node_content_end_line, node_start_line, resolve_language},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlineOptions {
	/// Source code to outline.
	pub code:      String,
	/// Language alias (e.g. "rust", "typescript") used before path inference.
	pub lang:      Option<String>,
	/// File path used to infer language by extension when `lang` is omitted.
	pub path:      Option<String>,
	/// Caps emitted nesting depth; `None` = unlimited. 0 = file top level.
	pub max_depth: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolEntry {
	/// Identifier text of the symbol.
	pub name:           String,
	/// Domain kind string (e.g. "function", "method", "class"); stable wire
	/// value mapped to an LSP `SymbolKind` by the TS layer.
	pub kind:           String,
	/// 1-based first line of the construct, INCLUDING attached
	/// decorators/attributes/annotations so an exact-range edit captures the
	/// whole thing.
	pub start_line:     u32,
	/// 1-based last content line of the declaration (via
	/// `node_content_end_line`).
	pub end_line:       u32,
	/// 1-based line of the name identifier (display/navigation anchor).
	pub selection_line: u32,
	/// One-line signature: trimmed source slice from the node's start byte to
	/// the body's start byte (parameters / return type / type parameters
	/// included when present); falls back to the first source line when the
	/// construct has no body.
	pub detail:         Option<String>,
	/// Logical container name for symbols whose real container is NOT an
	/// emitted parent symbol. Populated only for Rust associated items inside
	/// an `impl_item` (container = the impl's `type` field text, e.g.
	/// `impl Foo` → `Foo`) and Go `method_declaration` (container = the
	/// receiver type with a leading `*`/`&` stripped). `None` everywhere
	/// else — where a real `parent` symbol already conveys nesting (TS/JS
	/// class methods, Python class methods, Rust trait methods, Rust
	/// struct/enum/trait/mod items, Go plain functions, Java members).
	pub container:      Option<String>,
	/// 0 = file top level.
	pub depth:          u32,
	/// Index into the flat `Vec<SymbolEntry>`, `-1` for top level.
	pub parent:         i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutlineResult {
	/// Canonical language name when parsing succeeded.
	pub language: Option<String>,
	/// True when tree-sitter parsed the source without syntax errors.
	pub parsed:   bool,
	/// Flat pre-order symbol list.
	pub symbols:  Vec<SymbolEntry>,
}

/// Outline the named symbols in `options.code`.
///
/// Unsupported languages and parse errors never error: they return
/// `OutlineResult { parsed: false|true, symbols: vec![] }`.
pub fn outline_code(options: OutlineOptions) -> Result<OutlineResult> {
	let source = options.code;

	// Resolve the language BEFORE the empty-source fast path so an empty
	// `index.ts` keeps its language identity (`language: Some("typescript")`,
	// `parsed: true`, `symbols: []`) instead of degrading to
	// `language: None, parsed: false`. Only a truly unresolved language
	// returns `language: None`.
	let Some(language) = resolve_language(options.lang.as_deref(), options.path.as_deref()) else {
		return Ok(OutlineResult { language: None, parsed: false, symbols: vec![] });
	};

	if source.is_empty() {
		return Ok(OutlineResult {
			language: Some(language.canonical_name().to_string()),
			parsed:   true,
			symbols:  vec![],
		});
	}

	let mut parser = Parser::new();
	parser
		.set_language(&language.get_ts_language())
		.map_err(|err| anyhow::anyhow!("Failed to load tree-sitter language: {err}"))?;
	let Some(tree) = parser.parse(&source, None) else {
		return Ok(OutlineResult {
			language: Some(language.canonical_name().to_string()),
			parsed:   false,
			symbols:  vec![],
		});
	};
	let root = tree.root_node();
	if root.has_error() {
		return Ok(OutlineResult {
			language: Some(language.canonical_name().to_string()),
			parsed:   false,
			symbols:  vec![],
		});
	}

	let mut walker = Walker {
		symbols: Vec::new(),
		source: source.as_bytes(),
		language,
		max_depth: options.max_depth,
	};
	walker.walk(root, 0, -1, None);

	Ok(OutlineResult {
		language: Some(language.canonical_name().to_string()),
		parsed:   true,
		symbols:  walker.symbols,
	})
}

// ── Extractor ───────────────────────────────────────────────────────────

struct Walker<'a> {
	symbols:   Vec<SymbolEntry>,
	source:    &'a [u8],
	language:  SupportLang,
	max_depth: Option<u32>,
}

impl<'a> Walker<'a> {
	/// Depth-first walk. `depth` is the current nesting depth (0 = file top
	/// level); `parent` is the index of the enclosing emitted symbol, or `-1`.
	///
	/// `start_override` carries a wrapper-adjusted first line (`export`
	/// keyword / decorator line) down through passthrough nodes so the FIRST
	/// emitted symbol in this subtree is anchored at the wrapper's line. It is
	/// consumed by the first symbol emission and does not propagate past it.
	///
	/// Wrapper nodes that adjust the emitted `start_line` (`export_statement`,
	/// `decorated_definition`) are unwrapped here: we emit the *inner*
	/// declaration with the wrapper's start line, then recurse into the inner
	/// declaration's children only — so the inner declaration is never visited
	/// twice (once via the wrapper, once as the wrapper's child).
	///
	/// List/container nodes (`class_body`, `declaration_list`,
	/// `field_declaration_list`, `enum_variant_list`, `type_declaration`,
	/// `const_declaration`, `lexical_declaration`, ...) are passthroughs: they
	/// are never emitted as symbols; we recurse through them carrying the same
	/// `parent`/`depth` (and a still-unconsumed `start_override`) so their
	/// named children attribute to the real enclosing symbol.
	fn walk(&mut self, node: Node<'_>, depth: u32, parent: i32, start_override: Option<u32>) {
		if let Some(max) = self.max_depth {
			if depth > max {
				return;
			}
		}

		let kind = node.kind();

		// Unwrap leading-token wrappers, pinning `start_line` to the wrapper's
		// first line so an edit spans `export` / the decorators. The override
		// is carried down so a wrapper around a *passthrough* (e.g.
		// `export const` -> `lexical_declaration` -> `variable_declarator`)
		// still anchors the eventual declarator at the `export` line.
		let (emit_node, wrapper_start): (Node<'_>, Option<u32>) = match self.language {
			SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript
				if kind == "export_statement" =>
			{
				match node.child_by_field_name("declaration") {
					// Named export (`export function/const/...` and
					// `export default function/class Named`): unwrap to the
					// declaration, anchoring it at the `export` line. The
					// tree-sitter-typescript grammar routes ALL named default
					// declarations (`export default class Foo`, `export default
					// function bar`) through the `declaration` field as
					// `class_declaration`/`function_declaration`, so this covers
					// both `export` and named `export default`.
					Some(decl) => (decl, Some(node_start_line(node))),
					None => {
						// `export default <expr>` with no `declaration` field:
						// the `value` field holds an expression. Peel a wrapping
						// `parenthesized_expression` (`export default (class
						// Named {})`) to reach the inner expression, then unwrap
						// ONLY when it is a NAMED class/function expression —
						// anonymous defaults (`export default () => 1`,
						// `export default class {}`, `export default function()`)
						// have no name to address and stay passthrough (v1).
						let val = node.child_by_field_name("value");
						let inner = val.and_then(peel_parenthesized);
						if let Some(expr) = inner {
							if expr_has_name(expr) {
								(expr, Some(node_start_line(node)))
							} else {
								(node, start_override)
							}
						} else {
							(node, start_override)
						}
					},
				}
			},
			SupportLang::Python if kind == "decorated_definition" => {
				match node.child_by_field_name("definition") {
					Some(inner) => (inner, Some(node_start_line(node))),
					None => (node, start_override),
				}
			},
			_ => (node, start_override),
		};

		// The first emitted symbol in this subtree uses the override if one is
		// in flight (wrapper > prior override > own start line).
		let start_line = wrapper_start
			.or(start_override)
			.unwrap_or_else(|| node_start_line(emit_node));

		// Try to emit `emit_node` as a symbol. When it emits, recurse into
		// `emit_node`'s children (NOT `node`'s) to find nested symbols — this
		// is what prevents the wrapper from re-emitting its inner declaration.
		// The override is consumed (None) for the recursive children.
		if let Some(idx) = self.emit_symbol(emit_node, depth, parent, start_line) {
			let new_parent = idx as i32;
			let new_depth = depth + 1;
			for i in 0..emit_node.child_count() {
				if let Some(child) = emit_node.child(i) {
					self.walk(child, new_depth, new_parent, None);
				}
			}
			return;
		}

		// Passthrough: recurse into the original node's children with unchanged
		// parent/depth. Covers list containers, wrapper nodes whose inner decl
		// is itself a non-symbol passthrough (e.g. `export const` ->
		// `lexical_declaration` -> `variable_declarator`), and non-symbol
		// nodes. The carry-down override is `wrapper_start.or(start_override)`
		// so the eventual first symbol inherits the wrapper's start line; once
		// a wrapper contributed an override it supersedes any inherited one.
		let carry = wrapper_start.or(start_override);
		for i in 0..node.child_count() {
			if let Some(child) = node.child(i) {
				self.walk(child, depth, parent, carry);
			}
		}
	}
}

// ── Shared helpers ─────────────────────────────────────────────────────

impl<'a> Walker<'a> {
	/// If `node` is a named symbol for `self.language`, push one or more
	/// `SymbolEntry`(s) and return the index of the *primary* (first) emitted
	/// entry so children can parent to it. Returns `None` for passthrough
	/// nodes. `start_line` is the (possibly wrapper-adjusted) first line.
	/// Multi-name declarations (Go specs, Java field declarators) emit one
	/// entry per name but still report the first as the container index.
	fn emit_symbol(
		&mut self,
		node: Node<'_>,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		let kind = node.kind();
		match self.language {
			SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => {
				self.emit_ts_js(node, kind, depth, parent, start_line)
			},
			SupportLang::Python => self.emit_python(node, kind, depth, parent, start_line),
			SupportLang::Rust => self.emit_rust(node, kind, depth, parent, start_line),
			SupportLang::Go => self.emit_go(node, kind, depth, parent, start_line),
			SupportLang::Java => self.emit_java(node, kind, depth, parent, start_line),
			_ => None,
		}
	}

	/// Text of a node (source is valid UTF-8 from the TS tool).
	fn text(&self, node: Node<'_>) -> String {
		let bytes = &self.source[node.start_byte()..node.end_byte()];
		String::from_utf8_lossy(bytes).into_owned()
	}

	/// Name text via `child_by_field_name(field)`.
	fn name_text(&self, node: Node<'_>, field: &str) -> Option<String> {
		let name_node = node.child_by_field_name(field)?;
		Some(self.text(name_node))
	}

	/// `selection_line` = line of the name node; falls back to the node's own
	/// start line when the name field is absent.
	fn selection_line(&self, node: Node<'_>, name_field: &str) -> u32 {
		node
			.child_by_field_name(name_field)
			.map(node_start_line)
			.unwrap_or_else(|| node_start_line(node))
	}

	/// Trimmed, single-line signature slice. When `body_field` is provided and
	/// present, slice from the node's start byte to the body's start byte
	/// (parameters / return type / type parameters included). Otherwise fall
	/// back to the node's first source line.
	fn detail(&self, node: Node<'_>, body_field: Option<&str>) -> Option<String> {
		let start = node.start_byte();
		let body_start = body_field
			.and_then(|f| node.child_by_field_name(f))
			.map(|b| b.start_byte());
		let bytes = match body_start {
			Some(e) if e > start => &self.source[start..e],
			_ => {
				let slice = &self.source[start..node.end_byte()];
				let nl = slice
					.iter()
					.position(|&b| b == b'\n')
					.unwrap_or(slice.len());
				&slice[..nl]
			},
		};
		let s = std::str::from_utf8(bytes).ok()?;
		let trimmed = s.trim();
		if trimmed.is_empty() {
			None
		} else {
			// Cap before normalizing so a minified/generated single line does not
			// allocate an unbounded Vec/String for this one-line detail preview.
			const MAX_DETAIL_BYTES: usize = 256;
			let mut end = trimmed.len().min(MAX_DETAIL_BYTES);
			while end < trimmed.len() && !trimmed.is_char_boundary(end) {
				end -= 1;
			}
			Some(
				trimmed[..end]
					.split_whitespace()
					.collect::<Vec<_>>()
					.join(" "),
			)
		}
	}

	/// Push a symbol with `container: None` and return its index.
	fn push(
		&mut self,
		name: String,
		kind: &str,
		node: Node<'_>,
		start_line: u32,
		selection_line: u32,
		detail: Option<String>,
		depth: u32,
		parent: i32,
	) -> usize {
		self.push_with_container(
			name,
			kind,
			node,
			start_line,
			selection_line,
			detail,
			depth,
			parent,
			None,
		)
	}

	/// Push a symbol with an explicit `container` and return its index.
	/// `container` is set only for symbols whose logical container is not an
	/// emitted parent (Rust impl-associated items, Go method receivers); it is
	/// `None` for everything else, where the `parent` index conveys nesting.
	fn push_with_container(
		&mut self,
		name: String,
		kind: &str,
		node: Node<'_>,
		start_line: u32,
		selection_line: u32,
		detail: Option<String>,
		depth: u32,
		parent: i32,
		container: Option<String>,
	) -> usize {
		let idx = self.symbols.len();
		self.symbols.push(SymbolEntry {
			name,
			kind: kind.to_string(),
			start_line,
			end_line: node_content_end_line(node),
			selection_line,
			detail,
			container,
			depth,
			parent,
		});
		idx
	}
}

/// Immediate parent node kind.
fn parent_kind(node: Node<'_>) -> Option<&'static str> {
	node.parent().map(|p| p.kind())
}

/// Parent-of-parent node kind.
fn grandparent_kind(node: Node<'_>) -> Option<&'static str> {
	node.parent().and_then(|p| p.parent()).map(|p| p.kind())
}

/// Peel a `parenthesized_expression` wrapper to its sole named child, returning
/// the inner expression node. Used for `export default (class Foo {})` where
/// the `value` field is a `parenthesized_expression` wrapping a named class or
/// function expression. Returns the node unchanged if it is not a
/// `parenthesized_expression`.
fn peel_parenthesized(node: Node<'_>) -> Option<Node<'_>> {
	if node.kind() != "parenthesized_expression" {
		return Some(node);
	}
	// The sole named child is the inner expression.
	node.named_child(0)
}

/// True when a TS/JS expression node carries a name worth emitting as a
/// symbol: `class`/`function_expression` with a `name` field, or a
/// `class_declaration`/`function_declaration` (defensive — the grammar routes
/// named defaults through `declaration`, but accept them here too so a future
/// grammar shift cannot silently drop a named default export). Anonymous
/// expressions (`() => 1`, `function() {}`, `class {}`) have no name field.
fn expr_has_name(node: Node<'_>) -> bool {
	matches!(node.kind(), "class" | "function_expression")
		&& node.child_by_field_name("name").is_some()
}

/// True when `node` is the value of an `export default` statement, walking
/// up through any wrapping `parenthesized_expression`. Used to guard the
/// `class`/`function_expression` emit arms so they fire ONLY for named
/// default-export values (e.g. `export default (class Foo {})`) and never
/// for a named expression nested inside a `const`/`variable_declarator`
/// (which is already emitted by the declarator arm and must not duplicate).
fn is_export_default_value(node: Node<'_>) -> bool {
	let mut cur = node.parent();
	while let Some(p) = cur {
		match p.kind() {
			"parenthesized_expression" => cur = p.parent(),
			"export_statement" => {
				// Confirm this node is reached via the `value` field, not the
				// `declaration` field: the `value` child's byte range must
				// contain `node` (peeling through `parenthesized_expression`).
				// Declaration-field defaults are already unwrapped to
				// `class_declaration`/`function_declaration` and never reach
				// the expression arms, but this byte-range check makes the
				// guard airtight against any future routing.
				let Some(value) = p.child_by_field_name("value") else {
					return false;
				};
				return value.start_byte() <= node.start_byte() && node.end_byte() <= value.end_byte();
			},
			_ => return false,
		}
	}
	false
}

/// Map a tree-sitter node kind to its domain kind string for the supported
/// languages. Returns `None` for node kinds that are not named symbols
/// (list/container nodes, non-symbol nodes) or that require *contextual*
/// classification (handled by the per-language `emit_*` emitters rather than
/// this table):
/// - JS/TS `variable_declarator` (`function`/`constant`/`variable` depends on
///   the initializer and the `const`/`let`/`var` keyword).
/// - Python `function_definition` (`function` vs `method` depends on whether it
///   nests in a class) and `expression_statement` assignments
///   (`constant`/`variable`/`field` depends on the LHS and scope).
/// - Rust `function_item`/`function_signature_item` (`function` vs `method`
///   depends on whether the parent is an `impl_item`/`trait_item`).
/// - TS `method_definition` (`method` vs `constructor` depends on the name).
/// - TS `enum_body` bare members (emitted directly from the `name` field, not
///   via a node kind).
///
/// The contextual `emit_*` emitters encode these mappings inline (with the
/// scoping overrides above) rather than calling this function; this table is
/// the stable kind-contract the assignment requires and a reference for the
/// NAPI/TS layers. Kept `#[allow(dead_code)]` as the documented kind table.
#[allow(dead_code)]
fn symbol_kind(language: SupportLang, node_kind: &str) -> Option<&'static str> {
	match language {
		SupportLang::TypeScript | SupportLang::Tsx | SupportLang::JavaScript => match node_kind {
			"function_declaration" | "generator_function_declaration" | "function_signature" => {
				Some("function")
			},
			"class_declaration" | "abstract_class_declaration" => Some("class"),
			"method_definition" | "method_signature" | "abstract_method_signature" => Some("method"),
			"public_field_definition" | "property_signature" => Some("property"),
			"field_definition" => Some("field"),
			"interface_declaration" => Some("interface"),
			"type_alias_declaration" => Some("type_alias"),
			"enum_declaration" => Some("enum"),
			"enum_assignment" => Some("enum_member"),
			"internal_module" => Some("namespace"),
			_ => None,
		},
		SupportLang::Python => match node_kind {
			"function_definition" => Some("function"),
			"class_definition" => Some("class"),
			_ => None,
		},
		SupportLang::Rust => match node_kind {
			"function_item" | "function_signature_item" => Some("function"),
			"struct_item" | "union_item" => Some("struct"),
			"field_declaration" => Some("field"),
			"enum_item" => Some("enum"),
			"enum_variant" => Some("enum_member"),
			"trait_item" => Some("trait"),
			"mod_item" => Some("module"),
			"const_item" => Some("constant"),
			"static_item" => Some("variable"),
			"type_item" | "associated_type" => Some("type_alias"),
			"macro_definition" => Some("macro"),
			_ => None,
		},
		SupportLang::Go => match node_kind {
			"function_declaration" => Some("function"),
			"method_declaration" | "method_elem" => Some("method"),
			"type_spec" | "type_alias" => Some("type_alias"),
			"field_declaration" => Some("field"),
			"const_spec" => Some("constant"),
			"var_spec" => Some("variable"),
			_ => None,
		},
		SupportLang::Java => match node_kind {
			"class_declaration" | "record_declaration" => Some("class"),
			"interface_declaration" | "annotation_type_declaration" => Some("interface"),
			"enum_declaration" => Some("enum"),
			"enum_constant" => Some("enum_member"),
			"method_declaration" | "annotation_type_element_declaration" => Some("method"),
			"constructor_declaration" | "compact_constructor_declaration" => Some("constructor"),
			"field_declaration" => Some("field"),
			_ => None,
		},
		_ => None,
	}
}

// ── TypeScript / TSX / JavaScript ────────────────────────────────────────

impl<'a> Walker<'a> {
	fn emit_ts_js(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		let is_ts = matches!(self.language, SupportLang::TypeScript | SupportLang::Tsx);
		let is_js = matches!(self.language, SupportLang::JavaScript);

		match kind {
			"function_declaration" | "generator_function_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"class_declaration" | "abstract_class_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "class", node, start_line, sel, detail, depth, parent))
			},
			// Named default-export expressions (`export default (class Foo {})`,
			// `export default (function bar {})`): the `walk` unwrap peels the
			// `export_statement`'s `value` field (and any wrapping
			// `parenthesized_expression`) down to this node. The
			// `is_export_default_value` guard ensures we fire ONLY for that
			// path — a named expression nested in a `const`/`variable_declarator`
			// is already emitted by the declarator arm and must NOT duplicate.
			"class" if is_export_default_value(node) => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "class", node, start_line, sel, detail, depth, parent))
			},
			"function_expression" if is_export_default_value(node) => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"method_definition" => {
				// Only class-body methods; skip object-literal methods (whose
				// parent is `object`, not `class_body`).
				if parent_kind(node) != Some("class_body") {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let kind_str = if name == "constructor" {
					"constructor"
				} else {
					"method"
				};
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			"method_signature" | "abstract_method_signature" if is_ts => {
				if !matches!(parent_kind(node), Some("class_body") | Some("interface_body")) {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "method", node, start_line, sel, detail, depth, parent))
			},
			"public_field_definition" if is_ts => {
				if parent_kind(node) != Some("class_body") {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "property", node, start_line, sel, detail, depth, parent))
			},
			"field_definition" if is_js => {
				if parent_kind(node) != Some("class_body") {
					return None;
				}
				// JS uses field `property` (not `name`).
				let name = self.name_text(node, "property")?;
				let sel = self.selection_line(node, "property");
				let detail = self.detail(node, None);
				Some(self.push(name, "field", node, start_line, sel, detail, depth, parent))
			},
			"property_signature" if is_ts => {
				if parent_kind(node) != Some("interface_body") {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "property", node, start_line, sel, detail, depth, parent))
			},
			"interface_declaration" if is_ts => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "interface", node, start_line, sel, detail, depth, parent))
			},
			"type_alias_declaration" if is_ts => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "type_alias", node, start_line, sel, detail, depth, parent))
			},
			"enum_declaration" if is_ts => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "enum", node, start_line, sel, detail, depth, parent))
			},
			"enum_body" if is_ts => {
				// Bare enum members (`Red,` with no `= value`) are stored as
				// repeated `name` fields on `enum_body`, not as `enum_assignment`
				// nodes. Emit each as `enum_member`, parented to the enclosing
				// enum (the current `parent`). Each member's `start_line` /
				// `selection_line` is the member's own line (NOT the enum_body
				// `{` line). Return `None` so `walk` still recurses into
				// `enum_body`'s children with the SAME parent — assigned members
				// (`enum_assignment`) then emit correctly, and the bare `name`
				// (`property_identifier`) children are not matched so they never
				// double-emit.
				let mut cursor = node.walk();
				for n in node.children_by_field_name("name", &mut cursor) {
					let nm = self.text(n);
					if nm.is_empty() {
						continue;
					}
					let member_line = node_start_line(n);
					let detail = self.detail(n, None);
					self.push(nm, "enum_member", n, member_line, member_line, detail, depth, parent);
				}
				None
			},
			"enum_assignment" if is_ts => {
				// Assigned member (`Red = 0`); parented to the enclosing enum.
				if parent_kind(node) != Some("enum_body") {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "enum_member", node, start_line, sel, detail, depth, parent))
			},
			"internal_module" if is_ts => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "namespace", node, start_line, sel, detail, depth, parent))
			},
			"function_signature" if is_ts => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"variable_declarator" => {
				// Only declarators under a lexical/variable declaration.
				if !matches!(
					parent_kind(node),
					Some("lexical_declaration") | Some("variable_declaration")
				) {
					return None;
				}
				// v1 only emits simple-name declarators; destructuring binding
				// patterns (`object_pattern`/`array_pattern`) have no single name
				// to address, so skip them rather than emit garbage like `{` or
				// `[`.
				let name_node = node.child_by_field_name("name")?;
				if name_node.kind() != "identifier" {
					return None;
				}
				let name = self.text(name_node);
				let sel = node_start_line(name_node);
				// Arrow / function-expression initializer => function symbol.
				let value_kind = node.child_by_field_name("value").map(|v| v.kind());
				let kind_str = match value_kind {
					Some("arrow_function") | Some("function_expression") => "function",
					_ => {
						// `const` => constant; `let`/`var` => variable. The `kind`
						// field exists on `lexical_declaration` (const/let); for
						// `var` (`variable_declaration`, no `kind` field) we
						// default to variable.
						let kind_tok = node
							.parent()
							.and_then(|p| p.child_by_field_name("kind"))
							.map(|g| self.text(g));
						match kind_tok.as_deref() {
							Some("const") => "constant",
							_ => "variable",
						}
					},
				};
				let detail = self.detail(node, None);
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}
}

// ── Python ───────────────────────────────────────────────────────────────

impl<'a> Walker<'a> {
	fn emit_python(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"function_definition" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				let kind_str = if is_python_method(node) {
					"method"
				} else {
					"function"
				};
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			"class_definition" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "class", node, start_line, sel, detail, depth, parent))
			},
			"expression_statement" => {
				// An assignment at module or class-body scope is a constant /
				// variable / field. Skip inside function bodies.
				if is_inside_function(node) {
					return None;
				}
				// `expression_statement` has no `expression` field in
				// tree-sitter-python; its sole named child IS the expression /
				// assignment node.
				let assign = node.named_child(0).filter(|e| e.kind() == "assignment")?;
				let left = assign.child_by_field_name("left")?;
				let (name, is_field) = match left.kind() {
					"identifier" => (self.text(left), false),
					"attribute" => {
						// An attribute LHS (`self.x = ...`, `obj.y = ...`) is a
						// declaration ONLY when the immediate owning scope is a
						// class body (`block` whose parent is `class_definition`)
						// — i.e. a class-body attribute assignment such as
						// `self.x = 1` inside `__init__` would be inside a
						// function and already skipped by `is_inside_function`,
						// while a module-scope `settings.DEBUG = True` is NOT a
						// declaration and must be dropped. Use the trailing
						// attribute segment as the name.
						if !is_in_class_body(node) {
							return None;
						}
						let last = last_attribute_identifier(left)?;
						(self.text(last), true)
					},
					_ => return None,
				};
				if name.is_empty() {
					return None;
				}
				let is_const = name.chars().all(|c| c.is_ascii_uppercase() || c == '_');
				let kind_str = if is_field {
					"field"
				} else if is_const {
					"constant"
				} else {
					"variable"
				};
				let sel = node_start_line(left);
				let detail = self.detail(assign, None);
				Some(self.push(name, kind_str, assign, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}
}

/// A Python `function_definition` is a method when it is directly inside a
/// class body (possibly wrapped in `decorated_definition`), walking up until
/// we hit either a `class_definition` (method) or a `function_definition`
/// (nested function, not a method).
fn is_python_method(node: Node<'_>) -> bool {
	let mut cur = node.parent();
	while let Some(p) = cur {
		match p.kind() {
			"function_definition" => return false,
			"class_definition" => return true,
			_ => cur = p.parent(),
		}
	}
	false
}

/// True when `node` is inside a function body (assignments there are locals,
/// not module/class symbols).
fn is_inside_function(node: Node<'_>) -> bool {
	let mut cur = node.parent();
	while let Some(p) = cur {
		if p.kind() == "function_definition" {
			return true;
		}
		cur = p.parent();
	}
	false
}

/// True when `node`'s immediate enclosing scope is a class body: the parent
/// is a `block` whose parent is a `class_definition`. This is the ONLY scope
/// where a Python attribute-LHS assignment (`self.x = 1` at class-body level)
/// is treated as a `field`; module-scope attribute assignments
/// (`settings.DEBUG = True`) are NOT declarations and are skipped.
fn is_in_class_body(node: Node<'_>) -> bool {
	let Some(block) = node.parent() else {
		return false;
	};
	block.kind() == "block" && block.parent().map(|p| p.kind()) == Some("class_definition")
}

/// For a Python `attribute` node (`a.b.c`), return the trailing `identifier`.
fn last_attribute_identifier(node: Node<'_>) -> Option<Node<'_>> {
	let mut cur = node;
	loop {
		if cur.kind() == "attribute" {
			let obj = cur.child_by_field_name("object");
			let mut found = None;
			for i in 0..cur.named_child_count() {
				let c = cur.named_child(i)?;
				if Some(c) == obj {
					continue;
				}
				if c.kind() == "identifier" {
					found = Some(c);
				}
			}
			return found;
		}
		if cur.kind() == "identifier" {
			return Some(cur);
		}
		cur = cur.child_by_field_name("object")?;
	}
}

// ── Rust ─────────────────────────────────────────────────────────────────

impl<'a> Walker<'a> {
	fn emit_rust(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		// Extend `start_line` over immediately-preceding `attribute_item`
		// (`#[...]`) and doc `line_comment` (`///`, `//!`) siblings.
		let start_line = rust_extended_start_line(self.source, node, start_line);

		// Rust associated items (fn/const/type/static/macro inside an `impl_item`)
		// have no emitted parent symbol: the `impl_item` is intentionally not
		// emitted. Attribute them to the impl's implemented type via `container`.
		let container = enclosing_impl_type(self.source, node);

		match kind {
			"function_item" | "function_signature_item" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(
					node,
					if kind == "function_item" {
						Some("body")
					} else {
						None
					},
				);
				let kind_str = if is_rust_method(node) {
					"method"
				} else {
					"function"
				};
				Some(self.push_with_container(
					name, kind_str, node, start_line, sel, detail, depth, parent, container,
				))
			},
			"struct_item" | "union_item" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "struct", node, start_line, sel, detail, depth, parent))
			},
			"field_declaration" => {
				if !is_rust_struct_field(node) {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "field", node, start_line, sel, detail, depth, parent))
			},
			"enum_item" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "enum", node, start_line, sel, detail, depth, parent))
			},
			"enum_variant" => {
				if parent_kind(node) != Some("enum_variant_list") {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "enum_member", node, start_line, sel, detail, depth, parent))
			},
			"trait_item" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "trait", node, start_line, sel, detail, depth, parent))
			},
			"mod_item" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "module", node, start_line, sel, detail, depth, parent))
			},
			"const_item" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push_with_container(
					name, "constant", node, start_line, sel, detail, depth, parent, container,
				))
			},
			"static_item" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push_with_container(
					name, "variable", node, start_line, sel, detail, depth, parent, container,
				))
			},
			"type_item" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push_with_container(
					name,
					"type_alias",
					node,
					start_line,
					sel,
					detail,
					depth,
					parent,
					container,
				))
			},
			// `associated_type` is a trait-associated type with no value
			// (`type Item;` inside a `trait_item`); `impl`-block associated
			// types with a value parse as `type_item` (handled above). It
			// only appears in a trait's `declaration_list`, so it parents to
			// the surrounding trait (the `parent` index). Use
			// `push_with_container` with the precomputed `container`
			// (which is `None` in trait context — `enclosing_impl_type`
			// returns `None` for trait items) so a hypothetical impl-context
			// `associated_type` would still attribute correctly.
			"associated_type" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push_with_container(
					name,
					"type_alias",
					node,
					start_line,
					sel,
					detail,
					depth,
					parent,
					container,
				))
			},
			"macro_definition" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push_with_container(
					name, "macro", node, start_line, sel, detail, depth, parent, container,
				))
			},
			// `impl_item` is not a named symbol (no own name); passthrough. Its
			// associated items get `container` = the impl's type (above) but
			// still parent to the surrounding scope (top level when the impl is
			// at module scope) — we never fabricate a `parent` to the
			// implemented struct, since there is no node relationship to its
			// definition.
			_ => None,
		}
	}
}

/// A Rust `function_item`/`function_signature_item` is a method when it sits
/// directly in an `impl_item` or `trait_item` `declaration_list` (a nested
/// function inside a method body has parent `block`, not `declaration_list`).
fn is_rust_method(node: Node<'_>) -> bool {
	matches!(parent_kind(node), Some("declaration_list"))
		&& matches!(grandparent_kind(node), Some("impl_item") | Some("trait_item"))
}

/// Container attribution for Rust associated items (functions, consts, type
/// aliases, statics, macros) declared inside an `impl_item`. The `impl_item`
/// is intentionally not emitted as a symbol (it has no name), so its children
/// would otherwise lose all container info. This returns the trimmed source
/// text of the impl's `type` field — for `impl Foo` that is `Foo`, and for
/// `impl Trait for Foo` the grammar's `type` field is the implementing type
/// `Foo` (the trait is the separate `trait` field), which is the desired
/// container.
///
/// Only items sitting *directly* in the impl's `declaration_list` are
/// attributed: a nested `fn` inside a method body has parent `block`, and a
/// trait item's `declaration_list` parent is a `trait_item`, not an
/// `impl_item`. This mirrors the immediate-chain check of [`is_rust_method`]
/// rather than an open-ended ancestor walk, so a function nested in a method
/// body is never tagged `container = Foo`. Returns `None` for top-level
/// items, `mod` items, and trait items (whose `parent` → the trait conveys
/// nesting).
fn enclosing_impl_type(source: &[u8], node: Node<'_>) -> Option<String> {
	// Immediate parent must be the impl's `declaration_list`...
	let decl_list = node.parent().filter(|p| p.kind() == "declaration_list")?;
	// ...and that list's parent must be the `impl_item` (not a `trait_item`).
	let impl_node = decl_list.parent().filter(|p| p.kind() == "impl_item")?;
	let type_node = impl_node.child_by_field_name("type")?;
	let bytes = &source[type_node.start_byte()..type_node.end_byte()];
	let s = std::str::from_utf8(bytes).ok()?;
	let trimmed = s.trim();
	if trimmed.is_empty() {
		None
	} else {
		Some(trimmed.to_string())
	}
}

/// A Rust `field_declaration` is a struct/union field (not an enum-variant
/// struct body field).
fn is_rust_struct_field(node: Node<'_>) -> bool {
	matches!(parent_kind(node), Some("field_declaration_list"))
		&& matches!(grandparent_kind(node), Some("struct_item") | Some("union_item"))
}

/// Walk a Rust declaration's *immediately-preceding* siblings, extending
/// `start_line` to cover contiguous `attribute_item` (`#[...]`) and doc
/// `line_comment` (`///`, `//!`) nodes. Stops at the first non-attached
/// sibling or a blank-line gap (adjacency required).
fn rust_extended_start_line(source: &[u8], node: Node<'_>, mut start_line: u32) -> u32 {
	let mut sib = node.prev_sibling();
	while let Some(s) = sib {
		match s.kind() {
			"attribute_item" => {
				if node_start_line(s) + 1 != start_line {
					break;
				}
				start_line = node_start_line(s);
				sib = s.prev_sibling();
				continue;
			},
			"line_comment" => {
				// Only doc comments (`///` or `//!`) attach to the following
				// item; ordinary `//` comments do not.
				let lo = s.start_byte();
				let hi = s.end_byte().min(lo + 3);
				let prefix = &source[lo..hi];
				let is_doc = prefix.starts_with(b"///") || prefix.starts_with(b"//!");
				if is_doc && node_start_line(s) + 1 == start_line {
					start_line = node_start_line(s);
					sib = s.prev_sibling();
					continue;
				}
				break;
			},
			_ => break,
		}
	}
	start_line
}

// ── Go ───────────────────────────────────────────────────────────────────

impl<'a> Walker<'a> {
	fn emit_go(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"function_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"method_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				// The receiver type is the only container info for a Go method
				// (it is a parameter, never a declaration), so set `container`
				// to its type text with a leading `*`/`&` stripped.
				let container = go_receiver_type(self.source, node);
				Some(self.push_with_container(
					name, "method", node, start_line, sel, detail, depth, parent, container,
				))
			},
			// `type_declaration` is a wrapper over `type_spec`/`type_alias`;
			// passthrough — never emit it.
			"type_spec" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				let type_node = node.child_by_field_name("type");
				let kind_str = match type_node.map(|t| t.kind()) {
					Some("struct_type") => "struct",
					Some("interface_type") => "interface",
					_ => "type_alias",
				};
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			"type_alias" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "type_alias", node, start_line, sel, detail, depth, parent))
			},
			"field_declaration" => {
				// Inside a struct body only.
				if parent_kind(node) != Some("field_declaration_list") {
					return None;
				}
				// `name` field is `multiple`: one entry per name. Embedded
				// fields (no name) fall back to the type text.
				let mut cursor = node.walk();
				let names: Vec<Node<'_>> = node.children_by_field_name("name", &mut cursor).collect();
				if names.is_empty() {
					let type_node = node.child_by_field_name("type")?;
					let name = self
						.text(type_node)
						.trim_start_matches(['*', ' '])
						.to_string();
					if name.is_empty() {
						return None;
					}
					let sel = node_start_line(node);
					let detail = self.detail(node, None);
					return Some(self.push(name, "field", node, start_line, sel, detail, depth, parent));
				}
				let mut first = None;
				for n in names {
					let nm = self.text(n);
					if nm.is_empty() {
						continue;
					}
					let sel = node_start_line(n);
					let detail = self.detail(node, None);
					let idx = self.push(nm, "field", node, start_line, sel, detail, depth, parent);
					if first.is_none() {
						first = Some(idx);
					}
				}
				first
			},
			"method_elem" => {
				if parent_kind(node) != Some("interface_type") {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "method", node, start_line, sel, detail, depth, parent))
			},
			"const_spec" => self.emit_go_multi_name(node, "constant", start_line, depth, parent),
			"var_spec" => self.emit_go_multi_name(node, "variable", start_line, depth, parent),
			// `const_declaration` / `var_declaration` are wrappers; passthrough.
			_ => None,
		}
	}

	/// Emit one symbol per declared name in a Go `const_spec`/`var_spec`.
	/// Uses `children_by_field_name("name", ...)` so RHS/type identifiers never
	/// leak in. Returns the index of the first emitted entry.
	fn emit_go_multi_name(
		&mut self,
		node: Node<'_>,
		kind_str: &str,
		start_line: u32,
		depth: u32,
		parent: i32,
	) -> Option<usize> {
		let mut cursor = node.walk();
		let names: Vec<Node<'_>> = node.children_by_field_name("name", &mut cursor).collect();
		if names.is_empty() {
			return None;
		}
		let mut first = None;
		for n in names {
			let nm = self.text(n);
			if nm.is_empty() {
				continue;
			}
			let sel = node_start_line(n);
			let detail = self.detail(node, None);
			let idx = self.push(nm, kind_str, node, start_line, sel, detail, depth, parent);
			if first.is_none() {
				first = Some(idx);
			}
		}
		first
	}
}

/// Container attribution for a Go `method_declaration`: the receiver type.
/// `method_declaration` has a `receiver` field (`parameter_list`) whose first
/// `parameter_declaration`'s `type` field is the receiver type. For
/// `func (f *Foo) Bar()` that yields `*Foo`; strip a leading `*` (and `&` if
/// present) plus surrounding whitespace so the container reads `Foo`. Returns
/// `None` if the receiver or its type cannot be resolved (e.g. malformed
/// input).
fn go_receiver_type(source: &[u8], node: Node<'_>) -> Option<String> {
	let receiver = node.child_by_field_name("receiver")?;
	// `receiver` is a `parameter_list`; take its first `parameter_declaration`.
	let first_param = receiver.named_child(0)?;
	if first_param.kind() != "parameter_declaration" {
		return None;
	}
	let type_node = first_param.child_by_field_name("type")?;
	let bytes = &source[type_node.start_byte()..type_node.end_byte()];
	let s = std::str::from_utf8(bytes).ok()?;
	let trimmed = s.trim().trim_start_matches(['*', '&', ' ']).trim();
	if trimmed.is_empty() {
		None
	} else {
		Some(trimmed.to_string())
	}
}

// ── Java ─────────────────────────────────────────────────────────────────

impl<'a> Walker<'a> {
	fn emit_java(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		// `modifiers`/`annotation` are grammar children of the declaration
		// (inside its span), so `start_line` already covers them via
		// `node_start_line`.
		match kind {
			"class_declaration" | "record_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "class", node, start_line, sel, detail, depth, parent))
			},
			"interface_declaration" | "annotation_type_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "interface", node, start_line, sel, detail, depth, parent))
			},
			"enum_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "enum", node, start_line, sel, detail, depth, parent))
			},
			"enum_constant" => {
				if parent_kind(node) != Some("enum_body") {
					return None;
				}
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "enum_member", node, start_line, sel, detail, depth, parent))
			},
			"method_declaration" | "annotation_type_element_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "method", node, start_line, sel, detail, depth, parent))
			},
			"constructor_declaration" | "compact_constructor_declaration" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "constructor", node, start_line, sel, detail, depth, parent))
			},
			"field_declaration" => {
				// Java enum bodies put fields (and methods/constructors) under
				// `enum_body_declarations` after the constants, not directly under
				// `enum_body`; accept both `class_body` and `enum_body_declarations`.
				if !matches!(parent_kind(node), Some("class_body") | Some("enum_body_declarations")) {
					return None;
				}
				// One entry per `variable_declarator` child.
				let mut first = None;
				for i in 0..node.child_count() {
					let Some(c) = node.child(i) else {
						continue;
					};
					if c.kind() != "variable_declarator" {
						continue;
					}
					let name_node = match c.child_by_field_name("name") {
						Some(n) => n,
						None => continue,
					};
					let name = self.text(name_node);
					if name.is_empty() || name == "_" {
						continue;
					}
					let sel = node_start_line(name_node);
					let detail = self.detail(c, None);
					let idx = self.push(name, "field", c, start_line, sel, detail, depth, parent);
					if first.is_none() {
						first = Some(idx);
					}
				}
				first
			},
			_ => None,
		}
	}
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
	use super::*;

	fn outline(code: &str, path: &str) -> OutlineResult {
		outline_code(OutlineOptions {
			code:      code.to_string(),
			lang:      None,
			path:      Some(path.to_string()),
			max_depth: None,
		})
		.expect("outline succeeds")
	}

	fn find<'r>(result: &'r OutlineResult, name: &str) -> Option<&'r SymbolEntry> {
		result.symbols.iter().find(|s| s.name == name)
	}

	fn idx_of(result: &OutlineResult, name: &str, kind: &str) -> Option<usize> {
		result
			.symbols
			.iter()
			.position(|s| s.name == name && s.kind == kind)
	}

	#[test]
	fn outlines_typescript_function_class_methods_enum_decorated_export() {
		let code = "\
export function greet(name: string): string {
    return name;
}

class Greeter {
    private name: string = \"world\";

    constructor(name: string) {
        this.name = name;
    }

    sayHello(): string {
        return `hello ${this.name}`;
    }
}

interface Helloable {
    hello(): void;
}

type Alias = string;

enum Color {
    Red,
    Green,
    Blue,
}

const Arrow = (x: number) => x + 1;
let mutable = 2;
";
		let result = outline(code, "fixture.ts");

		assert!(result.parsed);
		assert_eq!(result.language.as_deref(), Some("typescript"));

		// Top-level exported function: start_line includes the `export` line.
		let greet = find(&result, "greet").expect("greet");
		assert_eq!(greet.kind, "function");
		assert_eq!(greet.start_line, 1);
		assert_eq!(greet.end_line, 3);
		assert_eq!(greet.parent, -1);

		// Class.
		let class_idx = idx_of(&result, "Greeter", "class").expect("class idx");
		let class = &result.symbols[class_idx];
		assert_eq!(class.start_line, 5);
		assert_eq!(class.end_line, 15);
		assert_eq!(class.parent, -1);

		// Class property parented to the class.
		let prop = find(&result, "name").expect("name property");
		assert_eq!(prop.kind, "property");
		assert_eq!(prop.parent, class_idx as i32);

		// Constructor emitted as constructor, parented to the class.
		let ctor = result
			.symbols
			.iter()
			.find(|s| s.name == "constructor")
			.expect("constructor");
		assert_eq!(ctor.kind, "constructor");
		assert_eq!(ctor.parent, class_idx as i32);

		// Nested method: parent points at the class, kind method.
		let say = find(&result, "sayHello").expect("sayHello");
		assert_eq!(say.kind, "method");
		assert_eq!(say.parent, class_idx as i32);

		// Interface + method signature.
		let iface_idx = idx_of(&result, "Helloable", "interface").expect("iface");
		assert_eq!(result.symbols[iface_idx].start_line, 17);
		let hello = find(&result, "hello").expect("hello signature");
		assert_eq!(hello.kind, "method");
		assert_eq!(hello.parent, iface_idx as i32);

		// Type alias.
		let alias = find(&result, "Alias").expect("type alias");
		assert_eq!(alias.kind, "type_alias");
		assert_eq!(alias.start_line, 21);

		// Enum + members.
		let enum_idx = idx_of(&result, "Color", "enum").expect("enum");
		let red = find(&result, "Red").expect("Red");
		assert_eq!(red.kind, "enum_member");
		assert_eq!(red.parent, enum_idx as i32);
		assert_eq!(red.start_line, 24);

		// const arrow => function; let => variable.
		assert_eq!(find(&result, "Arrow").expect("Arrow").kind, "function");
		assert_eq!(find(&result, "mutable").expect("mutable").kind, "variable");
	}

	#[test]
	fn outlines_javascript_class_field_and_arrow_const() {
		let code = "\
function greet() {
    return 1;
}

class Greeter {
    greeting = \"hi\";

    hello() {
        return this.greeting;
    }
}

const fn = () => 2;
const PI = 3.14;
";
		let result = outline(code, "fixture.js");
		assert!(result.parsed);
		assert_eq!(result.language.as_deref(), Some("javascript"));

		let greet = find(&result, "greet").expect("greet");
		assert_eq!(greet.kind, "function");
		assert_eq!(greet.start_line, 1);
		assert_eq!(greet.end_line, 3);
		assert_eq!(greet.parent, -1);

		let class_idx = idx_of(&result, "Greeter", "class").expect("class");

		// JS uses field `property`; kind "field".
		let field = find(&result, "greeting").expect("field");
		assert_eq!(field.kind, "field");
		assert_eq!(field.parent, class_idx as i32);

		let m = find(&result, "hello").expect("method");
		assert_eq!(m.kind, "method");
		assert_eq!(m.parent, class_idx as i32);

		assert_eq!(find(&result, "fn").expect("fn").kind, "function");
		assert_eq!(find(&result, "PI").expect("PI").kind, "constant");
	}

	#[test]
	fn outlines_python_class_method_decorator_constant() {
		let code = "\
@dataclass
class Greeter:
    MAX = 10

    def greet(self, name: str) -> str:
        return f\"hello {name}\"

    @property
    def value(self):
        return self._v
";
		let result = outline(code, "fixture.py");
		assert!(result.parsed);
		assert_eq!(result.language.as_deref(), Some("python"));

		// `decorated_definition` wraps the class; start_line includes the
		// `@dataclass` decorator line (1).
		let class = find(&result, "Greeter").expect("class");
		assert_eq!(class.kind, "class");
		assert_eq!(class.start_line, 1);
		assert_eq!(class.parent, -1);
		let class_idx = idx_of(&result, "Greeter", "class").expect("class idx");

		// Nested method: parent -> class, kind method.
		let greet = find(&result, "greet").expect("greet");
		assert_eq!(greet.kind, "method");
		assert_eq!(greet.parent, class_idx as i32);

		// `value` is decorated with `@property`; start_line must include the
		// decorator line (8).
		let value = find(&result, "value").expect("value");
		assert_eq!(value.kind, "method");
		assert_eq!(value.parent, class_idx as i32);
		assert_eq!(value.start_line, 8);

		// Class-body constant assignment.
		let max = result
			.symbols
			.iter()
			.find(|s| s.name == "MAX" && s.kind == "constant")
			.expect("MAX constant");
		assert_eq!(max.parent, class_idx as i32);
	}

	#[test]
	fn outlines_rust_struct_method_enum_attribute_doc_comment() {
		let code = "\
/// A greeter.
#[derive(Debug)]
pub struct Greeter {
    name: String,
}

impl Greeter {
    pub fn greet(&self) -> String {
        format!(\"hello {}\")
    }
}

enum Color {
    Red,
    Green,
}

const MAX: usize = 16;

trait Hello {
    fn hello(&self);
}
";
		let result = outline(code, "fixture.rs");
		assert!(result.parsed);
		assert_eq!(result.language.as_deref(), Some("rust"));

		// Struct: start_line spans the doc comment + attribute (lines 1-2).
		let struct_idx = idx_of(&result, "Greeter", "struct").expect("struct");
		let struct_sym = &result.symbols[struct_idx];
		assert_eq!(struct_sym.start_line, 1);
		assert_eq!(struct_sym.end_line, 5);

		// Struct field parented to the struct.
		let field = find(&result, "name").expect("field");
		assert_eq!(field.kind, "field");
		assert_eq!(field.parent, struct_idx as i32);

		// impl method: kind method, parent -1 (impl is not a symbol node; we
		// do NOT fabricate a parent to the struct just because names match).
		let greet = find(&result, "greet").expect("greet");
		assert_eq!(greet.kind, "method");
		assert_eq!(
			greet.parent, -1,
			"impl methods must NOT parent to the struct (no node relationship)"
		);

		// impl method: container = the impl's type (`Greeter`); parent stays
		// -1 since `impl_item` is not an emitted symbol.
		assert_eq!(
			greet.container,
			Some("Greeter".to_string()),
			"impl method container must be the impl type"
		);

		// Enum + member.
		let enum_idx = idx_of(&result, "Color", "enum").expect("enum");
		let red = find(&result, "Red").expect("Red");
		assert_eq!(red.kind, "enum_member");
		assert_eq!(red.parent, enum_idx as i32);
		assert_eq!(red.start_line, 14);

		// const.
		let max = find(&result, "MAX").expect("MAX");
		assert_eq!(max.kind, "constant");
		assert_eq!(max.parent, -1);

		// trait + trait method (parented to the trait, since trait_item IS a
		// symbol node and an ancestor of the signature).
		let trait_idx = idx_of(&result, "Hello", "trait").expect("trait");
		let hello = find(&result, "hello").expect("hello");
		assert_eq!(hello.kind, "method");
		assert_eq!(hello.parent, trait_idx as i32);
		// trait method: container None (parent → trait conveys nesting).
		assert_eq!(hello.container, None, "trait method must not get a container");
	}

	#[test]
	fn outlines_go_function_method_struct_multi_const() {
		let code = "\
package main

func greet() string {
    return \"hi\"
}

type Greeter struct {
    name string
    id   int
}

func (g Greeter) Name() string {
    return g.name
}

const (
    A = 1
    B, C = 2, 3
)
";
		let result = outline(code, "fixture.go");
		assert!(result.parsed);
		assert_eq!(result.language.as_deref(), Some("go"));

		// Top-level function.
		let greet = find(&result, "greet").expect("greet");
		assert_eq!(greet.kind, "function");
		assert_eq!(greet.start_line, 3);
		assert_eq!(greet.end_line, 5);
		assert_eq!(greet.parent, -1);
		// Plain top-level function: no container.
		assert_eq!(greet.container, None, "plain function must not get a container");

		// struct via type_spec.
		let struct_idx = idx_of(&result, "Greeter", "struct").expect("struct");

		// Two struct fields, each parented to the struct.
		let name_field = find(&result, "name").expect("name field");
		assert_eq!(name_field.kind, "field");
		assert_eq!(name_field.parent, struct_idx as i32);
		let id_field = find(&result, "id").expect("id field");
		assert_eq!(id_field.kind, "field");
		assert_eq!(id_field.parent, struct_idx as i32);

		// method via method_declaration; receiver type is not a parent symbol.
		let m = result
			.symbols
			.iter()
			.find(|s| s.name == "Name" && s.kind == "method")
			.expect("method");
		assert_eq!(m.parent, -1);

		// method receiver is a value type `Greeter` → container `Greeter`.
		assert_eq!(m.container, Some("Greeter".to_string()), "method container = receiver type");

		// Multi-name const spec: one entry per name.
		assert_eq!(find(&result, "A").expect("A").kind, "constant");
		assert_eq!(find(&result, "B").expect("B").kind, "constant");
		assert_eq!(find(&result, "C").expect("C").kind, "constant");
	}

	#[test]
	fn outlines_go_pointer_receiver_container_strips_star() {
		let code = "\
package main

type Foo struct{ x int }

func (f *Foo) Bar() int { return f.x }

func Baz() {}
";
		let result = outline(code, "fixture.go");
		assert!(result.parsed);

		// Pointer receiver `*Foo` → container `Foo` (leading `*` stripped).
		let bar = result
			.symbols
			.iter()
			.find(|s| s.name == "Bar" && s.kind == "method")
			.expect("Bar method");
		assert_eq!(bar.parent, -1);
		assert_eq!(bar.container, Some("Foo".to_string()), "pointer receiver star stripped");

		// Plain top-level function: no container.
		let baz = find(&result, "Baz").expect("Baz");
		assert_eq!(baz.kind, "function");
		assert_eq!(baz.parent, -1);
		assert_eq!(baz.container, None, "plain function gets no container");
	}

	#[test]
	fn outlines_rust_impl_associated_const_and_top_level_fn_container() {
		let code = "\
struct Foo;

impl Foo {
    const N: usize = 3;

    fn new() -> Self { Self }
}

fn top() {}
";
		let result = outline(code, "fixture.rs");
		assert!(result.parsed);

		// Associated const inside `impl Foo` → container `Foo`, parent -1.
		let n = find(&result, "N").expect("N const");
		assert_eq!(n.kind, "constant");
		assert_eq!(n.parent, -1);
		assert_eq!(n.container, Some("Foo".to_string()), "impl const container = impl type");

		// Associated fn inside the same impl → container `Foo`, parent -1.
		let newf = find(&result, "new").expect("new fn");
		assert_eq!(newf.kind, "method");
		assert_eq!(newf.parent, -1);
		assert_eq!(newf.container, Some("Foo".to_string()), "impl fn container = impl type");

		// Top-level fn → no container (no enclosing impl).
		let top = find(&result, "top").expect("top fn");
		assert_eq!(top.kind, "function");
		assert_eq!(top.parent, -1);
		assert_eq!(top.container, None, "top-level fn gets no container");
	}
	#[test]
	fn outlines_java_class_method_field_enum() {
		let code = "\
public class Greeter {
    private int count = 0;

    public Greeter() {
    }

    public void greet() {
        System.out.println(\"hi\");
    }
}

enum Color {
    RED,
    GREEN,
}
";
		let result = outline(code, "fixture.java");
		assert!(result.parsed);
		assert_eq!(result.language.as_deref(), Some("java"));

		let class_idx = idx_of(&result, "Greeter", "class").expect("class");

		// Field parented to class.
		let field = find(&result, "count").expect("field");
		assert_eq!(field.kind, "field");
		assert_eq!(field.parent, class_idx as i32);

		// Constructor (same name as class, distinct kind).
		let ctor = result
			.symbols
			.iter()
			.find(|s| s.name == "Greeter" && s.kind == "constructor")
			.expect("constructor");
		assert_eq!(ctor.parent, class_idx as i32);

		// Method.
		let m = find(&result, "greet").expect("method");
		assert_eq!(m.kind, "method");
		assert_eq!(m.parent, class_idx as i32);

		// Enum + members.
		let enum_idx = idx_of(&result, "Color", "enum").expect("enum");
		let red = find(&result, "RED").expect("RED");
		assert_eq!(red.kind, "enum_member");
		assert_eq!(red.parent, enum_idx as i32);
		assert!(find(&result, "GREEN").is_some());
	}

	#[test]
	fn unparseable_fixture_returns_empty() {
		// A path with an unknown extension resolves no language.
		let result = outline("anything", "fixture.xyz");
		assert!(!result.parsed);
		assert_eq!(result.language, None);
		assert!(result.symbols.is_empty());
	}

	#[test]
	fn parse_error_returns_empty_but_named() {
		// Valid language but broken syntax.
		let result = outline("func !!!(\n", "fixture.go");
		assert!(!result.parsed);
		assert_eq!(result.language.as_deref(), Some("go"));
		assert!(result.symbols.is_empty());
	}

	#[test]
	fn max_depth_caps_emission() {
		let code = "\
class Outer {
    method() {
        function nested() {}
    }
}
";
		let result = outline_code(OutlineOptions {
			code:      code.to_string(),
			lang:      None,
			path:      Some("fixture.ts".to_string()),
			max_depth: Some(0),
		})
		.expect("ok");
		assert!(result.parsed);
		// depth 0 only => the top-level class, no methods/nested.
		let names: Vec<&str> = result.symbols.iter().map(|s| s.name.as_str()).collect();
		assert!(names.contains(&"Outer"));
		assert!(!names.contains(&"method"));
		assert!(!names.contains(&"nested"));
	}
	#[test]
	fn rust_attributed_field_and_variant_start_line_spans_attribute() {
		// Fix #1: an attributed field/variant's `start_line` must cover the
		// `#[...]` attribute (extended start line), like struct/fn arms.
		let code = "struct S {\n    #[serde(default)]\n    x: u32,\n}\n\nenum E {\n    \
		            #[cfg(test)]\n    V,\n}\n";
		let result = outline(code, "fixture.rs");
		assert!(result.parsed);
		let x = find(&result, "x").expect("field x");
		assert_eq!(x.kind, "field");
		assert_eq!(x.start_line, 2, "attributed field start_line must cover the attribute");
		let v = find(&result, "V").expect("variant V");
		assert_eq!(v.kind, "enum_member");
		assert_eq!(v.start_line, 7, "attributed variant start_line must cover the attribute");
	}

	#[test]
	fn typescript_named_default_export_keeps_wrapper_start_line() {
		// Fix #2: named default exports keep the `export default` line inside
		// `start_line`. Named declarations route through the `declaration`
		// field; parenthesized named expressions route through `value` (peeling
		// `parenthesized_expression`).
		let code = "export default class Foo {\n    greet() {}\n}\n\nexport default function bar() \
		            {}\n\nexport default (class Named {});\n\nexport default (function namedFn() \
		            {});\n";
		let result = outline(code, "fixture.ts");
		assert!(result.parsed);
		let foo = find(&result, "Foo").expect("Foo");
		assert_eq!(foo.kind, "class");
		assert_eq!(foo.start_line, 1, "named default class start_line must be the export line");
		assert_eq!(foo.parent, -1);
		let bar = find(&result, "bar").expect("bar");
		assert_eq!(bar.kind, "function");
		assert_eq!(bar.start_line, 5, "named default function start_line must be the export line");
		let named = find(&result, "Named").expect("Named class expr");
		assert_eq!(named.kind, "class");
		assert_eq!(
			named.start_line, 7,
			"parenthesized named default class start_line must be the export line"
		);
		let named_fn = find(&result, "namedFn").expect("namedFn function expr");
		assert_eq!(named_fn.kind, "function");
		assert_eq!(
			named_fn.start_line, 9,
			"parenthesized named default function start_line must be the export line"
		);
	}

	#[test]
	fn typescript_anonymous_default_exports_are_skipped() {
		// Fix #2 complement: anonymous defaults have no name and emit nothing.
		let code = "export default () => 1;\nexport default function() {}\nexport default class {}\n";
		let result = outline(code, "fixture.ts");
		assert!(result.parsed);
		assert!(result.symbols.is_empty(), "anonymous default exports must emit nothing");
	}

	#[test]
	fn typescript_named_expression_in_const_does_not_duplicate() {
		// Fix #2 complement: a named expression nested in a `const` is emitted
		// by the `variable_declarator` arm; the `class`/`function_expression`
		// arms must NOT duplicate it (guarded by `is_export_default_value`).
		let code = "const f = function named() {};\nconst c = class Inner {};\n";
		let result = outline(code, "fixture.ts");
		assert!(result.parsed);
		assert_eq!(find(&result, "f").expect("f").kind, "function");
		assert_eq!(find(&result, "c").expect("c").kind, "constant");
		assert!(find(&result, "named").is_none(), "inner named fn expr must not duplicate");
		assert!(find(&result, "Inner").is_none(), "inner named class expr must not duplicate");
	}

	#[test]
	fn python_module_attribute_assignment_is_not_a_field() {
		// Fix #3: a module-scope attribute assignment (`settings.DEBUG = True`)
		// is NOT a declaration — it must emit no symbol. An attribute LHS is a
		// `field` ONLY when the immediate owning scope is a class body.
		let code = "settings.DEBUG = True\nobj.x = 1\nCONST = 1\n\nclass C:\n    count = 0\n";
		let result = outline(code, "fixture.py");
		assert!(result.parsed);
		assert!(find(&result, "DEBUG").is_none(), "module attribute assignment must not be a field");
		assert!(find(&result, "x").is_none(), "module attribute assignment must not be a field");
		let c = find(&result, "CONST").expect("CONST");
		assert_eq!(c.kind, "constant");
		let class_idx = idx_of(&result, "C", "class").expect("class idx");
		let count = find(&result, "count").expect("count");
		assert_eq!(count.parent, class_idx as i32);
	}

	#[test]
	fn typescript_destructuring_declarations_emit_no_symbol() {
		// Fix #4: destructuring binding patterns (`object_pattern`/
		// `array_pattern`) have no single addressable name; v1 skips them.
		let code = "const { a } = obj;\nconst [first] = xs;\nconst x = 1;\n";
		let result = outline(code, "fixture.ts");
		assert!(result.parsed);
		assert!(find(&result, "a").is_none(), "object_pattern destructuring must not emit");
		assert!(find(&result, "first").is_none(), "array_pattern destructuring must not emit");
		assert_eq!(find(&result, "x").expect("x").kind, "constant");
	}

	#[test]
	fn rust_trait_associated_type_is_emitted() {
		// Fix #5: `type Item;` inside a trait parses as `associated_type`
		// (no value); emit it as `type_alias`, parented to the trait.
		let code = "trait T {\n    type Item;\n    fn foo(&self);\n}\n";
		let result = outline(code, "fixture.rs");
		assert!(result.parsed);
		let trait_idx = idx_of(&result, "T", "trait").expect("trait idx");
		let item = find(&result, "Item").expect("Item assoc type");
		assert_eq!(item.kind, "type_alias");
		assert_eq!(item.parent, trait_idx as i32);
		assert_eq!(item.container, None, "trait assoc type has no container");
	}

	#[test]
	fn java_enum_body_field_is_emitted() {
		// Fix #6: Java enum bodies put fields under `enum_body_declarations`;
		// the field must be emitted and parented to the enum.
		let code = "enum Color {\n    RED;\n    private final int rgb;\n    Color(int r) { this.rgb \
		            = r; }\n}\n";
		let result = outline(code, "fixture.java");
		assert!(result.parsed);
		let enum_idx = idx_of(&result, "Color", "enum").expect("enum idx");
		let rgb = find(&result, "rgb").expect("rgb field");
		assert_eq!(rgb.kind, "field");
		assert_eq!(rgb.parent, enum_idx as i32);
		let red = find(&result, "RED").expect("RED");
		assert_eq!(red.kind, "enum_member");
		assert_eq!(red.parent, enum_idx as i32);
	}

	#[test]
	fn empty_supported_file_keeps_language_identity() {
		// Fix #7: an empty file with a resolvable language keeps its language
		// identity and parses (true, empty) — it does NOT degrade to
		// `language: None, parsed: false`.
		let result = outline("", "x.rs");
		assert!(result.parsed, "empty supported file must parse");
		assert_eq!(result.language.as_deref(), Some("rust"));
		assert!(result.symbols.is_empty());
		let unknown = outline("", "x.xyz");
		assert_eq!(unknown.language, None);
		assert!(!unknown.parsed);
	}

	#[test]
	fn typescript_bare_enum_member_detail_does_not_include_body() {
		// Fix #8: each bare enum member's `detail` comes from the member node
		// itself, not the whole `enum_body` — so it must not contain the enum
		// body opener or other members.
		let code = "enum Color {\n    Red,\n    Green,\n}\n";
		let result = outline(code, "fixture.ts");
		assert!(result.parsed);
		let red = find(&result, "Red").expect("Red");
		assert_eq!(red.kind, "enum_member");
		if let Some(d) = &red.detail {
			assert!(!d.contains("Green"), "member detail must not include other members");
			assert!(!d.contains("{"), "member detail must not include the enum body opener");
		}
		let green = find(&result, "Green").expect("Green");
		if let Some(d) = &green.detail {
			assert!(!d.contains("Red"), "member detail must not include other members");
		}
	}
}
