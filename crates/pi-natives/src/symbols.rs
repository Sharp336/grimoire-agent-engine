//! Flat tree-sitter symbol outlines powered by [`pi_ast::symbols`].

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
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

#[napi(object)]
pub struct SymbolEntry {
	/// Identifier text of the symbol.
	pub name:           String,
	/// Domain kind string (e.g. "function", "method", "class"); stable wire
	/// value mapped to an LSP `SymbolKind` by the TS layer.
	pub kind:           String,
	/// 1-based first line of the construct, INCLUDING attached
	/// decorators/attributes/annotations.
	pub start_line:     u32,
	/// 1-based last content line of the declaration.
	pub end_line:       u32,
	/// 1-based line of the name identifier (display/navigation anchor).
	pub selection_line: u32,
	/// One-line signature: trimmed source slice from the node's start byte to
	/// the body's start byte; falls back to the first source line.
	pub detail:         Option<String>,
	/// Logical container for symbols whose real container is NOT an emitted
	/// parent symbol (Rust associated items inside an `impl_item`, Go
	/// `method_declaration` receivers). `None` elsewhere.
	pub container:      Option<String>,
	/// 0 = file top level.
	pub depth:          u32,
	/// Index into the flat symbol list, `-1` for top level.
	pub parent:         i32,
}

#[napi(object)]
pub struct OutlineResult {
	/// Canonical language name when parsing succeeded.
	pub language: Option<String>,
	/// True when tree-sitter parsed the source without syntax errors.
	pub parsed:   bool,
	/// Named declarations in depth-first pre-order (container before children).
	pub symbols:  Vec<SymbolEntry>,
}

impl From<pi_ast::symbols::SymbolEntry> for SymbolEntry {
	fn from(value: pi_ast::symbols::SymbolEntry) -> Self {
		Self {
			name:           value.name,
			kind:           value.kind,
			start_line:     value.start_line,
			end_line:       value.end_line,
			selection_line: value.selection_line,
			detail:         value.detail,
			container:      value.container,
			depth:          value.depth,
			parent:         value.parent,
		}
	}
}

impl From<pi_ast::symbols::OutlineResult> for OutlineResult {
	fn from(value: pi_ast::symbols::OutlineResult) -> Self {
		Self {
			language: value.language,
			parsed:   value.parsed,
			symbols:  value.symbols.into_iter().map(Into::into).collect(),
		}
	}
}

#[napi]
pub fn outline_code(options: OutlineOptions) -> Result<OutlineResult> {
	pi_ast::symbols::outline_code(pi_ast::symbols::OutlineOptions {
		code:      options.code,
		lang:      options.lang,
		path:      options.path,
		max_depth: options.max_depth,
	})
	.map(Into::into)
	.map_err(|error| Error::from_reason(error.to_string()))
}

#[napi(object)]
pub struct OutlineLanguage {
	/// Canonical language name (e.g. "rust", "typescript").
	pub name:       String,
	/// File extensions (without the leading dot) that resolve to this language.
	pub extensions: Vec<String>,
	/// Non-dotfile fixed-name files that resolve to this language (e.g.
	/// "Dockerfile", "Makefile", "CMakeLists.txt"); a trailing `.*` is a name
	/// glob. Lets the TS scan glob discover extensionless build files.
	pub filenames:  Vec<String>,
}

/// The languages [`outline_code`] emits symbols for, with their file
/// extensions and fixed-name files. The `symbol` TS tool derives its
/// supported-file scan glob from this so the Rust extractor and the TS filter
/// never drift.
#[napi]
pub fn outline_languages() -> Vec<OutlineLanguage> {
	pi_ast::symbols::outline_languages()
		.iter()
		.map(|&lang| OutlineLanguage {
			name:       lang.canonical_name().to_string(),
			extensions: lang.file_extensions().iter().map(|&e| e.to_string()).collect(),
			filenames:  lang.special_filenames().iter().map(|&f| f.to_string()).collect(),
		})
		.collect()
}

/// True when the outline extractor emits symbols for the language `path`
/// resolves to (by extension AND special-name rules, e.g. shell rc files).
/// The `symbol` TS tool uses this for per-file gating so extensionless
/// supported files are not rejected by a bare extension check.
#[napi]
pub fn is_outline_supported_path(path: String) -> bool {
	pi_ast::SupportLang::from_path(std::path::Path::new(&path))
		.map(|lang| pi_ast::symbols::outline_languages().contains(&lang))
		.unwrap_or(false)
}
