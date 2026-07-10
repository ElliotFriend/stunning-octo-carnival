import { readFileSync, writeFileSync, readdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

// Regenerate the @solana/kit client for Circle's TokenMessengerMinterV2
// program from its Anchor IDL. Refresh the IDL with:
//   anchor idl fetch CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe \
//     --provider.cluster devnet > idl/token_messenger_minter_v2.json

const TMP = 'src/lib/solana/.codama-tmp';
const OUT = 'src/lib/solana/generated';

const idl = JSON.parse(readFileSync('idl/token_messenger_minter_v2.json', 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));

// formatCode:false — Codama's bundled prettier can't infer a parser against
// this repo's prettier 3.9.x; the generated dir is prettier/eslint-ignored
// instead, so raw output is fine.
// The JS renderer writes files asynchronously — await it before relocating.
await codama.accept(renderVisitor(TMP, { formatCode: false }));

// renderVisitor scaffolds a package: <TMP>/src/generated/<modules>. Lift the
// module dir up to OUT so consumers import from '$lib/solana/generated'.
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
renameSync(`${TMP}/src/generated`, OUT);
rmSync(TMP, { recursive: true, force: true });

// renderers-js 2.x imports its runtime helpers from the standalone
// '@solana/program-client-core' (Kit-7 aligned). Our Kit is pinned to 6.10,
// which re-exports the same symbols from its own bundled copy at the subpath
// '@solana/kit/program-client-core'. Rewrite the import so our src typechecks
// against Kit's bundled version (the same trick @solana-program/token uses)
// instead of forcing a conflicting top-level @solana/program-client-core@7.
function patchGenerated(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) patchGenerated(p);
        else if (entry.name.endsWith('.ts')) {
            const src = readFileSync(p, 'utf8');
            const fixed = src
                // Resolve the runtime helper against Kit's re-exported subpath
                // (our pinned Kit 6.10) instead of the conflicting standalone v7.
                .replaceAll("'@solana/program-client-core'", "'@solana/kit/program-client-core'")
                // Codama guards dev-only error messages with `process.env.NODE_ENV`,
                // a Node-ism that throws in the browser. Keep the messages always
                // on (fine for a demo) so the generated code never touches process.
                .replaceAll("process.env['NODE_ENV'] !== 'production'", 'true');
            if (fixed !== src) writeFileSync(p, fixed);
        }
    }
}
patchGenerated(OUT);

console.log(`Generated Solana CCTP client → ${OUT}`);
