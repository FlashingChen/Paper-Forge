import { build } from "esbuild";

for (const entry of ["dispatcher", "worker", "node-manager", "model-gateway"]) {
  await build({ entryPoints: [`scripts/execution/${entry}.ts`], outfile: `.execution/${entry}.cjs`,
    bundle: true, platform: "node", target: "node22", format: "cjs", external: ["next", "next/*"] });
}
