<script lang="ts">
    import SolanaPanel from '$lib/components/SolanaPanel.svelte';
    import type { SolanaWallet } from '$lib/solana/wallet';

    let wallet = $state<SolanaWallet | null>(null);
</script>

<h1>Solana balance spike</h1>
<SolanaPanel bind:wallet />
