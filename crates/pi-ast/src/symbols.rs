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

/// The languages [`outline_code`] emits symbols for: the bespoke-emitter set
/// plus every language routed through the generic table-driven emitter with a
/// populated [`symbol_kind`] table. Only data, markup, and component-wrapper
/// formats with no addressable code symbols (JSON, YAML, CSS, HTML, Markdown,
/// Astro, Svelte, Vue, ...) are excluded — scanning them would only inflate
/// file counts with empty outlines. The `symbol` TS tool derives its supported
/// file set from this set (through the NAPI layer) so the Rust extractor and
/// the TS scan filter never drift.
pub const fn outline_languages() -> &'static [SupportLang] {
	use SupportLang::*;
	&[
		// Bespoke emitters (contextual classification).
		TypeScript,
		Tsx,
		JavaScript,
		Python,
		Rust,
		Go,
		Java,
		// Generic table-driven emitter.
		CSharp,
		Kotlin,
		C,
		Cpp,
		ObjC,
		Scala,
		Swift,
		Dart,
		Php,
		Ruby,
		Lua,
		Perl,
		Odin,
		Bash,
		Solidity,
		Starlark,
		// Bespoke emitters (delegated grammar-specific logic).
		R,
		Julia,
		Zig,
		Haskell,
		Ocaml,
		Elixir,
		Erlang,
		Clojure,
		EmacsLisp,
		Powershell,
		// DSL / HDL / schema languages.
		Graphql,
		Proto,
		Tlaplus,
		Sql,
		Verilog,
		Hcl,
		Nix,
		// Build / task-orchestration file languages.
		Dockerfile,
		Cmake,
		Make,
		Just,
	]
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
			SupportLang::R => self.emit_r(node, kind, depth, parent, start_line),
			SupportLang::Julia => self.emit_julia(node, kind, depth, parent, start_line),
			SupportLang::Zig => self.emit_zig(node, kind, depth, parent, start_line),
			SupportLang::Haskell => self.emit_haskell(node, kind, depth, parent, start_line),
			SupportLang::Ocaml => self.emit_ocaml(node, kind, depth, parent, start_line),
			SupportLang::Elixir => self.emit_elixir(node, kind, depth, parent, start_line),
			SupportLang::Erlang => self.emit_erlang(node, kind, depth, parent, start_line),
			SupportLang::Clojure => self.emit_clojure(node, kind, depth, parent, start_line),
			SupportLang::EmacsLisp => self.emit_emacslisp(node, kind, depth, parent, start_line),
			SupportLang::Powershell => self.emit_powershell(node, kind, depth, parent, start_line),
			SupportLang::Tlaplus => self.emit_tlaplus(node, kind, depth, parent, start_line),
			SupportLang::Sql => self.emit_sql(node, kind, depth, parent, start_line),
			SupportLang::Verilog => self.emit_verilog(node, kind, depth, parent, start_line),
			SupportLang::Hcl => self.emit_hcl(node, kind, depth, parent, start_line),
			SupportLang::Nix => self.emit_nix(node, kind, depth, parent, start_line),
			SupportLang::Dockerfile => self.emit_dockerfile(node, kind, depth, parent, start_line),
			SupportLang::Cmake => self.emit_cmake(node, kind, depth, parent, start_line),
			SupportLang::Make => self.emit_make(node, kind, depth, parent, start_line),
			SupportLang::Just => self.emit_just(node, kind, depth, parent, start_line),
			_ => self.emit_generic(node, kind, depth, parent, start_line),
		}
	}

	/// Generic table-driven emitter for languages without a bespoke emitter.
	/// Maps the node kind via [`symbol_kind`]; resolves the name through the
	/// [`Walker::generic_name_node`] cascade; refines a `function` to a
	/// `method` when it nests directly in an OO container symbol. Nesting and
	/// container are conveyed by the `parent` index — generic languages need
	/// no per-language container attribution.
	fn emit_generic(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		let domain = symbol_kind(self.language, kind)?;
		// A type-specifier with no `body` field is a type *reference*
		// (C/C++/ObjC `struct Foo x;`, `enum E param`), not a definition — skip
		// it so type-use sites do not emit spurious symbols.
		if kind.ends_with("_specifier") && node.child_by_field_name("body").is_none() {
			return None;
		}
		// `typedef struct Foo { .. } Foo;`: the inner specifier (body + name) is
		// already emitted as the struct/enum, so skip the typedef wrapper to
		// avoid a duplicate symbol of the same name. `typedef int Distance;`
		// (type field is not a body-bearing specifier) still emits via the table.
		if kind == "type_definition" {
			if let Some(ty) = node.child_by_field_name("type") {
				if ty.kind().ends_with("_specifier")
					&& ty.child_by_field_name("body").is_some()
					&& ty.child_by_field_name("name").is_some()
				{
					return None;
				}
			}
		}
		let name_node = self.generic_name_node(node)?;
		let name = self.text(name_node);
		if name.is_empty() {
			return None;
		}
		let domain = if domain == "function" && self.parent_is_method_container(parent) {
			"method"
		} else {
			domain
		};
		let selection_line = node_start_line(name_node);
		let detail = self.detail(node, Some("body"));
		Some(self.push(name, domain, node, start_line, selection_line, detail, depth, parent))
	}

	/// Cascade name resolver for [`Walker::emit_generic`]:
	/// 1. explicit `name` field (C#, C `struct`/`enum`, most modern grammars);
	/// 2. recursive `declarator`-field descent (C/C++/ObjC nest the name under
	///    `declarator`), via [`declarator_name`];
	/// 3. the first identifier-ish direct child (Kotlin/Scala put the name
	///    before params/return), descending one level through a declaration
	///    wrapper (`property_declaration` -> `variable_declaration` ->
	///    `simple_identifier`).
	fn generic_name_node<'t>(&self, node: Node<'t>) -> Option<Node<'t>> {
		if let Some(n) = node.child_by_field_name("name") {
			return Some(n);
		}
		if let Some(decl) = node.child_by_field_name("declarator") {
			if let Some(n) = declarator_name(decl) {
				return Some(n);
			}
		}
		first_name_in_decl(node)
	}

	/// True when the `parent` symbol (index) is an OO container whose direct
	/// `function` children are methods. Namespaces/modules are excluded — a
	/// function in a namespace stays a function.
	fn parent_is_method_container(&self, parent: i32) -> bool {
		if parent < 0 {
			return false;
		}
		matches!(
			self.symbols[parent as usize].kind.as_str(),
			"class" | "struct" | "interface" | "trait" | "enum"
		)
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

/// A node kind that *is* the identifier token of a declaration (the name
/// itself): `identifier`, `name`, or any `*_identifier`
/// (`type_identifier`, `simple_identifier`, `field_identifier`, ...).
fn is_name_token(kind: &str) -> bool {
	kind == "identifier" || kind == "name" || kind.ends_with("_identifier")
}

/// Follow the `declarator` field recursively to the underlying name token.
/// C/C++/ObjC nest `function_definition.declarator -> function_declarator
/// .declarator -> identifier`; pointer/array declarators wrap the same
/// `declarator` field. Returns `None` for an abstract declarator (no name).
fn declarator_name(node: Node<'_>) -> Option<Node<'_>> {
	if is_name_token(node.kind()) {
		return Some(node);
	}
	declarator_name(node.child_by_field_name("declarator")?)
}

/// Find the first identifier-ish token among a declaration's children,
/// descending through declarator/variable wrappers that carry the name one or
/// more levels down (Kotlin `property_declaration` -> `variable_declaration` ->
/// `simple_identifier`; ObjC `property_declaration` -> `struct_declaration` ->
/// `struct_declarator` -> `identifier`). Recurses ONLY through known
/// declaration wrappers, so an unrelated nested identifier (a type, an
/// initializer) is never mistaken for the declared name.
fn first_name_in_decl(node: Node<'_>) -> Option<Node<'_>> {
	let mut cur = node.walk();
	for child in node.named_children(&mut cur) {
		if is_name_token(child.kind()) {
			return Some(child);
		}
		if is_decl_wrapper(child.kind()) {
			if let Some(found) = first_name_in_decl(child) {
				return Some(found);
			}
		}
	}
	None
}

/// Declaration wrapper kinds whose payload is the declared name one level
/// deeper (see [`first_name_in_decl`]).
fn is_decl_wrapper(kind: &str) -> bool {
	matches!(
		kind,
		"variable_declaration"
			| "variable_declarator"
			| "struct_declaration"
			| "struct_declarator"
			| "message_name"
			| "enum_name"
			| "service_name"
			| "rpc_name"
	)
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
		SupportLang::CSharp => match node_kind {
			"class_declaration" | "record_declaration" | "record_struct_declaration" => {
				Some("class")
			},
			"struct_declaration" => Some("struct"),
			"interface_declaration" => Some("interface"),
			"enum_declaration" => Some("enum"),
			"enum_member_declaration" => Some("enum_member"),
			"method_declaration" => Some("method"),
			"constructor_declaration" => Some("constructor"),
			"property_declaration" => Some("property"),
			"delegate_declaration" => Some("type_alias"),
			"namespace_declaration" | "file_scoped_namespace_declaration" => Some("namespace"),
			_ => None,
		},
		SupportLang::Kotlin => match node_kind {
			"class_declaration" | "object_declaration" => Some("class"),
			"function_declaration" => Some("function"),
			"property_declaration" => Some("property"),
			"enum_entry" => Some("enum_member"),
			"type_alias" => Some("type_alias"),
			"secondary_constructor" => Some("constructor"),
			_ => None,
		},
		SupportLang::C => match node_kind {
			"preproc_def" => Some("macro"),
			"function_definition" => Some("function"),
			"struct_specifier" => Some("struct"),
			"union_specifier" => Some("union"),
			"enum_specifier" => Some("enum"),
			"enumerator" => Some("enum_member"),
			"field_declaration" => Some("field"),
			"type_definition" => Some("type_alias"),
			_ => None,
		},
		SupportLang::Cpp => match node_kind {
			"preproc_def" => Some("macro"),
			"function_definition" => Some("function"),
			"namespace_definition" => Some("namespace"),
			"class_specifier" => Some("class"),
			"struct_specifier" => Some("struct"),
			"union_specifier" => Some("union"),
			"enum_specifier" => Some("enum"),
			"enumerator" => Some("enum_member"),
			"field_declaration" => Some("field"),
			"type_definition" => Some("type_alias"),
			_ => None,
		},
		SupportLang::ObjC => match node_kind {
			"preproc_def" => Some("macro"),
			"function_definition" => Some("function"),
			"enum_specifier" => Some("enum"),
			"enumerator" => Some("enum_member"),
			"class_interface" | "class_implementation" => Some("class"),
			"protocol_declaration" => Some("interface"),
			"method_declaration" | "method_definition" => Some("method"),
			"property_declaration" => Some("property"),
			"instance_variable" => Some("field"),
			_ => None,
		},
		SupportLang::Scala => match node_kind {
			"class_definition" => Some("class"),
			"trait_definition" => Some("trait"),
			"object_definition" => Some("class"),
			"enum_definition" => Some("enum"),
			"simple_enum_case" => Some("enum_member"),
			"function_definition" | "function_declaration" => Some("function"),
			"val_definition" => Some("field"),
			_ => None,
		},
		SupportLang::Swift => match node_kind {
			"class_declaration" => Some("class"),
			"protocol_declaration" => Some("interface"),
			"property_declaration" => Some("property"),
			"function_declaration" => Some("function"),
			"protocol_function_declaration" => Some("method"),
			"enum_entry" => Some("enum_member"),
			_ => None,
		},
		SupportLang::Dart => match node_kind {
			"class_declaration" => Some("class"),
			"mixin_declaration" => Some("trait"),
			"enum_declaration" => Some("enum"),
			"enum_constant" => Some("enum_member"),
			"function_signature" => Some("function"),
			"getter_signature" => Some("property"),
			"constructor_signature" => Some("constructor"),
			"static_final_declaration" => Some("constant"),
			"initialized_identifier" => Some("field"),
			_ => None,
		},
		SupportLang::Php => match node_kind {
			"namespace_definition" => Some("namespace"),
			"class_declaration" => Some("class"),
			"interface_declaration" => Some("interface"),
			"trait_declaration" => Some("trait"),
			"method_declaration" => Some("method"),
			"function_definition" => Some("function"),
			"property_element" => Some("property"),
			"const_element" => Some("constant"),
			_ => None,
		},
		SupportLang::Ruby => match node_kind {
			"module" => Some("module"),
			"class" => Some("class"),
			"method" => Some("function"),
			"singleton_method" => Some("method"),
			_ => None,
		},
		SupportLang::Lua => match node_kind {
			"function_declaration" => Some("function"),
			_ => None,
		},
		SupportLang::Perl => match node_kind {
			"package_statement" => Some("module"),
			"subroutine_declaration_statement" => Some("function"),
			_ => None,
		},
		SupportLang::Odin => match node_kind {
			"procedure_declaration" => Some("function"),
			"struct_declaration" => Some("struct"),
			"enum_declaration" => Some("enum"),
			"const_declaration" => Some("constant"),
			"field" => Some("field"),
			_ => None,
		},
		SupportLang::Bash => match node_kind {
			"function_definition" => Some("function"),
			_ => None,
		},
		SupportLang::Solidity => match node_kind {
			"contract_declaration" => Some("class"),
			"interface_declaration" => Some("interface"),
			"library_declaration" => Some("class"),
			"struct_declaration" => Some("struct"),
			"struct_member" => Some("field"),
			"enum_declaration" => Some("enum"),
			"function_definition" => Some("function"),
			"modifier_definition" => Some("method"),
			"state_variable_declaration" => Some("property"),
			"event_definition" => Some("macro"),
			_ => None,
		},
		SupportLang::Starlark => match node_kind {
			"function_definition" => Some("function"),
			_ => None,
		},
		SupportLang::Graphql => match node_kind {
			"object_type_definition" | "input_object_type_definition" => Some("struct"),
			"interface_type_definition" => Some("interface"),
			"enum_type_definition" => Some("enum"),
			"enum_value" => Some("enum_member"),
			"scalar_type_definition" | "union_type_definition" => Some("type_alias"),
			"directive_definition" => Some("macro"),
			"field_definition" => Some("field"),
			_ => None,
		},
		SupportLang::Proto => match node_kind {
			"message" => Some("struct"),
			"enum" => Some("enum"),
			"enum_field" => Some("enum_member"),
			"service" => Some("interface"),
			"rpc" => Some("method"),
			"field" => Some("field"),
			_ => None,
		},
		SupportLang::Tlaplus => match node_kind {
			"module" | "module_definition" => Some("module"),
			"operator_definition" | "function_definition" => Some("function"),
			"constant_declaration" => Some("constant"),
			"variable_declaration" => Some("variable"),
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

// ── Bespoke emitters: R / Julia / Zig / Haskell / OCaml / Elixir / Erlang / ─
// ── Clojure / Emacs-Lisp / PowerShell ──────────────────────────────────────

impl<'a> Walker<'a> {
	/// R: declarations are assignment `binary_operator`s; the name is the LHS
	/// (RHS for `->`/`->>`), the kind comes from the RHS shape.
	fn emit_r(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		if kind != "binary_operator" {
			return None;
		}
		let op = node.child_by_field_name("operator")?;
		let op_text = self.text(op);
		let is_forward = matches!(op_text.as_str(), "<-" | "<<-" | "=");
		let is_reverse = matches!(op_text.as_str(), "->" | "->>");
		if !is_forward && !is_reverse {
			return None;
		}
		let lhs = node.child_by_field_name("lhs")?;
		let rhs = node.child_by_field_name("rhs")?;
		let (name_node, value_node) = if is_forward { (lhs, rhs) } else { (rhs, lhs) };
		if name_node.kind() != "identifier" {
			return None;
		}
		let name = self.text(name_node);
		if name.is_empty() {
			return None;
		}
		let kind_str = match value_node.kind() {
			"function_definition" => "function",
			"integer" | "float" | "complex" | "string" | "true" | "false" | "null" | "inf"
			| "nan" | "na" => "constant",
			_ => "variable",
		};
		let sel = node_start_line(name_node);
		let detail = self.detail(node, None);
		Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
	}

	/// Julia: module/function/struct/abstract/const, names under
	/// signature/type_head/assignment wrappers.
	fn emit_julia(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"module_definition" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "module", node, start_line, sel, detail, depth, parent))
			},
			"function_definition" => {
				let name_node = julia_function_name(node)?;
				let name = self.text(name_node);
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"struct_definition" => {
				let name_node = julia_type_name(node)?;
				let name = self.text(name_node);
				let sel = node_start_line(name_node);
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "struct", node, start_line, sel, detail, depth, parent))
			},
			"abstract_definition" => {
				let name_node = julia_type_name(node)?;
				let name = self.text(name_node);
				let sel = node_start_line(name_node);
				let detail = self.detail(node, Some("body"));
				Some(self.push(name, "type_alias", node, start_line, sel, detail, depth, parent))
			},
			"const_statement" => {
				let assign = node.named_child(0).filter(|c| c.kind() == "assignment")?;
				let name_node = assign.named_child(0).filter(|c| c.kind() == "identifier")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(assign, None);
				Some(self.push(name, "constant", assign, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}

	/// Zig: top-level `fn` -> function/method; const-bound struct/enum -> the
	/// container; `container_field` -> field/enum_member.
	fn emit_zig(
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
				let kind_str = if self.parent_is_method_container(parent) {
					"method"
				} else {
					"function"
				};
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			"variable_declaration" => {
				let name_node = zig_var_name(node)?;
				let rhs = zig_var_rhs(node)?;
				let kind_str = match rhs.kind() {
					"struct_declaration" => "struct",
					"enum_declaration" => "enum",
					_ => "constant",
				};
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			"container_field" => {
				let kind_str = match parent_kind(node) {
					Some("struct_declaration") => "field",
					Some("enum_declaration") => "enum_member",
					_ => return None,
				};
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}

	/// Haskell: module/data/type/class plus equation-coalesced functions.
	fn emit_haskell(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"module" => {
				let module_id = node.named_child(0).filter(|n| n.kind() == "module_id")?;
				let name = self.text(module_id);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(module_id);
				let detail = self.detail(node, None);
				Some(self.push(name, "module", node, start_line, sel, detail, depth, parent))
			},
			"function" | "bind" => {
				if parent_kind(node) != Some("declarations") {
					return None;
				}
				let name = self.name_text(node, "name")?;
				if self.haskell_has_equation_predecessor(node) {
					return None;
				}
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, Some("match"));
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"signature" => None,
			"data_type" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "struct", node, start_line, sel, detail, depth, parent))
			},
			"data_constructor" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "enum_member", node, start_line, sel, detail, depth, parent))
			},
			"type_synomym" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "type_alias", node, start_line, sel, detail, depth, parent))
			},
			"class" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "interface", node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}

	/// True when a prior sibling equation already emitted this Haskell
	/// function/bind name (skip duplicate equations; `signature` is hopped).
	fn haskell_has_equation_predecessor(&self, node: Node<'_>) -> bool {
		let name = match self.name_text(node, "name") {
			Some(n) if !n.is_empty() => n,
			_ => return false,
		};
		let mut cursor = node.prev_named_sibling();
		while let Some(prev) = cursor {
			match prev.kind() {
				"function" | "bind" => {
					if self.name_text(prev, "name").map(|n| n == name).unwrap_or(false) {
						return true;
					}
					break;
				},
				"signature" => cursor = prev.prev_named_sibling(),
				_ => break,
			}
		}
		false
	}

	/// OCaml: module/let/type/variant; emits the inner binding nodes, not the
	/// `value_definition`/`type_definition` wrappers.
	fn emit_ocaml(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"module_definition" => {
				let binding = node
					.child_by_field_name("module_binding")
					.or_else(|| node.named_child(0))?;
				let name_node = binding
					.child_by_field_name("module_name")
					.or_else(|| binding.named_child(0).filter(|n| n.kind() == "module_name"))?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "module", node, start_line, sel, detail, depth, parent))
			},
			"let_binding" => {
				if !is_ocaml_top_level_let(node) {
					return None;
				}
				let name_node = node.named_child(0).filter(|n| n.kind() == "value_name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let mut cur = node.walk();
				let has_params = node.named_children(&mut cur).any(|c| c.kind() == "parameter");
				let kind_str = if has_params { "function" } else { "constant" };
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			"type_binding" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "type_alias", node, start_line, sel, detail, depth, parent))
			},
			"constructor_declaration" => {
				let name_node = node.named_child(0).filter(|n| n.kind() == "constructor_name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "enum_member", node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}

	/// Elixir: every declaration is a `call` whose head identifier is a
	/// def-macro; ordinary calls pass through.
	fn emit_elixir(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		if kind != "call" {
			return None;
		}
		let head = node.named_child(0)?;
		let head_text = self.text(head);
		let (name, kind_str, name_node): (String, &str, Node<'_>) = match head_text.as_str() {
			"defmodule" | "defprotocol" => {
				let args = node
					.child_by_field_name("arguments")
					.or_else(|| node.named_child(1))?;
				let alias = elixir_first_alias(args)?;
				(
					self.text(alias),
					if head_text == "defmodule" { "module" } else { "interface" },
					alias,
				)
			},
			"defimpl" => {
				let args = node
					.child_by_field_name("arguments")
					.or_else(|| node.named_child(1))?;
				let alias = elixir_first_alias(args)?;
				(self.text(alias), "class", alias)
			},
			"defstruct" => {
				let module = (parent >= 0)
					.then(|| self.symbols.get(parent as usize))
					.flatten()?;
				if module.kind != "module" {
					return None;
				}
				(module.name.clone(), "struct", head)
			},
			"def" | "defp" | "defmacro" => {
				let args = node
					.child_by_field_name("arguments")
					.or_else(|| node.named_child(1))?;
				let sig = elixir_signature_name(args)?;
				(
					self.text(sig),
					if head_text == "defmacro" { "macro" } else { "function" },
					sig,
				)
			},
			_ => return None,
		};
		if name.is_empty() {
			return None;
		}
		let sel = node_start_line(name_node);
		let detail = self.detail(node, Some("do_block"));
		Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
	}

	/// Erlang: module/record/macro attributes plus clause-coalesced functions.
	fn emit_erlang(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"module_attribute" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "module", node, start_line, sel, detail, depth, parent))
			},
			"record_decl" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "struct", node, start_line, sel, detail, depth, parent))
			},
			"macro_lhs" => {
				let name = self.name_text(node, "name")?;
				let sel = self.selection_line(node, "name");
				let detail = self.detail(node, None);
				Some(self.push(name, "macro", node, start_line, sel, detail, depth, parent))
			},
			"fun_decl" => {
				if erlang_is_duplicate_clause(self.source, node) {
					return None;
				}
				let clause = node.named_child(0).filter(|c| c.kind() == "function_clause")?;
				let name_node = clause.child_by_field_name("name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}

	/// Clojure: a `list_lit` whose head `sym_lit` is a def-form; the second
	/// `sym_lit` is the name.
	fn emit_clojure(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		if kind != "list_lit" {
			return None;
		}
		let mut cursor = node.walk();
		let values: Vec<Node<'_>> = node.children_by_field_name("value", &mut cursor).collect();
		if values.len() < 2 {
			return None;
		}
		let head = values[0];
		let name_node = values[1];
		if head.kind() != "sym_lit" || name_node.kind() != "sym_lit" {
			return None;
		}
		let domain = match self.text(head).as_str() {
			"defn" | "defn-" => "function",
			"defmacro" => "macro",
			"def" => "variable",
			"defrecord" | "deftype" => "struct",
			"defprotocol" => "interface",
			"ns" => "namespace",
			_ => return None,
		};
		let name = self.text(name_node);
		if name.is_empty() {
			return None;
		}
		let selection_line = node_start_line(name_node);
		let detail = self.detail(node, None);
		Some(self.push(name, domain, node, start_line, selection_line, detail, depth, parent))
	}

	/// Emacs Lisp: defun/defmacro have a name field; defconst/defvar/defstruct/
	/// defclass are `special_form`/`list` with a head keyword + name symbol.
	fn emit_emacslisp(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"function_definition" => {
				let name = self.elisp_name(node)?;
				let selection_line = node_start_line(name);
				let detail = self.detail(node, None);
				Some(self.push(
					self.text(name),
					"function",
					node,
					start_line,
					selection_line,
					detail,
					depth,
					parent,
				))
			},
			"macro_definition" => {
				let name = self.elisp_name(node)?;
				let selection_line = node_start_line(name);
				let detail = self.detail(node, None);
				Some(self.push(
					self.text(name),
					"macro",
					node,
					start_line,
					selection_line,
					detail,
					depth,
					parent,
				))
			},
			"special_form" | "list" => {
				let head = node.child(1)?;
				let domain = match self.text(head).trim() {
					"defconst" => "constant",
					"defvar" => "variable",
					"defmacro" => "macro",
					"defstruct" => "struct",
					"defclass" => "class",
					_ => return None,
				};
				let name = self.elisp_name(node)?;
				let selection_line = node_start_line(name);
				let detail = self.detail(node, None);
				Some(self.push(
					self.text(name),
					domain,
					node,
					start_line,
					selection_line,
					detail,
					depth,
					parent,
				))
			},
			_ => None,
		}
	}

	/// Resolve the declared name of an Emacs Lisp form: explicit `name` field,
	/// else the first named `symbol` after the head token (child 1).
	fn elisp_name<'b>(&self, node: Node<'b>) -> Option<Node<'b>> {
		if let Some(n) = node.child_by_field_name("name") {
			return Some(n);
		}
		for i in 2..node.child_count() {
			let c = node.child(i)?;
			if c.is_named() && c.kind() == "symbol" {
				return Some(c);
			}
		}
		None
	}

	/// PowerShell: function/class/enum/method/property/enum_member, with names
	/// in function_name/simple_name/variable children; a method whose name
	/// equals the enclosing class is a constructor.
	fn emit_powershell(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		let class_name = (parent >= 0)
			.then(|| &self.symbols[parent as usize])
			.filter(|s| s.kind == "class")
			.map(|s| s.name.clone());
		match kind {
			"function_statement" => {
				let name_node = powershell_child(node, "function_name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"class_statement" => {
				let name_node = powershell_child(node, "simple_name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "class", node, start_line, sel, detail, depth, parent))
			},
			"class_method_definition" => {
				let name_node = powershell_child(node, "simple_name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let kind_str = if class_name.as_deref() == Some(&name) {
					"constructor"
				} else {
					"method"
				};
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			"class_property_definition" => {
				let var = powershell_child(node, "variable")?;
				let raw = self.text(var);
				let name = raw.strip_prefix('$').unwrap_or(&raw).to_string();
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(var);
				let detail = self.detail(node, None);
				Some(self.push(name, "property", node, start_line, sel, detail, depth, parent))
			},
			"enum_statement" => {
				let name_node = powershell_child(node, "simple_name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "enum", node, start_line, sel, detail, depth, parent))
			},
			"enum_member" => {
				let name_node = powershell_child(node, "simple_name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "enum_member", node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}
	/// TLA+: module/operator/function defs go through the generic cascade
	/// (`name` field); only `constant_declaration`/`variable_declaration`
	/// (comma-lists like `CONSTANTS A, B, C`) need a multi-name emitter.
	fn emit_tlaplus(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		if kind != "constant_declaration" && kind != "variable_declaration" {
			return self.emit_generic(node, kind, depth, parent, start_line);
		}
		let domain = symbol_kind(self.language, kind)?;
		let mut first: Option<usize> = None;
		let mut cursor = node.walk();
		for child in node.named_children(&mut cursor) {
			let name_node = match child.kind() {
				"identifier" => Some(child),
				"operator_declaration" => child.child_by_field_name("name"),
				_ => None,
			};
			let Some(name_node) = name_node else { continue };
			let name = self.text(name_node);
			if name.is_empty() {
				continue;
			}
			let idx = self.push(
				name,
				domain,
				node,
				start_line,
				node_start_line(name_node),
				self.detail(node, None),
				depth,
				parent,
			);
			if first.is_none() {
				first = Some(idx);
			}
		}
		first
	}

	/// SQL (tree-sitter-sequel): CREATE-style DDL only. Table/view/function
	/// names live in an `object_reference` child's `name` field (not a `name`
	/// field on the statement). DML/query statements emit nothing.
	fn emit_sql(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		let (name_node, domain) = match kind {
			"create_table" | "create_view" => {
				let obj = sql_first_object_reference(node)?;
				(obj.child_by_field_name("name")?, "struct")
			},
			"create_function" | "create_procedure" => {
				let obj = sql_first_object_reference(node)?;
				(obj.child_by_field_name("name")?, "function")
			},
			"column_definition" if parent_kind(node) == Some("column_definitions") => {
				(node.child_by_field_name("name")?, "field")
			},
			_ => return None,
		};
		let name = self.text(name_node);
		if name.is_empty() {
			return None;
		}
		let selection_line = node_start_line(name_node);
		let detail = self.detail(node, None);
		Some(self.push(name, domain, node, start_line, selection_line, detail, depth, parent))
	}

	/// Verilog/SystemVerilog: module/function/task declarations. Module names
	/// sit in `module_header`; function/task names nest under
	/// `*_body_declaration -> *_identifier`. Ports/nets are not emitted (their
	/// identifiers interleave with widths/types and would be spurious).
	fn emit_verilog(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		let (name_node, domain) = match kind {
			"module_declaration" => {
				let header = verilog_first_child(node, "module_header")?;
				(verilog_name_token(header)?, "module")
			},
			"function_declaration" => {
				let body = verilog_first_child(node, "function_body_declaration")?;
				let fid = verilog_first_child(body, "function_identifier")?;
				(verilog_name_token(fid)?, "function")
			},
			"task_declaration" => {
				let body = verilog_first_child(node, "task_body_declaration")?;
				let tid = verilog_first_child(body, "task_identifier")?;
				(verilog_name_token(tid)?, "function")
			},
			_ => return None,
		};
		let name = self.text(name_node);
		if name.is_empty() {
			return None;
		}
		let selection_line = node_start_line(name_node);
		let detail = self.detail(node, None);
		Some(self.push(name, domain, node, start_line, selection_line, detail, depth, parent))
	}

	/// HCL: a `block` maps to `struct`, named by its type identifier + labels
	/// (the canonical `type.label...` address). Only file-scope `attribute`s
	/// emit (constant for a literal RHS, else field); block-internal
	/// attributes are config values, not symbols.
	fn emit_hcl(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"block" => {
				let (type_ident, labels) = hcl_block_ident_and_labels(node)?;
				let type_text = self.text(type_ident);
				let name_node = labels.last().copied().unwrap_or(type_ident);
				let name = if labels.is_empty() {
					type_text
				} else {
					let mut parts = vec![type_text];
					for lbl in &labels {
						parts.push(hcl_label_text(self.source, *lbl));
					}
					parts.join(".")
				};
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "struct", node, start_line, sel, detail, depth, parent))
			},
			"attribute" => {
				if !hcl_is_top_level_attr(node) {
					return None;
				}
				let name_node = hcl_attr_name(node)?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let is_literal = hcl_attr_expr(node)
					.and_then(|e| e.named_child(0))
					.map(|c| c.kind() == "literal_value")
					.unwrap_or(false);
				let kind_str = if is_literal { "constant" } else { "field" };
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}

	/// Nix: a file-scope `binding` (`attrpath = expr;`) maps to `function`
	/// (RHS a `function_expression`) or `constant`. Deep/local bindings are
	/// skipped via [`nix_is_file_scope_binding`].
	fn emit_nix(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		if kind != "binding" || !nix_is_file_scope_binding(node) {
			return None;
		}
		let path = node.child_by_field_name("attrpath")?;
		let name = nix_attrpath_text(self.source, path)?;
		if name.is_empty() {
			return None;
		}
		let expr = node.child_by_field_name("expression")?;
		let kind_str = if nix_rhs_is_function(&expr) {
			"function"
		} else {
			"constant"
		};
		let sel = node_start_line(path);
		let detail = self.detail(node, None);
		Some(self.push(name, kind_str, node, start_line, sel, detail, depth, parent))
	}
	/// Dockerfile: a multi-stage build names a stage via `FROM ... AS <alias>`
	/// (the `as` field of a `from_instruction` is an `image_alias`). Only named
	/// stages emit, mapped to `namespace` (a named build-stage grouping).
	fn emit_dockerfile(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		if kind != "from_instruction" {
			return None;
		}
		let alias = node.child_by_field_name("as")?;
		let name = self.text(alias);
		if name.is_empty() {
			return None;
		}
		let sel = node_start_line(alias);
		let detail = self.detail(node, None);
		Some(self.push(name, "namespace", node, start_line, sel, detail, depth, parent))
	}

	/// CMake: `function_def` -> function, `macro_def` -> macro. The name is the
	/// first argument of the opening `function_command`/`macro_command`'s
	/// `argument_list` (the def node has no `name` field).
	fn emit_cmake(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		let command_kind = match kind {
			"function_def" => "function_command",
			"macro_def" => "macro_command",
			_ => return None,
		};
		let command = first_named_child_of_kind(node, command_kind)?;
		let args = first_named_child_of_kind(command, "argument_list")?;
		let name_node = first_named_child_of_kind(args, "argument")?;
		let name = self.text(name_node);
		if name.is_empty() {
			return None;
		}
		let domain = if kind == "function_def" { "function" } else { "macro" };
		let sel = node_start_line(name_node);
		let detail = self.detail(node, None);
		Some(self.push(name, domain, node, start_line, sel, detail, depth, parent))
	}

	/// Make: a `rule` -> function named by its first target (the `targets`
	/// child, not the prerequisite fields). `variable_assignment` -> constant.
	fn emit_make(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"rule" => {
				let targets = first_named_child_of_kind(node, "targets")?;
				let name_node = targets.named_child(0)?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"variable_assignment" => {
				let name_node = node.child_by_field_name("name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "constant", node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}

	/// Just: a `recipe` -> function (named by its `recipe_header`'s `name`);
	/// the whole recipe node is emitted so `end_line` covers the body.
	/// `assignment` -> constant (its `left` identifier).
	fn emit_just(
		&mut self,
		node: Node<'_>,
		kind: &str,
		depth: u32,
		parent: i32,
		start_line: u32,
	) -> Option<usize> {
		match kind {
			"recipe" => {
				let header = first_named_child_of_kind(node, "recipe_header")?;
				let name_node = header.child_by_field_name("name")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "function", node, start_line, sel, detail, depth, parent))
			},
			"assignment" => {
				let name_node = node.child_by_field_name("left")?;
				let name = self.text(name_node);
				if name.is_empty() {
					return None;
				}
				let sel = node_start_line(name_node);
				let detail = self.detail(node, None);
				Some(self.push(name, "constant", node, start_line, sel, detail, depth, parent))
			},
			_ => None,
		}
	}
}

/// First direct named child of `node` with the given kind (SQL object
/// references and Verilog header/body wrappers have no field names).
fn first_named_child_of_kind<'b>(node: Node<'b>, kind: &str) -> Option<Node<'b>> {
	let mut cursor = node.walk();
	node.children(&mut cursor).find(|c| c.is_named() && c.kind() == kind)
}

/// The `object_reference` child naming a SQL `CREATE TABLE/VIEW/FUNCTION`.
fn sql_first_object_reference(node: Node<'_>) -> Option<Node<'_>> {
	first_named_child_of_kind(node, "object_reference")
}

/// First direct named child of a Verilog node with the given kind.
fn verilog_first_child<'b>(node: Node<'b>, kind: &str) -> Option<Node<'b>> {
	first_named_child_of_kind(node, kind)
}

/// The declared name token of a Verilog declaration header/identifier node.
/// `function_identifier`/`task_identifier` wrap a same-kind child one level
/// down (`function_identifier -> function_identifier -> simple_identifier`),
/// so descend through those wrappers before picking the name token.
fn verilog_name_token<'b>(node: Node<'b>) -> Option<Node<'b>> {
	let mut cur = node;
	loop {
		let mut cursor = cur.walk();
		if let Some(name) = cur
			.children(&mut cursor)
			.find(|c| c.kind() == "simple_identifier" || c.kind() == "escaped_identifier")
		{
			return Some(name);
		}
		let mut cursor2 = cur.walk();
		let inner = cur.children(&mut cursor2).find(|c| c.kind() == cur.kind());
		match inner {
			Some(n) => cur = n,
			None => return None,
		}
	}
}

/// The type `identifier` (first named child) and the label nodes of an HCL
/// `block`. The grammar gives `block` no fields, so parts are read
/// positionally: a leading type `identifier`, then zero+ labels (each a
/// `string_lit` or a bare `identifier`), then the structural body tokens.
fn hcl_block_ident_and_labels(node: Node<'_>) -> Option<(Node<'_>, Vec<Node<'_>>)> {
	let mut cursor = node.walk();
	let mut type_ident = None;
	let mut labels = Vec::new();
	for child in node.children(&mut cursor) {
		if !child.is_named() {
			continue;
		}
		match child.kind() {
			"identifier" if type_ident.is_none() => type_ident = Some(child),
			"identifier" | "string_lit" => labels.push(child),
			_ => break,
		}
	}
	Some((type_ident?, labels))
}

/// Unquoted text of an HCL block label (a bare `identifier`, or a `string_lit`
/// wrapping a `template_literal`).
fn hcl_label_text(source: &[u8], node: Node<'_>) -> String {
	if node.kind() == "identifier" {
		return String::from_utf8_lossy(&source[node.start_byte()..node.end_byte()]).into_owned();
	}
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.kind() == "template_literal" {
			return String::from_utf8_lossy(&source[child.start_byte()..child.end_byte()]).into_owned();
		}
	}
	let raw = String::from_utf8_lossy(&source[node.start_byte()..node.end_byte()]);
	raw.trim_matches('"').to_string()
}

/// True when an HCL `attribute` sits at file scope (parent `body` under the
/// `config_file` root); block-internal attributes are config values.
fn hcl_is_top_level_attr(node: Node<'_>) -> bool {
	let body = match node.parent() {
		Some(p) if p.kind() == "body" => p,
		_ => return false,
	};
	matches!(body.parent().map(|p| p.kind()), Some("config_file"))
}

/// The `identifier` name of an HCL `attribute` (first named child).
fn hcl_attr_name(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	node.children(&mut cursor)
		.find(|c| c.is_named() && c.kind() == "identifier")
}

/// The `expression` child of an HCL `attribute`.
fn hcl_attr_expr(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	node.children(&mut cursor)
		.find(|c| c.is_named() && c.kind() == "expression")
}

/// True when a Nix `binding` is at file scope: its enclosing `binding_set`'s
/// container (`attrset_expression`/`rec_attrset_expression`/`let_expression`)
/// sits directly under `source_code`, or is the body of a file-level
/// `function_expression` (the `{ args }: ...` file wrapper). Deeper bindings
/// are local scope and skipped.
fn nix_is_file_scope_binding(node: Node<'_>) -> bool {
	let binding_set = match node.parent() {
		Some(p) if p.kind() == "binding_set" => p,
		_ => return false,
	};
	let Some(container) = binding_set.parent() else {
		return false;
	};
	if !matches!(
		container.kind(),
		"attrset_expression" | "rec_attrset_expression" | "let_expression"
	) {
		return false;
	}
	if matches!(container.parent().map(|p| p.kind()), Some("source_code")) {
		return true;
	}
	if let Some(func) = container.parent() {
		if func.kind() == "function_expression"
			&& matches!(func.parent().map(|p| p.kind()), Some("source_code"))
		{
			return true;
		}
	}
	false
}

/// Dotted name of a Nix `attrpath` (its `attr` children joined with `.`).
/// Plain identifiers and string-literal keys contribute; a dynamic
/// interpolation key is not addressable, so the whole path is rejected.
fn nix_attrpath_text(source: &[u8], node: Node<'_>) -> Option<String> {
	let mut cursor = node.walk();
	let mut parts = Vec::new();
	for child in node.children_by_field_name("attr", &mut cursor) {
		match child.kind() {
			"identifier" => parts.push(
				String::from_utf8_lossy(&source[child.start_byte()..child.end_byte()]).into_owned(),
			),
			"string_expression" => parts.push(nix_string_text(source, child)),
			_ => return None,
		}
	}
	if parts.is_empty() {
		return None;
	}
	Some(parts.join("."))
}

/// Literal text of a Nix `string_expression` (concatenated `string_fragment`s),
/// for quoted attr keys like `."foo-bar"`.
fn nix_string_text(source: &[u8], node: Node<'_>) -> String {
	let mut cursor = node.walk();
	let mut out = String::new();
	for child in node.children(&mut cursor) {
		if child.kind() == "string_fragment" {
			out.push_str(&String::from_utf8_lossy(&source[child.start_byte()..child.end_byte()]));
		}
	}
	out
}

/// True when a Nix binding's RHS is a direct `function_expression`
/// (conservative — a curried apply or a stored-function call is not a lambda).
fn nix_rhs_is_function(expr: &Node<'_>) -> bool {
	expr.kind() == "function_expression"
}

/// Julia `function_definition` name via `signature -> call_expression ->
/// function` (bare identifier, or trailing identifier of `Base.area`).
fn julia_function_name(node: Node<'_>) -> Option<Node<'_>> {
	let signature = node
		.child_by_field_name("signature")
		.or_else(|| node.named_child(0).filter(|c| c.kind() == "signature"))?;
	let call = signature
		.child_by_field_name("call_expression")
		.or_else(|| signature.named_child(0).filter(|c| c.kind() == "call_expression"))?;
	let callee = call
		.child_by_field_name("function")
		.or_else(|| call.named_child(0))?;
	match callee.kind() {
		"identifier" => Some(callee),
		"field_expression" => {
			let mut cursor = callee.walk();
			callee
				.children(&mut cursor)
				.filter(|c| c.is_named())
				.last()
				.filter(|c| c.kind() == "identifier")
		},
		_ => None,
	}
}

/// Julia `struct_definition`/`abstract_definition` name via `type_head`.
fn julia_type_name(node: Node<'_>) -> Option<Node<'_>> {
	let type_head = node
		.child_by_field_name("type_head")
		.or_else(|| node.named_child(0).filter(|c| c.kind() == "type_head"))?;
	type_head
		.child_by_field_name("name")
		.or_else(|| type_head.named_child(0).filter(|c| c.kind() == "identifier"))
}

/// Declared-name identifier of a Zig `variable_declaration` (first child).
fn zig_var_name(node: Node<'_>) -> Option<Node<'_>> {
	node.named_child(0).filter(|c| c.kind() == "identifier")
}

/// Right-hand side of a Zig `variable_declaration` (last named child).
fn zig_var_rhs(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	node.children(&mut cursor).filter(|c| c.is_named()).last()
}

/// First `alias` child of an Elixir `arguments` node (module/protocol name).
fn elixir_first_alias(node: Node<'_>) -> Option<Node<'_>> {
	let mut cursor = node.walk();
	for child in node.children(&mut cursor) {
		if child.is_named() && child.kind() == "alias" {
			return Some(child);
		}
	}
	None
}

/// Leading name node of an Elixir `def`/`defp`/`defmacro` signature: a bare
/// `identifier`, or the head identifier of a `call` (`def foo(args)`).
fn elixir_signature_name(node: Node<'_>) -> Option<Node<'_>> {
	let first = node.named_child(0)?;
	match first.kind() {
		"identifier" => Some(first),
		"call" => first.named_child(0).filter(|c| c.kind() == "identifier"),
		_ => None,
	}
}

/// True when an Erlang `fun_decl` continues a preceding same-named `fun_decl`
/// (a later clause of an already-emitted function).
fn erlang_is_duplicate_clause(source: &[u8], node: Node<'_>) -> bool {
	let Some(clause) = node.named_child(0).filter(|c| c.kind() == "function_clause") else {
		return false;
	};
	let Some(name_node) = clause.child_by_field_name("name") else {
		return false;
	};
	let name_bytes = &source[name_node.start_byte()..name_node.end_byte()];
	let mut sib = node.prev_sibling();
	while let Some(s) = sib {
		if s.kind() == "fun_decl" {
			if let Some(s_clause) = s.named_child(0).filter(|c| c.kind() == "function_clause") {
				if let Some(s_name) = s_clause.child_by_field_name("name") {
					if &source[s_name.start_byte()..s_name.end_byte()] == name_bytes {
						return true;
					}
				}
			}
		}
		sib = s.prev_sibling();
	}
	false
}

/// True when an OCaml `let_binding` sits directly at module/structure scope
/// (excludes `let ... in` expression locals).
fn is_ocaml_top_level_let(node: Node<'_>) -> bool {
	let mut cursor = node;
	while let Some(parent) = cursor.parent() {
		if parent.kind() == "value_definition" {
			return matches!(
				parent.parent().map(|p| p.kind()),
				Some("structure") | Some("compilation_unit")
			);
		}
		cursor = parent;
	}
	false
}

/// First direct child of `node` with the given kind (PowerShell name lookup).
fn powershell_child<'b>(node: Node<'b>, kind: &str) -> Option<Node<'b>> {
	let mut cursor = node.walk();
	node.children(&mut cursor).find(|c| c.kind() == kind)
}

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

	/// Ad-hoc node-kind explorer for authoring new-language `symbol_kind`
	/// tables. Run with:
	///   cargo test -p pi-ast dump_fixture_node_kinds -- --ignored --nocapture
	/// Prints the named-node tree (with `name` fields) for every file under
	/// `tests/fixtures/symbols/`. Ignored by default — a derivation aid, not
	/// an assertion.
	#[test]
	#[ignore]
	fn dump_fixture_node_kinds() {
		let dir = format!("{}/tests/fixtures/symbols", env!("CARGO_MANIFEST_DIR"));
		let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
			.expect("fixtures dir")
			.filter_map(|e| e.ok().map(|e| e.path()))
			.filter(|p| p.is_file())
			.collect();
		paths.sort();
		for path in paths {
			let Ok(code) = std::fs::read_to_string(&path) else {
				println!("\n===== {} (SKIPPED: unreadable) =====", path.display());
				continue;
			};
			let Some(lang) = resolve_language(None, path.to_str()) else {
				println!("\n===== {} (SKIPPED: unresolved language) =====", path.display());
				continue;
			};
			let mut parser = Parser::new();
			if parser.set_language(&lang.get_ts_language()).is_err() {
				println!("\n===== {} (SKIPPED: grammar load failed) =====", path.display());
				continue;
			}
			let Some(tree) = parser.parse(code.as_bytes(), None) else {
				println!("\n===== {} (SKIPPED: parse failed) =====", path.display());
				continue;
			};
			println!(
				"\n===== {} ({}) =====",
				path.file_name().unwrap().to_string_lossy(),
				lang.canonical_name()
			);
			dump_node(tree.root_node(), code.as_bytes(), 0);
		}
	}

	fn dump_node(node: Node<'_>, src: &[u8], depth: usize) {
		if node.is_named() {
			let name = node
				.child_by_field_name("name")
				.map(|n| String::from_utf8_lossy(&src[n.start_byte()..n.end_byte()]).into_owned());
			let suffix = name.map(|n| format!("  name={n:?}")).unwrap_or_default();
			println!("{:indent$}{}{}", "", node.kind(), suffix, indent = depth * 2);
		}
		let mut c = node.walk();
		for child in node.children(&mut c) {
			dump_node(child, src, depth + 1);
		}
	}

	fn fixture(name: &str) -> String {
		std::fs::read_to_string(format!(
			"{}/tests/fixtures/symbols/{name}",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("read fixture")
	}

	/// Drift guard: every fixture resolves to an `outline_languages()` member
	/// and yields a non-empty outline. A generic language listed without a
	/// working table — or a grammar that regressed to empty — fails here.
	#[test]
	fn fixture_languages_are_supported_and_nonempty() {
		let dir = format!("{}/tests/fixtures/symbols", env!("CARGO_MANIFEST_DIR"));
		let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
			.expect("fixtures dir")
			.filter_map(|e| e.ok().map(|e| e.path()))
			.filter(|p| p.is_file())
			.collect();
		paths.sort();
		assert!(!paths.is_empty(), "no symbol fixtures present");
		for path in paths {
			let code = std::fs::read_to_string(&path).expect("read fixture");
			let lang = resolve_language(None, path.to_str())
				.unwrap_or_else(|| panic!("unresolved fixture language: {}", path.display()));
			assert!(
				outline_languages().contains(&lang),
				"fixture {} -> {} is not in outline_languages()",
				path.display(),
				lang.canonical_name()
			);
			let result = outline(&code, path.to_str().expect("utf8 path"));
			assert!(result.parsed, "fixture {} did not parse", path.display());
			assert!(
				!result.symbols.is_empty(),
				"fixture {} produced an empty outline",
				path.display()
			);
		}
	}

	/// Programming-vs-data boundary: data languages are excluded from
	/// `outline_languages()` and yield no symbols.
	#[test]
	fn data_languages_are_excluded() {
		for (code, path) in [
			("{\"a\": 1, \"b\": [2, 3]}", "data.json"),
			("a: 1\nb:\n  - 2\n", "data.yaml"),
		] {
			let lang = resolve_language(None, Some(path)).expect("resolves");
			assert!(
				!outline_languages().contains(&lang),
				"{} should not be an outline language",
				lang.canonical_name()
			);
			let result = outline(code, path);
			assert!(
				result.symbols.is_empty(),
				"{} should produce no symbols",
				lang.canonical_name()
			);
		}
	}

	#[test]
	fn outlines_csharp_class_method_property_enum_struct() {
		let code = fixture("csharp.cs");
		let r = outline(&code, "csharp.cs");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("csharp"));
		assert_eq!(find(&r, "Greeter").map(|s| s.kind.as_str()), Some("class"));
		assert_eq!(find(&r, "Greet").map(|s| s.kind.as_str()), Some("method"));
		assert_eq!(find(&r, "Count").map(|s| s.kind.as_str()), Some("property"));
		assert_eq!(find(&r, "IThing").map(|s| s.kind.as_str()), Some("interface"));
		assert_eq!(find(&r, "Color").map(|s| s.kind.as_str()), Some("enum"));
		assert_eq!(find(&r, "Red").map(|s| s.kind.as_str()), Some("enum_member"));
		assert_eq!(find(&r, "Point").map(|s| s.kind.as_str()), Some("struct"));
		let greet = find(&r, "Greet").expect("Greet present");
		assert!(greet.parent >= 0);
		assert_eq!(r.symbols[greet.parent as usize].name, "Greeter");
	}

	#[test]
	fn outlines_kotlin_class_function_method_property_enum_object() {
		let code = fixture("kotlin.kt");
		let r = outline(&code, "kotlin.kt");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("kotlin"));
		assert_eq!(find(&r, "Greeter").map(|s| s.kind.as_str()), Some("class"));
		assert_eq!(find(&r, "topLevel").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "greet").map(|s| s.kind.as_str()), Some("method"));
		assert_eq!(find(&r, "count").map(|s| s.kind.as_str()), Some("property"));
		assert_eq!(find(&r, "RED").map(|s| s.kind.as_str()), Some("enum_member"));
		assert_eq!(find(&r, "Singleton").map(|s| s.kind.as_str()), Some("class"));
		let greet = find(&r, "greet").expect("greet present");
		assert!(greet.parent >= 0);
		assert_eq!(r.symbols[greet.parent as usize].name, "Greeter");
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

	#[test]
	fn every_outline_language_has_a_fixture() {
		let dir = format!("{}/tests/fixtures/symbols", env!("CARGO_MANIFEST_DIR"));
		let langs: Vec<SupportLang> = std::fs::read_dir(&dir)
			.expect("fixtures dir")
			.filter_map(|e| e.ok().map(|e| e.path()))
			.filter(|p| p.is_file())
			.filter_map(|p| resolve_language(None, p.to_str()))
			.collect();
		for &lang in outline_languages() {
			assert!(
				langs.contains(&lang),
				"outline language {} has no fixture under tests/fixtures/symbols/",
				lang.canonical_name()
			);
		}
	}

	#[test]
	fn outlines_c_typedef_struct_no_double_emit_and_specifier_body_guard() {
		let code = fixture("c.c");
		let r = outline(&code, "c.c");
		assert!(r.parsed);
		// `typedef struct Point {..} Point;` emits the struct ONCE — the typedef
		// wrapper is skipped because the inner specifier carries body + name.
		let points: Vec<&SymbolEntry> = r.symbols.iter().filter(|s| s.name == "Point").collect();
		assert_eq!(points.len(), 1, "typedef struct must not double-emit");
		assert_eq!(points[0].kind, "struct");
		// `typedef int Distance;` (no body-bearing specifier) still emits.
		assert_eq!(find(&r, "Distance").map(|s| s.kind.as_str()), Some("type_alias"));
		// The `enum Color c` parameter reference must NOT emit a second Color
		// (body-presence guard); only the top-level definition emits.
		let colors: Vec<&SymbolEntry> = r.symbols.iter().filter(|s| s.name == "Color").collect();
		assert_eq!(colors.len(), 1, "enum reference at a param site must not emit");
		assert_eq!(colors[0].kind, "enum");
		assert_eq!(colors[0].parent, -1, "the single Color is the top-level definition");
		assert_eq!(find(&r, "x").map(|s| s.kind.as_str()), Some("field"));
		assert_eq!(find(&r, "RED").map(|s| s.kind.as_str()), Some("enum_member"));
		assert_eq!(find(&r, "add").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "MAX_SIZE").map(|s| s.kind.as_str()), Some("macro"));
		// `static const int TIMEOUT` is a bare declaration — intentionally not mapped.
		assert!(find(&r, "TIMEOUT").is_none(), "C bare declarations are not emitted");
	}

	#[test]
	fn outlines_cpp_namespace_struct_method_template_function() {
		let code = fixture("cpp.cpp");
		let r = outline(&code, "cpp.cpp");
		assert!(r.parsed);
		assert_eq!(find(&r, "app").map(|s| s.kind.as_str()), Some("namespace"));
		assert_eq!(find(&r, "Vec").map(|s| s.kind.as_str()), Some("struct"));
		// A function inside a struct is refined to a method.
		assert_eq!(find(&r, "length").map(|s| s.kind.as_str()), Some("method"));
		assert_eq!(find(&r, "Counter").map(|s| s.kind.as_str()), Some("class"));
		// A template function in a namespace stays a function (namespace is not
		// a method container).
		assert_eq!(find(&r, "identity").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "main").map(|s| s.kind.as_str()), Some("function"));
		assert!(find(&r, "kLimit").is_none(), "C++ bare declarations are not emitted");
	}

	#[test]
	fn outlines_objc_property_and_ivar_via_wrapper_descent() {
		let code = fixture("objc.m");
		let r = outline(&code, "objc.m");
		assert!(r.parsed);
		// `@property (...) int count;` name resolves through
		// property_declaration -> struct_declaration -> struct_declarator.
		assert_eq!(find(&r, "count").map(|s| s.kind.as_str()), Some("property"));
		// `{ int _count; }` instance variable via the same wrapper descent.
		assert_eq!(find(&r, "_count").map(|s| s.kind.as_str()), Some("field"));
		// @interface + @implementation each emit the class (ObjC two-part model).
		let greeters = r
			.symbols
			.iter()
			.filter(|s| s.name == "Greeter" && s.kind == "class")
			.count();
		assert_eq!(greeters, 2, "interface + implementation each emit the class");
		assert_eq!(find(&r, "greet").map(|s| s.kind.as_str()), Some("method"));
		assert_eq!(find(&r, "Direction").map(|s| s.kind.as_str()), Some("enum"));
		assert_eq!(find(&r, "North").map(|s| s.kind.as_str()), Some("enum_member"));
		assert_eq!(find(&r, "main").map(|s| s.kind.as_str()), Some("function"));
	}

	#[test]
	fn outlines_r_function_constant_variable_nested() {
		let code = fixture("r.r");
		let r = outline(&code, "r.r");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("r"));
		assert_eq!(find(&r, "add").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "const_num").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, "const_str").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, "result").map(|s| s.kind.as_str()), Some("variable"));
		assert_eq!(find(&r, "nested_fn").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "arrow").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "cache").map(|s| s.kind.as_str()), Some("variable"));
		assert_eq!(find(&r, "cache2").map(|s| s.kind.as_str()), Some("variable"));
		assert_eq!(find(&r, "target").map(|s| s.kind.as_str()), Some("constant"));
		let nested_idx = idx_of(&r, "nested_fn", "function").expect("nested_fn idx");
		let inner = find(&r, "inner").expect("inner");
		assert_eq!(inner.kind, "function");
		assert_eq!(inner.parent, nested_idx as i32);
	}

	#[test]
	fn outlines_julia_module_function_struct_abstract_const() {
		let code = fixture("julia.jl");
		let r = outline(&code, "julia.jl");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("julia"));
		let module_idx = idx_of(&r, "Shapes", "module").expect("module idx");
		assert_eq!(r.symbols[module_idx].parent, -1);
		let area = find(&r, "area").expect("area");
		assert_eq!(area.kind, "function");
		assert_eq!(area.parent, module_idx as i32);
		let circle_idx = idx_of(&r, "Circle", "struct").expect("Circle idx");
		assert_eq!(r.symbols[circle_idx].parent, module_idx as i32);
		let point_idx = idx_of(&r, "Point", "struct").expect("Point idx");
		assert_eq!(r.symbols[point_idx].parent, module_idx as i32);
		let abstract_shape = find(&r, "AbstractShape").expect("AbstractShape");
		assert_eq!(abstract_shape.kind, "type_alias");
		assert_eq!(abstract_shape.parent, module_idx as i32);
		let pi_approx = find(&r, "PI_APPROX").expect("PI_APPROX");
		assert_eq!(pi_approx.kind, "constant");
		assert_eq!(pi_approx.parent, module_idx as i32);
	}

	#[test]
	fn outlines_zig_function_struct_enum_method_field_const() {
		let code = fixture("zig.zig");
		let r = outline(&code, "zig.zig");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("zig"));
		let std = find(&r, "std").expect("std");
		assert_eq!(std.kind, "constant");
		assert_eq!(std.parent, -1);
		let greet = find(&r, "greet").expect("greet");
		assert_eq!(greet.kind, "function");
		assert_eq!(greet.parent, -1);
		let circle_idx = idx_of(&r, "Circle", "struct").expect("Circle idx");
		let radius = find(&r, "radius").expect("radius");
		assert_eq!(radius.kind, "field");
		assert_eq!(radius.parent, circle_idx as i32);
		let area = find(&r, "area").expect("area");
		assert_eq!(area.kind, "method");
		assert_eq!(area.parent, circle_idx as i32);
		let color_idx = idx_of(&r, "Color", "enum").expect("Color idx");
		let red = find(&r, "red").expect("red");
		assert_eq!(red.kind, "enum_member");
		assert_eq!(red.parent, color_idx as i32);
		assert!(find(&r, "green").is_some());
		assert!(find(&r, "blue").is_some());
		let literal = find(&r, "LITERAL").expect("LITERAL");
		assert_eq!(literal.kind, "constant");
		assert_eq!(literal.parent, -1);
		let helper = find(&r, "helper").expect("helper");
		assert_eq!(helper.kind, "function");
		assert_eq!(helper.parent, -1);
	}

	#[test]
	fn outlines_haskell_module_function_data_type_class() {
		let code = fixture("haskell.hs");
		let r = outline(&code, "haskell.hs");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("haskell"));
		let module_idx = idx_of(&r, "Symbols", "module").expect("module");
		assert_eq!(r.symbols[module_idx].parent, -1);
		let factorials = r
			.symbols
			.iter()
			.filter(|s| s.name == "factorial" && s.kind == "function")
			.count();
		assert_eq!(factorials, 1, "factorial equations must coalesce");
		assert_eq!(find(&r, "pi").map(|s| s.kind.as_str()), Some("function"));
		let shape_idx = idx_of(&r, "Shape", "struct").expect("Shape");
		let circle = find(&r, "Circle").expect("Circle");
		assert_eq!(circle.kind, "enum_member");
		assert_eq!(circle.parent, shape_idx as i32);
		assert_eq!(find(&r, "Name").map(|s| s.kind.as_str()), Some("type_alias"));
		assert_eq!(find(&r, "Drawable").map(|s| s.kind.as_str()), Some("interface"));
		assert!(!r.symbols.iter().any(|s| s.name == "double"), "local binding must not emit");
	}

	#[test]
	fn outlines_ocaml_module_function_type_variant() {
		let code = fixture("ocaml.ml");
		let r = outline(&code, "ocaml.ml");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("ocaml"));
		let math_idx = idx_of(&r, "Math", "module").expect("Math");
		let pi = find(&r, "pi").expect("pi");
		assert_eq!(pi.kind, "constant");
		assert_eq!(pi.parent, math_idx as i32);
		let fact = find(&r, "factorial").expect("factorial");
		assert_eq!(fact.kind, "function");
		assert_eq!(fact.parent, math_idx as i32);
		assert!(!r.symbols.iter().any(|s| s.name == "local"), "nested local must not emit");
		let shape_idx = idx_of(&r, "shape", "type_alias").expect("shape");
		let circle = find(&r, "Circle").expect("Circle");
		assert_eq!(circle.kind, "enum_member");
		assert_eq!(circle.parent, shape_idx as i32);
		let fib = find(&r, "fib").expect("fib");
		assert_eq!(fib.kind, "function");
		assert_eq!(fib.parent, -1);
	}

	#[test]
	fn outlines_elixir_module_protocol_impl_macro_functions() {
		let code = fixture("elixir.ex");
		let r = outline(&code, "elixir.ex");
		assert!(r.parsed, "elixir fixture must parse");
		assert!(find(&r, "puts").is_none(), "ordinary calls must not emit");
		assert!(find(&r, "inspect").is_none(), "ordinary calls must not emit");
		let module_idx = idx_of(&r, "Math.Shapes", "module").expect("module");
		assert_eq!(r.symbols[module_idx].parent, -1);
		assert_eq!(find(&r, "Area").map(|s| s.kind.as_str()), Some("interface"));
		assert_eq!(find(&r, "twice").map(|s| s.kind.as_str()), Some("macro"));
		assert_eq!(find(&r, "private_helper").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "rectangle").map(|s| s.kind.as_str()), Some("function"));
		let rectangle = find(&r, "rectangle").expect("rectangle");
		assert_eq!(rectangle.parent, module_idx as i32);
	}

	#[test]
	fn outlines_erlang_module_record_macro_functions_coalesce_clauses() {
		let code = fixture("erlang.erl");
		let r = outline(&code, "erlang.erl");
		assert!(r.parsed, "erlang fixture must parse");
		assert_eq!(find(&r, "shapes").map(|s| s.kind.as_str()), Some("module"));
		assert_eq!(find(&r, "rectangle").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "PI").map(|s| s.kind.as_str()), Some("macro"));
		assert_eq!(find(&r, "area").map(|s| s.kind.as_str()), Some("function"));
		let perimeter_count = r
			.symbols
			.iter()
			.filter(|s| s.name == "perimeter" && s.kind == "function")
			.count();
		assert_eq!(perimeter_count, 1, "perimeter clauses must coalesce into one symbol");
		assert_eq!(find(&r, "internal_debug").map(|s| s.kind.as_str()), Some("function"));
		assert!(find(&r, "shape()").is_none(), "-type attribute must not emit");
	}

	#[test]
	fn outlines_clojure_ns_defn_macro_record_type_protocol() {
		let code = fixture("clojure.clj");
		let r = outline(&code, "clojure.clj");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("clojure"));
		assert_eq!(find(&r, "myapp.core").map(|s| s.kind.as_str()), Some("namespace"));
		assert_eq!(find(&r, "MAX-SIZE").map(|s| s.kind.as_str()), Some("variable"));
		assert_eq!(find(&r, "greet").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "helper").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "unless").map(|s| s.kind.as_str()), Some("macro"));
		assert_eq!(find(&r, "Person").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "Point").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "Drawable").map(|s| s.kind.as_str()), Some("interface"));
		assert!(find(&r, "draw").is_none(), "protocol method sig must not emit");
		assert!(find(&r, "println").is_none(), "bare call must not emit");
	}

	#[test]
	fn outlines_emacslisp_const_var_macro_struct_function_class() {
		let code = fixture("emacslisp.el");
		let r = outline(&code, "emacslisp.el");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("emacs-lisp"));
		assert_eq!(find(&r, "pi").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, "counter").map(|s| s.kind.as_str()), Some("variable"));
		assert_eq!(find(&r, "with-log").map(|s| s.kind.as_str()), Some("macro"));
		assert_eq!(find(&r, "employee").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "add").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "my-class").map(|s| s.kind.as_str()), Some("class"));
		assert!(find(&r, "some-call").is_none(), "bare call must not emit");
	}

	#[test]
	fn outlines_powershell_function_class_constructor_method_property_enum() {
		let code = fixture("powershell.ps1");
		let r = outline(&code, "powershell.ps1");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("powershell"));
		let func = find(&r, "Get-Greeting").expect("function");
		assert_eq!(func.kind, "function");
		assert_eq!(func.parent, -1);
		let class_idx = idx_of(&r, "Person", "class").expect("class Person");
		let ctor = r
			.symbols
			.iter()
			.find(|s| s.name == "Person" && s.kind == "constructor")
			.expect("constructor");
		assert_eq!(ctor.parent, class_idx as i32);
		let get_name = find(&r, "GetName").expect("method");
		assert_eq!(get_name.kind, "method");
		assert_eq!(get_name.parent, class_idx as i32);
		let name_prop = find(&r, "Name").expect("property");
		assert_eq!(name_prop.kind, "property");
		assert_eq!(name_prop.parent, class_idx as i32);
		let enum_idx = idx_of(&r, "Color", "enum").expect("enum");
		let red = find(&r, "Red").expect("enum member");
		assert_eq!(red.kind, "enum_member");
		assert_eq!(red.parent, enum_idx as i32);
		assert!(find(&r, "Version").is_none(), "top-level assignment must not emit");
	}

	#[test]
	fn outlines_graphql_types_interface_enum_scalar_union_directive() {
		let code = fixture("graphql.graphql");
		let r = outline(&code, "graphql.graphql");
		assert!(r.parsed);
		let person_idx = idx_of(&r, "Person", "struct").expect("Person");
		let id = find(&r, "id").expect("id field");
		assert_eq!(id.kind, "field");
		assert_eq!(id.parent, person_idx as i32);
		assert_eq!(find(&r, "Node").map(|s| s.kind.as_str()), Some("interface"));
		assert_eq!(find(&r, "Article").map(|s| s.kind.as_str()), Some("struct"));
		let status_idx = idx_of(&r, "Status", "enum").expect("Status");
		let active = find(&r, "ACTIVE").expect("ACTIVE");
		assert_eq!(active.kind, "enum_member");
		assert_eq!(active.parent, status_idx as i32);
		let members = r
			.symbols
			.iter()
			.filter(|s| s.kind == "enum_member" && s.parent == status_idx as i32)
			.count();
		assert_eq!(members, 2, "Status has exactly two enum members");
		assert_eq!(find(&r, "PersonInput").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "DateTime").map(|s| s.kind.as_str()), Some("type_alias"));
		assert_eq!(find(&r, "SearchResult").map(|s| s.kind.as_str()), Some("type_alias"));
		assert_eq!(find(&r, "deprecated").map(|s| s.kind.as_str()), Some("macro"));
	}

	#[test]
	fn outlines_proto_message_enum_service_rpc_fields() {
		let code = fixture("proto.proto");
		let r = outline(&code, "proto.proto");
		assert!(r.parsed);
		let person_idx = idx_of(&r, "Person", "struct").expect("Person");
		let name = find(&r, "name").expect("name field");
		assert_eq!(name.kind, "field");
		assert_eq!(name.parent, person_idx as i32);
		let status_idx = idx_of(&r, "Status", "enum").expect("Status");
		let unknown = find(&r, "UNKNOWN").expect("UNKNOWN");
		assert_eq!(unknown.kind, "enum_member");
		assert_eq!(unknown.parent, status_idx as i32);
		let greeter_idx = idx_of(&r, "Greeter", "interface").expect("Greeter");
		let say = find(&r, "SayHello").expect("SayHello");
		assert_eq!(say.kind, "method");
		assert_eq!(say.parent, greeter_idx as i32);
		assert_eq!(find(&r, "StreamGreetings").map(|s| s.kind.as_str()), Some("method"));
		assert_eq!(find(&r, "Address").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "HelloReply").map(|s| s.kind.as_str()), Some("struct"));
	}

	#[test]
	fn outlines_tlaplus_module_constants_variables_operators() {
		let code = fixture("tlaplus.tla");
		let r = outline(&code, "tlaplus.tla");
		assert!(r.parsed);
		let module_idx = idx_of(&r, "Counter", "module").expect("Counter module");
		assert_eq!(find(&r, "MaxCount").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, "counter").map(|s| s.kind.as_str()), Some("variable"));
		let init = find(&r, "Init").expect("Init");
		assert_eq!(init.kind, "function");
		assert_eq!(init.parent, module_idx as i32);
		assert_eq!(find(&r, "Increment").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "Spec").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "MaxVal").map(|s| s.kind.as_str()), Some("function"));
	}

	#[test]
	fn outlines_tlaplus_multi_name_constants_variables() {
		let code = "---- MODULE Multi ----\nCONSTANTS A, B, C\nVARIABLES x, y\nInit == x = 0\n====\n";
		let r = outline(code, "multi.tla");
		assert!(r.parsed);
		assert_eq!(
			r.symbols.iter().filter(|s| s.kind == "constant").count(),
			3,
			"CONSTANTS A, B, C -> 3 constants"
		);
		assert_eq!(
			r.symbols.iter().filter(|s| s.kind == "variable").count(),
			2,
			"VARIABLES x, y -> 2 variables"
		);
		assert_eq!(find(&r, "Init").map(|s| s.kind.as_str()), Some("function"));
	}

	#[test]
	fn outlines_sql_table_view_function_columns() {
		let code = fixture("sql.sql");
		let r = outline(&code, "sql.sql");
		assert!(r.parsed, "sql fixture must parse with no ERROR nodes");
		assert_eq!(r.language.as_deref(), Some("sql"));
		let table_idx = idx_of(&r, "users", "struct").expect("table users");
		assert_eq!(r.symbols[table_idx].parent, -1);
		let id = find(&r, "id").expect("column id");
		assert_eq!(id.kind, "field");
		assert_eq!(id.parent, table_idx as i32);
		let email = find(&r, "email").expect("column email");
		assert_eq!(email.kind, "field");
		assert_eq!(email.parent, table_idx as i32);
		assert_eq!(find(&r, "active_users").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "add").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "greet").map(|s| s.kind.as_str()), Some("function"));
		assert!(find(&r, "who").is_none(), "function parameter must not emit");
		assert_eq!(
			r.symbols.iter().filter(|s| s.name == "users").count(),
			1,
			"table reference in view must not duplicate the symbol"
		);
	}

	#[test]
	fn outlines_verilog_module_function_task() {
		let code = fixture("verilog.sv");
		let r = outline(&code, "verilog.sv");
		assert!(r.parsed, "verilog fixture must parse with no ERROR nodes");
		assert_eq!(r.language.as_deref(), Some("verilog"));
		let module_idx = idx_of(&r, "Adder", "module").expect("module Adder");
		assert_eq!(r.symbols[module_idx].parent, -1);
		let func = find(&r, "double").expect("function double");
		assert_eq!(func.kind, "function");
		assert_eq!(func.parent, module_idx as i32);
		let task = find(&r, "clear").expect("task clear");
		assert_eq!(task.kind, "function");
		assert_eq!(task.parent, module_idx as i32);
		assert!(find(&r, "a").is_none(), "module ports must not emit");
		assert!(find(&r, "carry").is_none(), "module nets must not emit");
	}

	#[test]
	fn outlines_hcl_block_and_top_level_attr() {
		let code = fixture("hcl.hcl");
		let r = outline(&code, "hcl.hcl");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("hcl"));
		let ver = find(&r, "terraform_required_version").expect("top-level attr");
		assert_eq!(ver.kind, "constant");
		assert_eq!(ver.parent, -1);
		assert_eq!(find(&r, "variable.instance_count").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "resource.aws_instance.web").map(|s| s.kind.as_str()), Some("struct"));
		assert_eq!(find(&r, "output.instance_ip").map(|s| s.kind.as_str()), Some("struct"));
		assert!(find(&r, "region").is_none(), "block-internal attr must not emit");
		assert!(find(&r, "ami").is_none(), "block-internal attr must not emit");
		assert!(
			r.symbols.iter().all(|s| matches!(s.kind.as_str(), "struct" | "constant")),
			"only blocks (struct) and file-scope attrs (constant) emit"
		);
	}

	#[test]
	fn outlines_nix_file_scope_bindings() {
		let code = fixture("nix.nix");
		let r = outline(&code, "nix.nix");
		assert!(r.parsed);
		assert_eq!(r.language.as_deref(), Some("nix"));
		assert_eq!(find(&r, "greeting").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, "mkShell").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "tools").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, "builder").map(|s| s.kind.as_str()), Some("function"));
		assert!(find(&r, "formatter").is_none(), "nested attrset binding must not emit");
		assert!(find(&r, "combined").is_none(), "nested attrset binding must not emit");
		assert!(
			r.symbols.iter().all(|s| matches!(s.kind.as_str(), "function" | "constant")),
			"only file-scope bindings (function/constant) emit"
		);
	}

	#[test]
	fn outlines_nix_attrset_body_bindings() {
		let code = "{ pkgs }:\n\n{\n  description = \"dev shell\";\n  formatter = pkgs.nixfmt;\n}";
		let r = outline(code, "flake.nix");
		assert!(r.parsed);
		assert_eq!(find(&r, "description").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, "formatter").map(|s| s.kind.as_str()), Some("constant"));
		let bare = "{\n  name = \"pkg\";\n  version = \"0.1.0\";\n}";
		let r2 = outline(bare, "module.nix");
		assert!(r2.parsed);
		assert_eq!(find(&r2, "name").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r2, "version").map(|s| s.kind.as_str()), Some("constant"));
	}
	#[test]
	fn outlines_dockerfile_named_stages() {
		let code = fixture("dockerfile.dockerfile");
		let r = outline(&code, "dockerfile.dockerfile");
		assert!(r.parsed, "dockerfile fixture must parse with no ERROR nodes");
		assert_eq!(r.language.as_deref(), Some("dockerfile"));
		assert_eq!(find(&r, "builder").map(|s| s.kind.as_str()), Some("namespace"));
		assert_eq!(find(&r, "runtime").map(|s| s.kind.as_str()), Some("namespace"));
		assert!(find(&r, "ubuntu").is_none(), "image name must not emit");
		assert!(
			r.symbols.iter().all(|s| s.kind == "namespace"),
			"only named build stages emit"
		);
	}

	#[test]
	fn outlines_cmake_function_and_macro() {
		let code = fixture("cmake.cmake");
		let r = outline(&code, "cmake.cmake");
		assert!(r.parsed, "cmake fixture must parse with no ERROR nodes");
		assert_eq!(r.language.as_deref(), Some("cmake"));
		assert_eq!(find(&r, "greet").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "warn").map(|s| s.kind.as_str()), Some("macro"));
		assert!(find(&r, "project").is_none(), "project() command must not emit");
		assert_eq!(
			r.symbols.iter().filter(|s| s.kind == "function").count(),
			1,
			"only the function_def emits a function"
		);
	}

	#[test]
	fn outlines_make_rules_and_variables() {
		let code = fixture("make.mk");
		let r = outline(&code, "make.mk");
		assert!(r.parsed, "make fixture must parse with no ERROR nodes");
		assert_eq!(r.language.as_deref(), Some("make"));
		assert_eq!(find(&r, "all").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "build").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "clean").map(|s| s.kind.as_str()), Some("function"));
		assert!(r.symbols.iter().all(|s| s.parent == -1), "make symbols are all top-level");
		assert_eq!(find(&r, "CC").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, "CFLAGS").map(|s| s.kind.as_str()), Some("constant"));
		assert_eq!(find(&r, ".PHONY").map(|s| s.kind.as_str()), Some("function"));
	}

	#[test]
	fn outlines_just_recipes_and_assignments() {
		let code = fixture("justfile");
		let r = outline(&code, "justfile");
		assert!(r.parsed, "just fixture must parse with no ERROR nodes");
		assert_eq!(r.language.as_deref(), Some("just"));
		assert_eq!(find(&r, "build").map(|s| s.kind.as_str()), Some("function"));
		assert_eq!(find(&r, "test").map(|s| s.kind.as_str()), Some("function"));
		let build = find(&r, "build").expect("build recipe");
		assert!(build.end_line > build.start_line, "recipe end_line covers the body");
		assert_eq!(find(&r, "name").map(|s| s.kind.as_str()), Some("constant"));
		assert!(find(&r, "shell").is_none(), "set directive must not emit");
	}

	/// Canonical (name-based) build-file paths resolve to the right language
	/// and are outline-supported — `SupportLang::from_path` handles them with
	/// no file extension, the real path users hit.
	#[test]
	fn build_file_canonical_names_resolve_and_are_supported() {
		for (path, canonical) in [
			("Dockerfile", "dockerfile"),
			("Containerfile", "dockerfile"),
			("Makefile", "make"),
			("GNUmakefile", "make"),
			("CMakeLists.txt", "cmake"),
			("justfile", "just"),
			("Justfile", "just"),
		] {
			let lang = resolve_language(None, Some(path))
				.unwrap_or_else(|| panic!("{path} must resolve to a language"));
			assert_eq!(lang.canonical_name(), canonical, "{path} resolves to {canonical}");
			assert!(
				outline_languages().contains(&lang),
				"{canonical} must be an outline language"
			);
		}
	}
	/// Every name advertised by `special_filenames()` (the discovery-glob name
	/// set) resolves to its language via `from_path` — narrowing it to
	/// non-dotfile names must never list a name `from_path` would not accept.
	#[test]
	fn special_filenames_resolve_to_their_language() {
		for &lang in SupportLang::all_langs() {
			for &name in lang.special_filenames() {
				let probe = match name.strip_suffix(".*") {
					Some(prefix) => format!("{prefix}.example"),
					None => name.to_string(),
				};
				assert_eq!(
					SupportLang::from_path(std::path::Path::new(&probe)),
					Some(lang),
					"special filename {probe:?} must resolve to {}",
					lang.canonical_name()
				);
			}
		}
	}
	/// Boundary lock: every `SupportLang` is EITHER an outline language OR an
	/// explicitly-excluded data/markup/component-wrapper format — never both,
	/// never neither. A newly added `SupportLang` variant fails this test until
	/// it is consciously classified.
	#[test]
	fn all_languages_are_classified_supported_or_excluded() {
		use SupportLang::*;
		// Data, markup, and component-wrapper formats with no addressable code
		// symbols (Astro/Svelte/Vue embed scripts the grammar does not expose as
		// a code AST). Every language with named definitions — including the
		// DSL/HDL/schema and build/task-file languages — is in outline_languages().
		const EXCLUDED: &[SupportLang] = &[
			Astro, Css, Diff, Html, Ini, Json, Markdown, Regex, Svelte, Toml, Vue, Xml, Yaml,
		];
		for &lang in SupportLang::all_langs() {
			let supported = outline_languages().contains(&lang);
			let excluded = EXCLUDED.contains(&lang);
			assert!(
				supported ^ excluded,
				"{} must be EITHER an outline language OR explicitly excluded (not both, not neither)",
				lang.canonical_name()
			);
		}
	}
}
