import { readFileSync, writeFileSync, readdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

// Regenerate the @solana/kit clients for Circle's CCTP V2 programs from their
// Anchor IDLs. Refresh the IDLs with:
//   anchor idl fetch CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe --provider.cluster devnet > idl/token_messenger_minter_v2.json
//   anchor idl fetch CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC --provider.cluster devnet > idl/message_transmitter_v2.json
const PROGRAMS = [
    {
        idl: 'idl/token_messenger_minter_v2.json',
        out: 'src/lib/solana/generated/token-messenger-minter',
    },
    {
        idl: 'idl/message_transmitter_v2.json',
        out: 'src/lib/solana/generated/message-transmitter',
    },
];

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
                // Strip the Node-only process.env guard (throws in the browser).
                .replaceAll("process.env['NODE_ENV'] !== 'production'", 'true');
            if (fixed !== src) writeFileSync(p, fixed);
        }
    }
}

for (const { idl, out } of PROGRAMS) {
    const tmp = `${out}-tmp`;
    const codama = createFromRoot(rootNodeFromAnchor(JSON.parse(readFileSync(idl, 'utf8'))));
    // The JS renderer writes files asynchronously — await it before relocating.
    await codama.accept(renderVisitor(tmp, { formatCode: false }));
    // renderVisitor scaffolds a package: <tmp>/src/generated/<modules>. Lift the
    // module dir up to OUT so consumers import from a clean per-program path.
    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    renameSync(`${tmp}/src/generated`, out);
    rmSync(tmp, { recursive: true, force: true });
    patchGenerated(out);
    console.log(`Generated Solana CCTP client → ${out}`);
}
