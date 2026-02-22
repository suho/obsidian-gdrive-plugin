import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function assertSemver(version, label) {
	if (!SEMVER_RE.test(version)) {
		throw new Error(`${label} must be a semantic version in x.y.z format. Received: ${version}`);
	}
}

function parseSemver(version) {
	const [major, minor, patch] = version.split('.').map(Number);
	return { major, minor, patch };
}

function compareSemver(a, b) {
	const av = parseSemver(a);
	const bv = parseSemver(b);
	if (av.major !== bv.major) return av.major - bv.major;
	if (av.minor !== bv.minor) return av.minor - bv.minor;
	return av.patch - bv.patch;
}

function parseCliArgs(argv) {
	const extraVersions = new Set();
	let minAppOverride = null;
	let rangeStart = null;
	let rangeEnd = null;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--min-app') {
			const value = argv[i + 1];
			if (!value) {
				throw new Error('Missing value for --min-app');
			}
			assertSemver(value, '--min-app');
			minAppOverride = value;
			i += 1;
			continue;
		}
		if (arg === '--from') {
			const value = argv[i + 1];
			if (!value) {
				throw new Error('Missing value for --from');
			}
			assertSemver(value, '--from');
			rangeStart = value;
			i += 1;
			continue;
		}
		if (arg === '--to') {
			const value = argv[i + 1];
			if (!value) {
				throw new Error('Missing value for --to');
			}
			assertSemver(value, '--to');
			rangeEnd = value;
			i += 1;
			continue;
		}
		if (arg.startsWith('--')) {
			throw new Error(`Unknown option: ${arg}`);
		}
		for (const token of arg.split(',')) {
			const trimmed = token.trim();
			if (!trimmed) continue;
			assertSemver(trimmed, 'Extra version');
			extraVersions.add(trimmed);
		}
	}

	if ((rangeStart && !rangeEnd) || (!rangeStart && rangeEnd)) {
		throw new Error('Both --from and --to are required when adding a range');
	}

	if (rangeStart && rangeEnd) {
		const from = parseSemver(rangeStart);
		const to = parseSemver(rangeEnd);
		if (from.major !== to.major || from.minor !== to.minor) {
			throw new Error('Range support currently requires matching major and minor versions');
		}
		if (from.patch > to.patch) {
			throw new Error('--from patch version must be <= --to patch version');
		}
		for (let patch = from.patch; patch <= to.patch; patch += 1) {
			extraVersions.add(`${from.major}.${from.minor}.${patch}`);
		}
	}

	return { minAppOverride, extraVersions };
}

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, 'utf8'));
}

function main() {
	const cwd = process.cwd();
	const manifestPath = path.join(cwd, 'manifest.json');
	const packagePath = path.join(cwd, 'package.json');
	const betaManifestPath = path.join(cwd, 'manifest-beta.json');
	const versionsPath = path.join(cwd, 'versions.json');

	const manifest = readJson(manifestPath);
	const pkg = readJson(packagePath);
	const betaManifest = existsSync(betaManifestPath) ? readJson(betaManifestPath) : null;
	const { minAppOverride, extraVersions } = parseCliArgs(process.argv.slice(2));

	assertSemver(manifest.version, 'manifest.json version');
	assertSemver(manifest.minAppVersion, 'manifest.json minAppVersion');

	if (pkg.version !== manifest.version) {
		console.warn(`Warning: package.json version (${pkg.version}) differs from manifest.json (${manifest.version})`);
	}

	if (betaManifest && betaManifest.version !== manifest.version) {
		console.warn(
			`Warning: manifest-beta.json version (${betaManifest.version}) differs from manifest.json (${manifest.version})`
		);
	}

	const minAppVersion = minAppOverride ?? manifest.minAppVersion;
	assertSemver(minAppVersion, 'target min app version');

	const incomingVersions = new Set([manifest.version, ...extraVersions]);
	const existingMap = existsSync(versionsPath) ? readJson(versionsPath) : {};

	const touched = [];
	for (const pluginVersion of incomingVersions) {
		assertSemver(pluginVersion, 'Plugin version');
		const previous = existingMap[pluginVersion];
		existingMap[pluginVersion] = minAppVersion;
		if (previous === undefined) {
			touched.push(`added ${pluginVersion} -> ${minAppVersion}`);
		} else if (previous !== minAppVersion) {
			touched.push(`updated ${pluginVersion}: ${previous} -> ${minAppVersion}`);
		}
	}

	const sortedEntries = Object.entries(existingMap).sort(([a], [b]) => compareSemver(a, b));
	const sortedMap = Object.fromEntries(sortedEntries);
	writeFileSync(versionsPath, `${JSON.stringify(sortedMap, null, '\t')}\n`, 'utf8');

	if (touched.length === 0) {
		console.log(`versions.json already up to date for ${[...incomingVersions].sort(compareSemver).join(', ')}`);
		return;
	}

	console.log(`Updated versions.json with ${touched.length} change(s):`);
	for (const line of touched) {
		console.log(`- ${line}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
