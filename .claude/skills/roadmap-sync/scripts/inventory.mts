// Prints the public roadmap inventory: per branch, each entry's tree position,
// status, platforms, and parent. Usage: npx tsx .claude/skills/roadmap-sync/scripts/inventory.mts [branch]
import { resolve } from 'node:path';

const data = await import(resolve(process.cwd(), 'docs-site/src/data/product-tree.ts'));
const { branches, features, featureGrid, treeParent } = data;
const only = process.argv[2];
const counts: Record<string, number> = {};

for (const branch of branches) {
  if (only && branch.id !== only) continue;
  const items = features
    .filter((feature: { branch: string }) => feature.branch === branch.id)
    .sort((a: unknown, b: unknown) => featureGrid(a).row - featureGrid(b).row);
  console.log(`\n${branch.label} (${branch.id}) — ${items.length} entries`);
  for (const feature of items) {
    counts[feature.status] = (counts[feature.status] ?? 0) + 1;
    const { depth } = featureGrid(feature);
    const parent = treeParent(feature)?.id ?? 'hub';
    console.log(
      `  ${'  '.repeat(depth)}${feature.id.padEnd(28 - depth * 2)} ${feature.status.padEnd(12)} ${feature.platforms.join('/').padEnd(26)} ← ${parent}`
    );
  }
}
console.log(`\nTotals: ${JSON.stringify(counts)}  reviewedOn=${data.reviewedOn}`);
