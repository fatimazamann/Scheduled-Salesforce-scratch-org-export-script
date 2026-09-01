const fs = require('fs');
const path = require('path');

const folderPath = process.argv[2];
const propsArg = process.argv[3];

if (!folderPath || !propsArg) {
	console.error('Usage: node clean-json.js <folderPath> <prop1,prop2,...>');
	process.exit(1);
}

const keysToRemove = new Set(
	propsArg
		.split(',')
		.map((k) => k.trim())
		.filter(Boolean)
);

function removeKeysDeep(value) {
	if (Array.isArray(value)) {
		value.forEach(removeKeysDeep);
		return;
	}

	if (value && typeof value === 'object') {
		for (const key of Object.keys(value)) {
			if (keysToRemove.has(key)) {
				delete value[key];
			} else {
				removeKeysDeep(value[key]);
			}
		}
	}
}

// Process all JSON files
fs.readdirSync(folderPath)
	.filter((file) => file.endsWith('.json'))
	.forEach((file) => {
		const filePath = path.join(folderPath, file);
		const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

		removeKeysDeep(data);

		fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
		console.log(`✔ Cleaned ${file}`);
	});
