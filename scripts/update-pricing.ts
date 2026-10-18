// CLI wrapper over lib/models/refresh.ts that refreshes the vendored seed prices production boots on.
// Fails if any offered model is left without a rate.
import { writeFileSync } from "fs";
import path from "path";
import { buildCatalog } from "../lib/models/refresh";

// Must stay in step with the `import seed from "./model-pricing.json"` in lib/models/pricing.ts:
// writing anywhere else leaves the app on the old rates while this script reports success.
const OUT = path.join(__dirname, "..", "lib", "models", "model-pricing.json");

async function main() {
  const { catalog, filled, scaleway, unpriced, effortDrift, sourceFailures } = await buildCatalog();

  // BEFORE the write, unlike every check below: an incomplete source yields a catalog missing
  // models, and vendoring that commits the hole into the seed every fresh deployment boots on.
  if (sourceFailures.length) {
    console.error(`\nSOURCE INCOMPLETE OR UNREACHABLE: ${sourceFailures.join(", ")}`);
    console.error(`${OUT} left untouched. Re-run once the source is back.`);
    process.exit(1);
  }

  writeFileSync(OUT, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`wrote ${Object.keys(catalog).length} models to ${path.relative(process.cwd(), OUT)}`);
  if (filled.length) console.log(`filled from models.dev (not yet in LiteLLM): ${filled.join(", ")}`);
  if (scaleway.length) console.log(`priced in EUR from Scaleway's own catalog: ${scaleway.join(", ")}`);

  // Prices are vendored above; the reasoning levels are not, so drift in them is reported rather
  // than written. See the Scaleway records in lib/models/registry.ts for why they stay hand-maintained.
  if (effortDrift.length) {
    console.error(`\nSCALEWAY REASONING LEVELS MOVED:\n  ${effortDrift.join("\n  ")}`);
    console.error("Update the Scaleway records in lib/models/registry.ts to match, then re-run.");
    process.exit(1);
  }
  if (unpriced.length) {
    console.error(`\nNO RATE for offered model(s): ${unpriced.join(", ")}`);
    console.error("Neither source prices these. Retire them from lib/models/registry.ts or add a source.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
