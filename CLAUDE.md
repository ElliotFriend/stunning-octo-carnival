# cctp-demo project notes

## Work split: Soroban contracts vs frontend/EVM

For this project specifically, user is writing the Soroban (Rust) contracts
themselves and wants me to handle the frontend and EVM integration. When the
user mentions a new wrapper or helper contract for this repo, propose the
design and offer to wire it into the frontend, but don't scaffold the Rust /
`stellar contract` workflow unless they ask.

This split is project-scoped, not a universal preference — on other projects
they may want help authoring Soroban contracts.
