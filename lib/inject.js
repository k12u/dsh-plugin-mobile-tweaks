/**
 * Pure `index.html` patching for the mobile-tweaks plugin, plus the filesystem
 * readers that turn `styles/*.css` into one bundle.
 *
 * Everything here is deliberately free of Cordis so the transforms stay
 * unit-testable against a plain HTML string (see `test/inject.test.mjs`).
 * The plugin half (`lib/index.js`) only wires these functions to the
 * `webServer` service.
 *
 * @module dsh-plugin-mobile-tweaks/inject
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, derived from this module's own location. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** `id` of the injected `<style>` element; also the idempotency key. */
export const STYLE_TAG_ID = "dsh-mobile-tweaks";
/** Stylesheet directory used when the plugin config names none. */
export const DEFAULT_STYLES_DIR = join(PACKAGE_ROOT, "styles");
/** Exact public route that serves the same bytes as the injected style. */
export const DEFAULT_ROUTE = "/dsh-mobile-tweaks.css";
/** Viewport flags merged into the shell's existing viewport meta. */
export const DEFAULT_VIEWPORT = Object.freeze({ "viewport-fit": "cover" });
/** Viewport content used when the shell ships no viewport meta at all. */
export const FALLBACK_VIEWPORT_CONTENT = "width=device-width, initial-scale=1";

const STYLE_TAG_RE = new RegExp(
	`<style\\b[^>]*(?<![-\\w])id\\s*=\\s*(["'])${STYLE_TAG_ID}\\1[^>]*>[\\s\\S]*?</style>`,
	"i",
);
const VIEWPORT_META_RE = /<meta\b[^>]*\bname\s*=\s*(["'])viewport\1[^>]*>/i;
const CONTENT_ATTR_RE = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i;
const HEAD_END = "</head>";

/**
 * Resolve the stylesheet directory from plugin config.
 * @param {string | undefined} dir - absolute path, package-relative path, or `undefined`.
 * @returns {string} absolute directory path.
 */
export function resolveStylesDir(dir) {
	if (typeof dir !== "string" || dir === "") return DEFAULT_STYLES_DIR;
	return isAbsolute(dir) ? dir : resolve(PACKAGE_ROOT, dir);
}

/**
 * List the stylesheet files of one directory in load order.
 * Only regular `*.css` files count; the name order is the cascade order, so
 * numeric prefixes (`00-`, `90-`) are the intended way to order layers.
 * @param {string} dir - absolute directory path.
 * @returns {string[]} file names, sorted.
 */
export function listStyleFiles(dir) {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".css"))
		.map((entry) => entry.name)
		.sort();
}

/**
 * Refuse CSS that would close the injected `<style>` element early.
 * @param {string} css - concatenated stylesheet text.
 * @returns {string} the same text when safe.
 * @throws {Error} when the text contains `</style`.
 */
export function assertSafeCss(css) {
	const match = /<\/style/i.exec(css);
	if (match !== null) {
		const line = css.slice(0, match.index).split("\n").length;
		throw new Error(
			`styles contain "</style" at line ${line}; remove or escape it so the injected <style> element cannot be closed early`,
		);
	}
	return css;
}

/**
 * Read and concatenate every stylesheet of one directory.
 * Read fresh on each call so an edited file reaches the browser on the next
 * page load without a rebuild or a host restart.
 * @param {string} dir - absolute directory path.
 * @returns {{ dir: string, css: string, files: { name: string, bytes: number, mtimeMs: number }[] }}
 */
export function readStyleBundle(dir) {
	const names = listStyleFiles(dir);
	/** @type {{ name: string, bytes: number, mtimeMs: number }[]} */
	const files = [];
	/** @type {string[]} */
	const parts = [];
	for (const name of names) {
		const path = join(dir, name);
		const stat = statSync(path);
		const text = readFileSync(path, "utf8");
		files.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
		parts.push(`/* ==== ${name} ==== */\n${text.replace(/\s+$/, "")}\n`);
	}
	const css = assertSafeCss(parts.join("\n"));
	return { dir, css, files };
}

/**
 * Parse a viewport `content` value into ordered key/value tokens.
 * @param {string} content - e.g. `width=device-width, initial-scale=1`.
 * @returns {Map<string, string>} lower-cased keys in source order.
 */
export function parseViewportTokens(content) {
	/** @type {Map<string, string>} */
	const tokens = new Map();
	for (const raw of String(content).split(",")) {
		const token = raw.trim();
		if (token === "") continue;
		const at = token.indexOf("=");
		const key = (at < 0 ? token : token.slice(0, at)).trim().toLowerCase();
		if (key === "") continue;
		tokens.set(key, at < 0 ? "" : token.slice(at + 1).trim());
	}
	return tokens;
}

/**
 * Ensure the given flags are present in a viewport `content` value.
 * Existing tokens keep their order and values; only missing flags are added.
 * @param {string} content - existing content value.
 * @param {Record<string, string | number>} flags - flags to ensure.
 * @returns {string} merged content value.
 */
export function mergeViewportContent(content, flags) {
	const tokens = parseViewportTokens(content);
	for (const [key, value] of Object.entries(flags ?? {})) {
		const normalized = key.trim().toLowerCase();
		if (normalized === "" || tokens.has(normalized)) continue;
		tokens.set(normalized, String(value));
	}
	return [...tokens].map(([key, value]) => (value === "" ? key : `${key}=${value}`)).join(", ");
}

/**
 * Insert a fragment immediately before the closing `</head>` tag.
 * @param {string} html - document text.
 * @param {string} fragment - markup to insert (include its own newlines).
 * @returns {string} patched document.
 */
export function insertBeforeHeadEnd(html, fragment) {
	const at = html.toLowerCase().lastIndexOf(HEAD_END);
	if (at < 0) return `${html}${fragment}`;
	return `${html.slice(0, at)}${fragment}\n${html.slice(at)}`;
}

/**
 * Merge viewport flags into the document's viewport meta.
 * @param {string} html - document text.
 * @param {Record<string, string | number> | null | undefined} flags - flags to ensure; `null` disables the patch.
 * @returns {string} patched document.
 */
export function patchViewportMeta(html, flags) {
	if (flags === null || flags === undefined) return html;
	const match = VIEWPORT_META_RE.exec(html);
	if (match === null) {
		const content = mergeViewportContent(FALLBACK_VIEWPORT_CONTENT, flags);
		return insertBeforeHeadEnd(
			html,
			`\n<meta name="viewport" content="${escapeAttribute(content)}" />`,
		);
	}
	const tag = match[0];
	const contentMatch = CONTENT_ATTR_RE.exec(tag);
	if (contentMatch === null) return html;
	const merged = mergeViewportContent(contentMatch[2], flags);
	if (merged === contentMatch[2]) return html;
	const patched =
		tag.slice(0, contentMatch.index) +
		`content="${escapeAttribute(merged)}"` +
		tag.slice(contentMatch.index + contentMatch[0].length);
	return html.slice(0, match.index) + patched + html.slice(match.index + tag.length);
}

/**
 * Render the one `<style>` element this plugin owns.
 * @param {string} css - stylesheet text.
 * @param {{ files?: { name: string }[], problem?: string }} [meta] - inventory and degradation notice.
 * @returns {string} style element markup.
 */
export function renderStyleElement(css, meta = {}) {
	const files = meta.files ?? [];
	const inventory = files.length === 0 ? "(no style files)" : files.map((file) => file.name).join(", ");
	const problem = meta.problem === undefined ? "" : `\n/* PROBLEM: ${sanitizeComment(meta.problem)} */`;
	return (
		`<style id="${STYLE_TAG_ID}" data-dsh-mobile-tweaks="${files.length}">` +
		`\n/* dsh-plugin-mobile-tweaks: ${inventory} */${problem}\n${css}\n</style>`
	);
}

/**
 * Patch one served `index.html`: viewport meta, extra head markup, then the
 * owned `<style>` element last so it wins same-specificity cascade ties
 * against the shell's own stylesheets.
 * @param {string} html - raw index document.
 * @param {{
 *   css?: string,
 *   files?: { name: string }[],
 *   problem?: string,
 *   viewport?: Record<string, string | number> | null,
 *   headHtml?: string,
 * }} [options] - patch inputs.
 * @returns {string} patched document.
 */
export function patchIndexHtml(html, options = {}) {
	const {
		css = "",
		files = [],
		problem,
		viewport = DEFAULT_VIEWPORT,
		headHtml = "",
	} = options;
	let out = String(html);
	out = patchViewportMeta(out, viewport);
	if (headHtml !== "") out = insertBeforeHeadEnd(out, `\n${headHtml.trim()}`);
	if (css !== "" || problem !== undefined) {
		const element = renderStyleElement(css, problem === undefined ? { files } : { files, problem });
		// Replace our own previous element in place so re-rendering is byte-identical.
		out = STYLE_TAG_RE.test(out) ? out.replace(STYLE_TAG_RE, element) : insertBeforeHeadEnd(out, `\n${element}`);
	}
	return out;
}

/**
 * Escape a value for a double-quoted HTML attribute.
 * @param {string} value - raw value.
 * @returns {string} escaped value.
 */
export function escapeAttribute(value) {
	return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Neutralize text placed inside a CSS comment in an HTML `<style>` element.
 * @param {string} text - raw text.
 * @returns {string} text that cannot close the comment or the element.
 */
export function sanitizeComment(text) {
	return String(text).replace(/\*\//g, "*\\/").replace(/<\//g, "<\\/");
}
