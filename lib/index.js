/**
 * dsh-plugin-mobile-tweaks — host half.
 *
 * A maintainable monkey patch for the Web GUI shell. It owns exactly two
 * contributions to the running host:
 *
 * 1. an `index.html` tap that appends one `<style id="dsh-mobile-tweaks">`
 *    element (and optional head markup) to every served index, and
 * 2. an optional public route that serves the same stylesheet bytes.
 *
 * The style sources are plain `styles/*.css` files, read at index-render time.
 * Editing them therefore needs only a browser reload: no rebuild, no host
 * restart, no edit to any installed `@deepseek-ai/*` file.
 *
 * @module dsh-plugin-mobile-tweaks
 */
import {
	DEFAULT_ROUTE,
	DEFAULT_VIEWPORT,
	patchIndexHtml,
	readStyleBundle,
	resolveStylesDir,
} from "./inject.js";

/** Loader entry id used by `cordis.patch.yml` and diagnostics. */
export const name = "mobile-tweaks";
/** Cordis services this plugin needs before `apply` runs. */
export const inject = ["webServer"];

/**
 * Normalize plugin config. Every key is optional; unknown keys are ignored so
 * a patch entry stays valid across plugin versions.
 * @param {Record<string, any> | undefined} config - loader entry config.
 */
function resolveSettings(config) {
	const raw = config ?? {};
	return {
		stylesDir: resolveStylesDir(typeof raw.stylesDir === "string" ? raw.stylesDir : undefined),
		route:
			raw.route === false
				? null
				: typeof raw.route === "string" && raw.route !== ""
					? raw.route
					: DEFAULT_ROUTE,
		viewport: raw.viewport === false ? null : (raw.viewport ?? DEFAULT_VIEWPORT),
		headHtml: typeof raw.headHtml === "string" ? raw.headHtml : "",
	};
}

/**
 * Read the configured stylesheet bundle, degrading to an empty bundle with a
 * notice instead of breaking index rendering — a broken stylesheet must never
 * take the GUI down.
 * @param {string} stylesDir - absolute stylesheet directory.
 */
function loadBundle(stylesDir) {
	try {
		return readStyleBundle(stylesDir);
	} catch (error) {
		return {
			dir: stylesDir,
			css: "",
			files: [],
			problem: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Send one plain-text response.
 * @param {import("node:http").ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {string} type - content type.
 * @param {string} body - response text.
 * @param {Record<string, string>} [headers] - extra headers.
 */
function sendText(res, status, type, body, headers = {}) {
	res.writeHead(status, {
		"content-type": type,
		"content-length": String(Buffer.byteLength(body)),
		"cache-control": "no-store",
		...headers,
	});
	res.end(body);
}

/**
 * Mount the index tap and the stylesheet route for this profile.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context carrying `webServer`.
 * @param {Record<string, any>} [config] - loader entry config.
 */
export function apply(ctx, config = {}) {
	const settings = resolveSettings(config);
	/** @type {string | undefined} last reported problem, so it logs once per change. */
	let lastProblem;

	const bundleNow = () => {
		const bundle = loadBundle(settings.stylesDir);
		if (bundle.problem !== undefined && bundle.problem !== lastProblem) {
			lastProblem = bundle.problem;
			try {
				ctx.logger.warn(`mobile-tweaks: ${bundle.problem}`);
			} catch {
				// Logging must never break rendering.
			}
		}
		return bundle;
	};

	ctx.effect(() => {
		const disposeTap = ctx.webServer.tapIndex((html) => {
			const bundle = bundleNow();
			return patchIndexHtml(html, {
				css: bundle.css,
				files: bundle.files,
				...(bundle.problem === undefined ? {} : { problem: bundle.problem }),
				viewport: settings.viewport,
				headHtml: settings.headHtml,
			});
		});

		const disposeRoute =
			settings.route === null
				? () => {}
				: ctx.webServer.register({
						kind: "exact",
						path: settings.route,
						handler: (req, res) => {
							if (req.method !== "GET" && req.method !== "HEAD") {
								res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" });
								res.end();
								return;
							}
							const bundle = bundleNow();
							if (bundle.problem !== undefined) {
								sendText(
									res,
									500,
									"text/plain; charset=utf-8",
									`dsh-plugin-mobile-tweaks: ${bundle.problem}\n`,
								);
								return;
							}
							const headers = {
								"x-dsh-mobile-tweaks-files": bundle.files.map((file) => file.name).join(","),
							};
							if (req.method === "HEAD") {
								res.writeHead(200, {
									"content-type": "text/css; charset=utf-8",
									"content-length": String(Buffer.byteLength(bundle.css)),
									...headers,
								});
								res.end();
								return;
							}
							sendText(res, 200, "text/css; charset=utf-8", bundle.css, headers);
						},
					});

		return () => {
			disposeRoute();
			disposeTap();
		};
	}, "mobile-tweaks: patch the served index and serve the stylesheet");
}
