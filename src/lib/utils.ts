export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Truncate a long address-like string for display. Works for any opaque
// identifier — Stellar G-/C-addresses (56 chars), EVM 0x-addresses (42),
// transaction hashes (64–66). Keeps `head` chars at the front and `tail`
// at the back with a single ellipsis between.
export function shortAddr(addr: string, head = 6, tail = 4): string {
    if (addr.length <= head + tail + 1) return addr;
    return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
