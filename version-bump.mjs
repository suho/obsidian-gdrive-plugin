import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
	throw new Error("npm_package_version is not set");
}

// Read minAppVersion from manifest.json and bump both manifest files.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

try {
	const betaManifest = JSON.parse(readFileSync("manifest-beta.json", "utf8"));
	betaManifest.version = targetVersion;
	betaManifest.minAppVersion = minAppVersion;
	writeFileSync("manifest-beta.json", JSON.stringify(betaManifest, null, "\t"));
} catch {
	// manifest-beta.json is optional.
}

// update versions.json with target version and minAppVersion from manifest.json
// (or correct it if the entry exists with a different minAppVersion)
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (versions[targetVersion] !== minAppVersion) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}
