/**
 * dsh-plugin-mobile-tweaks — browser half.
 *
 * This is the hand-written equivalent of a compiled `dsh.client` bundle: it
 * only registers a factory with the client module system, and the factory body
 * runs when the entry materializes. No build step is involved, so editing this
 * file and reloading the page is the whole loop.
 *
 * What it adds to the page:
 *   - `<html data-dsh-mt-pointer="coarse|fine">`, `data-dsh-mt-hover`,
 *     `data-dsh-mt-orientation`, `data-dsh-mobile-tweaks="runtime"` so CSS can
 *     target real input capabilities instead of guessing from width.
 *   - `--dsh-mt-viewport-height`, `--dsh-mt-keyboard-inset`,
 *     `--dsh-mt-viewport-offset-top` plus `data-dsh-mt-keyboard="open|closed"`,
 *     derived from `visualViewport`, so a layout patch can keep a composer
 *     above the soft keyboard.
 *   - a `dsh-mobile-tweaks:keyboard` CustomEvent on `<html>` on every change.
 *   - on narrow viewports, selecting a session collapses the sidebar so the
 *     conversation becomes visible without pressing the toggle afterwards.
 *
 * Extend it by adding a function to `patches`. A patch receives the shared
 * `api` and registers everything through it; cleanup is automatic when the
 * entry unloads or hot-reloads.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-mobile-tweaks",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Viewport shrink (px) above which the soft keyboard counts as open. */
		const DEFAULT_KEYBOARD_THRESHOLD = 120;

		/**
		 * Build the helper surface shared by every patch. Every helper that
		 * attaches something records its own cleanup, so a patch never has to
		 * track listeners by hand.
		 * @param {{ logger?: { warn?: (message: string) => void } }} ctx
		 * @param {{ keyboardThreshold?: number }} config
		 */
		function createApi(ctx, config) {
			const root = document.documentElement;
			/** @type {(() => void)[]} */
			const cleanups = [];
			const keyboardThreshold =
				typeof config.keyboardThreshold === "number" && config.keyboardThreshold >= 0
					? config.keyboardThreshold
					: DEFAULT_KEYBOARD_THRESHOLD;

			const api = {
				root,
				window,
				keyboardThreshold,
				/**
				 * Set or remove one attribute on `<html>`.
				 * @param {string} name
				 * @param {string | undefined} value
				 */
				setAttr(name, value) {
					if (value === undefined) root.removeAttribute(name);
					else if (root.getAttribute(name) !== value) root.setAttribute(name, value);
				},
				/** @param {string} name @param {string} value */
				setVar(name, value) {
					if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
				},
				/** @param {string} name */
				removeVar(name) {
					root.style.removeProperty(name);
				},
				/**
				 * Attach a listener and track its removal.
				 * @param {EventTarget} target
				 * @param {string} type
				 * @param {EventListenerOrEventListenerObject} handler
				 * @param {AddEventListenerOptions | boolean} [options]
				 */
				listen(target, type, handler, options) {
					target.addEventListener(type, handler, options);
					cleanups.push(() => target.removeEventListener(type, handler, options));
				},
				/**
				 * Run `onChange` now and whenever the media query flips.
				 * @param {string} query
				 * @param {(matches: boolean) => void} onChange
				 */
				watchMedia(query, onChange) {
					const mql = window.matchMedia(query);
					const handler = () => onChange(mql.matches);
					onChange(mql.matches);
					mql.addEventListener("change", handler);
					cleanups.push(() => mql.removeEventListener("change", handler));
				},
				/** @param {() => void} fn */
				onCleanup(fn) {
					cleanups.push(fn);
				},
				/**
				 * Run `setup` once the named Cordis services are available, inside an
				 * effect the plugin owns. The callback may return its own cleanup.
				 * @param {string[]} names
				 * @param {(scoped: any) => (() => void) | void} setup
				 */
				inject(names, setup) {
					const dispose = ctx.inject(names, (scoped) => {
						scoped.effect(() => setup(scoped), `mobile-tweaks: services ${names.join(", ")}`);
					});
					if (typeof dispose === "function") cleanups.push(dispose);
				},
				/** @param {string} type @param {unknown} detail */
				emit(type, detail) {
					root.dispatchEvent(new CustomEvent(`dsh-mobile-tweaks:${type}`, { detail }));
				},
				dispose() {
					for (const fn of cleanups.reverse()) {
						try {
							fn();
						} catch (error) {
							ctx.logger?.warn?.(`mobile-tweaks: cleanup failed: ${error}`);
						}
					}
					cleanups.length = 0;
				},
			};
			return api;
		}

		/**
		 * Input capabilities as attributes, so CSS keys off the real pointer
		 * instead of a width threshold.
		 * @param {ReturnType<typeof createApi>} api
		 */
		function pointerPatch(api) {
			api.setAttr("data-dsh-mobile-tweaks", "runtime");
			api.watchMedia("(pointer: coarse)", (coarse) => api.setAttr("data-dsh-mt-pointer", coarse ? "coarse" : "fine"));
			api.watchMedia("(hover: hover)", (hover) => api.setAttr("data-dsh-mt-hover", hover ? "hover" : "none"));
			api.watchMedia("(orientation: portrait)", (portrait) =>
				api.setAttr("data-dsh-mt-orientation", portrait ? "portrait" : "landscape"),
			);
		}

		/**
		 * Publish the visual viewport and the soft-keyboard inset. Layout work
		 * stays in CSS; this patch only measures.
		 * @param {ReturnType<typeof createApi>} api
		 */
		function viewportPatch(api) {
			const visualViewport = window.visualViewport;
			let lastOpen;
			let frame = 0;

			const publish = () => {
				frame = 0;
				const layoutHeight = window.innerHeight;
				if (visualViewport === undefined || visualViewport === null) {
					api.setVar("--dsh-mt-viewport-height", `${Math.round(layoutHeight)}px`);
					api.setAttr("data-dsh-mt-keyboard", "unknown");
					return;
				}
				const inset = Math.max(0, Math.round(layoutHeight - visualViewport.height - visualViewport.offsetTop));
				api.setVar("--dsh-mt-viewport-height", `${Math.round(visualViewport.height)}px`);
				api.setVar("--dsh-mt-keyboard-inset", `${inset}px`);
				api.setVar("--dsh-mt-viewport-offset-top", `${Math.round(visualViewport.offsetTop)}px`);
				const open = inset > api.keyboardThreshold;
				api.setAttr("data-dsh-mt-keyboard", open ? "open" : "closed");
				if (open !== lastOpen) {
					lastOpen = open;
					api.emit("keyboard", { open, inset });
				}
			};

			const schedule = () => {
				if (frame !== 0) return;
				frame = requestAnimationFrame(publish);
			};

			publish();
			api.onCleanup(() => {
				if (frame !== 0) cancelAnimationFrame(frame);
			});
			api.listen(window, "resize", schedule, { passive: true });
			api.listen(window, "orientationchange", schedule, { passive: true });
			if (visualViewport !== undefined && visualViewport !== null) {
				api.listen(visualViewport, "resize", schedule, { passive: true });
				api.listen(visualViewport, "scroll", schedule, { passive: true });
			}
		}

		/**
		 * Decide whether a selection change should collapse the sidebar.
		 * Pure so the rule stays unit-testable (see test/client.test.mjs).
		 * @param {string | undefined} previousId
		 * @param {string | undefined} nextId
		 * @param {boolean} narrow
		 * @param {boolean} collapsed
		 * @returns {boolean} true when the sidebar should be toggled shut.
		 */
		function shouldAutoCollapse(previousId, nextId, narrow, collapsed) {
			if (nextId === previousId) return false;
			if (!narrow) return false;
			if (collapsed) return false;
			return true;
		}

		/**
		 * On a narrow viewport the left column and the conversation cannot share
		 * the screen: an expanded sidebar squeezes the center to a sliver. So
		 * selecting a session also collapses the sidebar, which makes the click
		 * itself switch to the conversation instead of requiring the toggle after.
		 *
		 * Owners: `ctx.layout.toggleSidebar()` (ui-layout) and
		 * `ctx.uiWorkspace.selection` (the snapshot store `replaceMain()` writes on
		 * every navigation: session list clicks, workspace connects, drills).
		 * @param {ReturnType<typeof createApi>} api
		 */
		function sidebarPatch(api) {
			/** The breakpoint the layout store uses for its `narrowExpanded` override. */
			const NARROW = "(max-width: 1023px)";
			const isNarrow = () => window.matchMedia(NARROW).matches;
			/** AppFrame renders `data-sidebar-collapsed` only while the column is collapsed. */
			const isCollapsed = () => document.querySelector("[data-sidebar-collapsed]") !== null;

			api.inject(["layout", "uiWorkspace"], (scoped) => {
				const selection = scoped.uiWorkspace?.selection;
				if (selection === undefined || typeof selection.subscribe !== "function") return;
				let last = selection.getSnapshot()?.sessionId;
				const off = selection.subscribe(() => {
					const next = selection.getSnapshot()?.sessionId;
					if (!shouldAutoCollapse(last, next, isNarrow(), isCollapsed())) {
						last = next;
						return;
					}
					last = next;
					scoped.layout.toggleSidebar();
					api.emit("sidebar-auto-collapsed", { sessionId: next });
				});
				return () => {
					if (typeof off === "function") off();
				};
			});
		}

		/** Every behavior patch, in load order. Add new ones here. */
		const patches = [
			{ id: "pointer", apply: pointerPatch },
			{ id: "viewport", apply: viewportPatch },
			{ id: "sidebar", apply: sidebarPatch },
		];

		/** Cordis services this browser half needs; it only touches the DOM. */
		const inject = [];

		/**
		 * @param {import("@deepseek-ai/cordis").Context} ctx
		 * @param {{ behavior?: boolean, keyboardThreshold?: number }} [config]
		 */
		function apply(ctx, config = {}) {
			if (config.behavior === false) return;
			if (typeof document === "undefined" || typeof window === "undefined") return;

			const api = createApi(ctx, config);
			globalThis.__dshMobileTweaks = {
				version: "0.1.0",
				patches: patches.map((patch) => patch.id),
				api,
			};

			ctx.effect(() => {
				for (const patch of patches) {
					try {
						patch.apply(api);
					} catch (error) {
						ctx.logger?.warn?.(`mobile-tweaks: patch ${patch.id} failed: ${error}`);
					}
				}
				return () => {
					api.dispose();
					delete globalThis.__dshMobileTweaks;
				};
			}, "mobile-tweaks: DOM behavior patches");
		}

		exports.apply = apply;
		exports.inject = inject;
		/** Exported for the bundle-contract tests; not part of the plugin API. */
		exports.shouldAutoCollapse = shouldAutoCollapse;
		return module.exports;
	},
});
