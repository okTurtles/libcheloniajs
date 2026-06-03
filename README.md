<p align="center">
    <a title="Slack" href="https://join.slack.com/t/okturtles/shared_invite/zt-10jmpfgxj-tXQ1MKW7t8qqdyY6fB7uyQ"><img src="https://img.shields.io/badge/slack-%23groupincome-green"></a>
    <a title="Ask DeepWiki" href="https://deepwiki.com/okTurtles/libcheloniajs"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
    <a title="Donate" href="https://okturtles.org/donate/"><img src="https://img.shields.io/badge/donate%20-%3D%E2%9D%A4-blue.svg"></a>
</p>

# @chelonia/lib

A library for building end-to-end encrypted, federated applications with Chelonia.

Implements [Shelter Protocol](https://shelterprotocol.net).

## Overview

`@chelonia/lib` provides the core functionality for creating decentralized applications with built-in encryption, federation capabilities, and secure data synchronization. It's designed to enable developers to build privacy-focused, distributed systems without having to implement complex cryptographic protocols from scratch.

## Features

- **End-to-End Encryption**: Create apps with shared state using end-to-end encrypted smart contracts
- **File Handling**: End-to-end encrypted file storage and retrieval
- **Secure KV Store**: End-to-end encrypted key-value store
- **Pubsub**: End-to-end encrypted pubsub
- **Federation Support (coming soon)**: Create applications that can communicate across different servers and instances
- **Persistent Actions**: Queue and retry mechanism for reliable operations

And more!

## Installation

```bash
npm install -S @chelonia/lib
```

## Usage

More guides are coming. In the meantime, see the [`docs/`](./docs) directory:

- [`docs/configure.md`](./docs/configure.md) — full reference for the
  `chelonia/configure` selector (every option, validation rules, reconfigure
  semantics) with a complete working app example.
- [`docs/journal.md`](./docs/journal.md) — the optional per-contract event
  journal: enabling it, redactions, snapshot tuning, reconstruct, and clear.

[Join our Slack](https://join.slack.com/t/okturtles/shared_invite/zt-10jmpfgxj-tXQ1MKW7t8qqdyY6fB7uyQ) or use [Github Discussions](https://github.com/okTurtles/libcheloniajs/discussions) if you have questions.

## Requirements

Should work with Node 22 or Deno.

## License

This software is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

For commercial licensing options or if you need a different license arrangement, please contact hi@okturtles.org for dual-licensing opportunities. If you don't hear back, try reaching out on [Keybase](https://keybase.io/greg).
