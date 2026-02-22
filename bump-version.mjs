import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function assertSemver(version, label) {
	if (!SEMVER_RE.test(version)) {
		throw new Error(`${label} must be in x.y.z format. Received: ${version}`);
	}
}

function bumpMinor(version) {
	const [major, minor] = version.split('.').map(Number);
	return `${major}.${minor + 1}.0`;
}

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
	writeFileSync(filePath, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

function main() {
	const [, , inputVersion, ...restArgs] = process.argv;
	if (restArgs.length > 0) {
		throw new Error('Usage: node bump-version.mjs [x.y.z]');
	}
	if (inputVersion) {
		assertSemver(inputVersion, 'Target version');
	}

	const cwd = process.cwd();
	const files = [
		{ label: 'package.json', path: path.join(cwd, 'package.json') },
		{ label: 'manifest.json', path: path.join(cwd, 'manifest.json') },
		{ label: 'manifest-beta.json', path: path.join(cwd, 'manifest-beta.json') },
	];

	for (const file of files) {
		if (!existsSync(file.path)) {
			throw new Error(`Missing required file: ${file.label}`);
		}
	}

	const docs = files.map((file) => ({
		...file,
		json: readJson(file.path),
	}));

	for (const doc of docs) {
		assertSemver(String(doc.json.version ?? ''), `${doc.label} version`);
	}

	const currentVersion = String(docs[0].json.version);
	const mismatched = docs.filter((doc) => String(doc.json.version) !== currentVersion);
	if (mismatched.length > 0) {
		const details = docs.map((doc) => `${doc.label}=${String(doc.json.version)}`).join(', ');
		throw new Error(`Version mismatch across files. Resolve manually first: ${details}`);
	}

	const nextVersion = inputVersion ?? bumpMinor(currentVersion);

	if (nextVersion === currentVersion) {
		console.log(`No change: all files already at ${currentVersion}`);
		return;
	}

	for (const doc of docs) {
		doc.json.version = nextVersion;
		writeJson(doc.path, doc.json);
	}

	console.log(`Updated version: ${currentVersion} -> ${nextVersion}`);
	for (const doc of docs) {
		console.log(`- ${doc.label}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
