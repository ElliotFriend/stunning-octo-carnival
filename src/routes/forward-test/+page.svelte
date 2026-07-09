<script lang="ts">
    // THROWAWAY experiment route: probe Circle's Crosschain Forwarding Service
    // between two chains that DO support it (Ethereum Sepolia <-> Base Sepolia),
    // to confirm our cctp-forward hookData + maxFee actually trigger the relayer.
    // Not wired into the app. Self-contained: own viem clients + injected wallet.
    import {
        createWalletClient,
        createPublicClient,
        custom,
        http,
        pad,
        erc20Abi,
        parseUnits,
        formatUnits,
        getAddress,
        type Hex,
    } from 'viem';
    import { sepolia, baseSepolia } from 'viem/chains';
    import { onMount } from 'svelte';

    const IRIS = 'https://iris-api-sandbox.circle.com';
    // Same deterministic address on every CCTP V2 EVM deployment.
    const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
    // 32-byte hookData = "cctp-forward" magic (24B) + u32 version(0) + u32 len(0).
    const CCTP_FORWARD_HOOK =
        '0x636374702d666f72776172640000000000000000000000000000000000000000' as Hex;

    const CHAINS = {
        'eth-sepolia': {
            label: 'Ethereum Sepolia',
            chain: sepolia,
            domain: 0,
            usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Hex,
        },
        'base-sepolia': {
            label: 'Base Sepolia',
            chain: baseSepolia,
            domain: 6,
            usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Hex,
        },
    } as const;
    type ChainKey = keyof typeof CHAINS;

    const tokenMessengerAbi = [
        {
            type: 'function',
            name: 'depositForBurnWithHook',
            stateMutability: 'nonpayable',
            inputs: [
                { name: 'amount', type: 'uint256' },
                { name: 'destinationDomain', type: 'uint32' },
                { name: 'mintRecipient', type: 'bytes32' },
                { name: 'burnToken', type: 'address' },
                { name: 'destinationCaller', type: 'bytes32' },
                { name: 'maxFee', type: 'uint256' },
                { name: 'minFinalityThreshold', type: 'uint32' },
                { name: 'hookData', type: 'bytes' },
            ],
            outputs: [],
        },
    ] as const;

    let source = $state<ChainKey>('eth-sepolia');
    let amount = $state('1');
    let account = $state<Hex | null>(null);
    let busy = $state(false);
    let lines = $state<string[]>([]);

    let dest = $derived<ChainKey>(source === 'eth-sepolia' ? 'base-sepolia' : 'eth-sepolia');

    function log(msg: string) {
        lines = [...lines, `${new Date().toLocaleTimeString()}  ${msg}`];
    }

    // EIP-6963 provider discovery so we can pick MetaMask specifically when
    // several wallets (e.g. HOT) inject themselves over window.ethereum.
    type Eip6963Provider = {
        info: { rdns: string; name: string };
        provider: Parameters<typeof custom>[0];
    };
    let providers = $state<Eip6963Provider[]>([]);

    onMount(() => {
        const onAnnounce = (e: Event) => {
            const detail = (e as CustomEvent<Eip6963Provider>).detail;
            if (!providers.some((p) => p.info.rdns === detail.info.rdns)) {
                providers = [...providers, detail];
            }
        };
        window.addEventListener('eip6963:announceProvider', onAnnounce);
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
    });

    function metamask() {
        const mm =
            providers.find((p) => p.info.rdns === 'io.metamask') ??
            providers.find((p) => p.info.name.toLowerCase().includes('metamask'));
        if (mm) return mm.provider;
        // Fallback: legacy multi-provider array, then bare window.ethereum.
        const eth = (
            window as unknown as {
                ethereum?: { isMetaMask?: boolean; providers?: Array<{ isMetaMask?: boolean }> };
            }
        ).ethereum;
        const legacy =
            eth?.providers?.find((p) => p.isMetaMask) ?? (eth?.isMetaMask ? eth : undefined);
        if (!legacy) throw new Error('MetaMask not found. Is the extension installed/enabled?');
        return legacy as Parameters<typeof custom>[0];
    }

    function pub(key: ChainKey) {
        return createPublicClient({ chain: CHAINS[key].chain, transport: http() });
    }

    async function connect() {
        const wallet = createWalletClient({ transport: custom(metamask()) });
        const [addr] = await wallet.requestAddresses();
        account = addr;
        log(`connected ${addr}`);
    }

    async function run() {
        if (!account) {
            log('connect a wallet first');
            return;
        }
        busy = true;
        try {
            const src = CHAINS[source];
            const dst = CHAINS[dest];
            const recipient = account;
            const value = parseUnits(amount, 6); // testnet USDC is 6-dp on both chains
            log(
                `--- ${src.label} (domain ${src.domain}) -> ${dst.label} (domain ${dst.domain}) ---`,
            );

            const wallet = createWalletClient({
                account,
                chain: src.chain,
                transport: custom(metamask()),
            });
            await wallet.switchChain({ id: src.chain.id }).catch(async () => {
                await wallet.addChain({ chain: src.chain });
                await wallet.switchChain({ id: src.chain.id });
            });

            const srcPub = pub(source);
            const dstPub = pub(dest);

            // 1. forward fee quote
            const feeUrl = `${IRIS}/v2/burn/USDC/fees/${src.domain}/${dst.domain}?forward=true`;
            const feeRes = await fetch(feeUrl);
            if (!feeRes.ok) throw new Error(`fee API ${feeRes.status}: ${await feeRes.text()}`);
            const feeRows = (await feeRes.json()) as Array<{
                finalityThreshold: number;
                minimumFee: number;
                forwardFee?: { low: number; med: number; high: number };
            }>;
            log(`fee rows: ${JSON.stringify(feeRows)}`);
            const fastRow = feeRows.find((r) => r.finalityThreshold === 1000) ?? feeRows[0];
            const forwardHigh = fastRow?.forwardFee?.high ?? 0;
            const baseBps = fastRow?.minimumFee ?? 0;
            // maxFee must cover protocol (bps of amount) + forward fee. Pad generously.
            const maxFee =
                BigInt(Math.ceil((Number(value) * baseBps) / 10000)) + BigInt(forwardHigh) + 1000n;
            log(`forwardFee.high=${forwardHigh}  baseBps=${baseBps}  -> maxFee=${maxFee}`);

            // 2. approve if needed
            const allowance = await srcPub.readContract({
                address: src.usdc,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [recipient, TOKEN_MESSENGER],
            });
            if (allowance < value) {
                log('approving TokenMessengerV2...');
                const ah = await wallet.writeContract({
                    address: src.usdc,
                    abi: erc20Abi,
                    functionName: 'approve',
                    args: [TOKEN_MESSENGER, value],
                });
                await srcPub.waitForTransactionReceipt({ hash: ah });
                log(`approved (${ah})`);
            } else {
                log('allowance sufficient');
            }

            // baseline destination balance to detect the relayer-completed mint
            const baseline = await dstPub.readContract({
                address: dst.usdc,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [recipient],
            });
            log(`dest baseline balance: ${formatUnits(baseline, 6)} USDC`);

            // 3. burn with forwarding hookData, destinationCaller = 0
            log('burning with cctp-forward hookData...');
            const burnHash = await wallet.writeContract({
                address: TOKEN_MESSENGER,
                abi: tokenMessengerAbi,
                functionName: 'depositForBurnWithHook',
                args: [
                    value,
                    dst.domain,
                    pad(getAddress(recipient), { size: 32 }),
                    src.usdc,
                    pad('0x', { size: 32 }), // destinationCaller MUST be zero for forwarding
                    maxFee,
                    1000, // minFinalityThreshold (Fast)
                    CCTP_FORWARD_HOOK,
                ],
            });
            await srcPub.waitForTransactionReceipt({ hash: burnHash });
            log(`burned: ${burnHash}`);

            // 4. attestation (informational) — forwarding relayer mints, not us
            log('polling Iris attestation...');
            const attStart = Date.now();
            let attested = false;
            while (Date.now() - attStart < 5 * 60_000) {
                const r = await fetch(
                    `${IRIS}/v2/messages/${src.domain}?transactionHash=${burnHash.toLowerCase()}`,
                );
                if (r.ok) {
                    const body = (await r.json()) as { messages?: Array<{ status: string }> };
                    const st = body.messages?.[0]?.status;
                    if (st) log(`attestation status: ${st}`);
                    if (st === 'complete') {
                        attested = true;
                        break;
                    }
                }
                await new Promise((res) => setTimeout(res, 5000));
            }
            log(attested ? 'attested.' : 'attestation timed out.');

            // 5. observe: did the relayer mint without us?
            log('watching dest balance for relayer mint (up to 3 min)...');
            const obsStart = Date.now();
            while (Date.now() - obsStart < 3 * 60_000) {
                const bal = await dstPub.readContract({
                    address: dst.usdc,
                    abi: erc20Abi,
                    functionName: 'balanceOf',
                    args: [recipient],
                });
                if (bal > baseline) {
                    log(
                        `✅ RELAYER MINTED: +${formatUnits(bal - baseline, 6)} USDC (no mint tx from us)`,
                    );
                    return;
                }
                log(`waiting… ${Math.round((Date.now() - obsStart) / 1000)}s`);
                await new Promise((res) => setTimeout(res, 5000));
            }
            log('❌ no relayer mint within 3 min. Burn is attested; mint manually if needed.');
        } catch (err) {
            log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            busy = false;
        }
    }
</script>

<main style="max-width:720px;margin:2rem auto;padding:1rem;font-family:system-ui">
    <h1>Forwarding Service probe (EVM ↔ EVM)</h1>
    <p style="color:#888">
        Throwaway. Tests the Circle forwarding relayer on a route that supports it. Funds: testnet
        USDC. Forwarding should auto-mint on the destination with no mint tx from you.
    </p>

    {#if !account}
        <button onclick={connect}>Connect wallet</button>
    {:else}
        <p>account: <code>{account}</code></p>
        <label>
            Source:
            <select bind:value={source} disabled={busy}>
                <option value="eth-sepolia">Ethereum Sepolia → Base Sepolia</option>
                <option value="base-sepolia">Base Sepolia → Ethereum Sepolia</option>
            </select>
        </label>
        <label style="margin-left:1rem">
            Amount (USDC):
            <input bind:value={amount} disabled={busy} style="width:6rem" />
        </label>
        <button onclick={run} disabled={busy} style="margin-left:1rem">
            {busy ? 'running…' : 'Run forwarded transfer'}
        </button>
    {/if}

    <pre
        style="background:#111;color:#ddd;padding:1rem;margin-top:1rem;border-radius:8px;white-space:pre-wrap;font-size:0.8rem">{lines.join(
            '\n',
        ) || '(log)'}</pre>
</main>
