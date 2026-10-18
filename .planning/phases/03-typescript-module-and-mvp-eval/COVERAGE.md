# API Coverage - Phase 3

No external API integration: Phase 3 adds no HTTP API client, SDK or hosted-service surface to the product. The eval harness starts the locally installed `claude` command-line program in headless mode and reads its JSON output; the free-alternatives evaluation runs third-party tools on a developer machine for comparison only; the TypeScript compiler worker is a local child process. Nothing in the shipped package contacts a network service (PROJECT.md constraint: no network by default, no telemetry).
