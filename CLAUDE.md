# cctp-demo project notes

## Work split: Soroban contracts vs frontend/EVM

For this project specifically, user is writing the Soroban (Rust) contracts
themselves and wants me to handle the frontend and EVM integration. When the
user mentions a new wrapper or helper contract for this repo, propose the
design and offer to wire it into the frontend, but don't scaffold the Rust /
`stellar contract` workflow unless they ask.

This split is project-scoped, not a universal preference — on other projects
they may want help authoring Soroban contracts.

## Available Svelte MCP Tools:

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
