/**
 * Shared profile-wiring helpers for the mobile-tweaks scripts.
 * Kept dependency-free: these scripts must run with the system Node only.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of this package. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Package name the profile links and the loader entry names. */
export const PACKAGE_NAME = "dsh-plugin-mobile-tweaks";
/** Loader entry id written into `cordis.patch.yml`. */
export const ENTRY_ID = "mobile-tweaks";
/** Profile patch layer file. */
export const PATCH_FILE = "cordis.patch.yml";
/** Start marker of the managed block. */
export const BEGIN = `# >>> ${PACKAGE_NAME} (managed by scripts/install.mjs) >>>`;
/** End marker of the managed block. */
export const END = `# <<< ${PACKAGE_NAME} <<<`;
/** The managed block itself. */
export const BLOCK = `${BEGIN}
- insert:
    - id: ${ENTRY_ID}
      name: ${PACKAGE_NAME}
${END}
`;

/**
 * Resolve the profile directory from flags and environment.
 * @param {{ profileDir?: string, dshHome?: string, profile?: string }} options - parsed flags.
 * @returns {string} absolute profile directory.
 */
export function resolveProfileDir(options) {
	if (options.profileDir !== undefined) return resolve(options.profileDir);
	if (process.env.DSH_PROFILE_DIR) return resolve(process.env.DSH_PROFILE_DIR);
	const home = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return resolve(home, "profiles", options.profile ?? "web");
}

/**
 * Derive `$DSH_HOME` from a `<home>/profiles/<name>` layout.
 * @param {string} profileDir - absolute profile directory.
 * @returns {string} the DSH home directory the profile belongs to.
 */
export function dshHomeOf(profileDir) {
	return dirname(dirname(profileDir));
}

/**
 * Read the profile's patch file, or an empty body when it does not exist yet.
 * @param {string} path - absolute patch file path.
 * @returns {string} file body.
 */
export function readPatch(path) {
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * Replace or append the managed block.
 * @param {string} body - current patch file body.
 * @returns {string} updated body.
 */
export function upsertBlock(body) {
	const begin = body.indexOf(BEGIN);
	if (begin >= 0) {
		const end = body.indexOf(END, begin);
		if (end < 0) throw new Error(`${PATCH_FILE}: managed block starts but never ends`);
		return `${body.slice(0, begin)}${BLOCK.trimEnd()}${body.slice(end + END.length)}`;
	}
	if (body.includes(PACKAGE_NAME)) {
		throw new Error(`${PATCH_FILE}: ${PACKAGE_NAME} appears without the managed markers; edit that entry by hand`);
	}
	const head = body.trimEnd();
	return `${head === "" ? "" : `${head}\n\n`}${BLOCK}`;
}

/**
 * Remove the managed block.
 * @param {string} body - current patch file body.
 * @returns {{ body: string, removed: boolean }} updated body and whether anything changed.
 */
export function stripBlock(body) {
	const begin = body.indexOf(BEGIN);
	if (begin < 0) return { body, removed: false };
	const end = body.indexOf(END, begin);
	if (end < 0) throw new Error(`${PATCH_FILE}: managed block starts but never ends`);
	let after = end + END.length;
	while (body[after] === "\n") after += 1;
	const before = body.slice(0, begin).replace(/\n+$/, "\n");
	return { body: `${before}${body.slice(after)}`.replace(/\n{3,}/g, "\n\n"), removed: true };
}

/**
 * Resolve the profile's dependency entry to a real path, when installed.
 * @param {string} profileDir - absolute profile directory.
 * @returns {string | undefined} real path of the linked package.
 */
export function linkedPath(profileDir) {
	const path = join(profileDir, "node_modules", PACKAGE_NAME);
	if (!existsSync(path)) return undefined;
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Collect the wiring status of one profile.
 * @param {string} profileDir - absolute profile directory.
 * @returns {{ profileDir: string, manifestSpec?: string, linked?: string, linkedIsThisPackage?: boolean, patchPath: string, patchEntry: boolean, managedBlock: boolean }}
 */
export function statusFor(profileDir) {
	const manifestPath = join(profileDir, "package.json");
	const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
	const patchPath = join(profileDir, PATCH_FILE);
	const patch = readPatch(patchPath);
	const linked = linkedPath(profileDir);
	return {
		profileDir,
		manifestSpec: manifest.dependencies?.[PACKAGE_NAME],
		linked,
		linkedIsThisPackage: linked !== undefined && resolve(linked) === resolve(PACKAGE_ROOT),
		patchPath,
		patchEntry: patch.includes(PACKAGE_NAME),
		managedBlock: patch.includes(BEGIN),
	};
}
