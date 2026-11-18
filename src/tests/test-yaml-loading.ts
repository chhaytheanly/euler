import { PROVIDER_CATALOG, getCatalogEntry } from '../configs/catalog';

console.log("Testing YAML loading...");
console.log("OpenRouter entry from catalog:");
console.log(JSON.stringify(getCatalogEntry('openrouter'), null, 2));
console.log("\nFull catalog keys:", Object.keys(PROVIDER_CATALOG));
