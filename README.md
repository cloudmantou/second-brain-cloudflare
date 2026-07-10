# Singularity

> The AI memory engine for your personal intelligence.

Singularity is a self-hosted long-term memory system designed for AI agents.

It transforms conversations, projects, decisions, and knowledge into an evolving memory network.

The goal is not just storing information, but creating a system where memories can connect, evolve, and produce intelligence.

## Features

- Long-term AI memory
- Semantic vector search
- Hybrid retrieval
- MCP integration
- Self-host deployment
- Local-first data ownership
- Memory classification
- Memory lifecycle management
- AI-powered summarization
- Personal knowledge graph (coming soon)

## Vision

The name Singularity comes from the concept of a black hole singularity:

A point where existing rules collapse and new intelligence emerges.

Singularity represents the transition from:

```
Storage → Memory
Memory → Understanding
Understanding → Intelligence
```

## Architecture

Current architecture:

```
User / Agent
     |
     v
MCP Memory Layer
     |
+----+----+
|         |
v         v
Vector    Structured
Search    Memory
     |
     v
AI Reasoning Layer
```

Future architecture:

```
             Memory Universe

          Entities
             |
    +--------+--------+
    |                 |
Projects          Knowledge
    |
Decisions
    |
Experiences
```

## Quick start (self-host)

```bash
cp .env.example .env   # set AUTH_TOKEN and AI/embedding keys
npm install
npm run selfhost
```

Open `http://127.0.0.1:8787`, then connect MCP clients to `https://YOUR-DOMAIN/mcp`.

Docker:

```bash
docker compose up -d --build
```

## MCP

```bash
claude mcp add --transport http singularity https://YOUR-DOMAIN/mcp
codex mcp add singularity --url https://YOUR-DOMAIN/mcp
```

## Origin

Inspired by [second-brain-cloudflare](https://github.com/rahilp/second-brain-cloudflare).

The original project provided the foundation of:

- MCP integration
- Cloudflare Worker architecture
- Vector memory storage
- AI retrieval pipeline

**Singularity is an independent open-source project** that continues to evolve with:

- new memory architecture
- entity relationships
- knowledge graph
- AI-native retrieval
- personal intelligence systems

It is not a rename-only fork. It is a product line for a long-term AI memory engine.

## Roadmap

| Version | Theme | Focus |
|---------|--------|--------|
| v0.1.0 | Foundation | MCP memory, vector retrieval, self-host, AI chat |
| v0.2.0 | Memory Intelligence | atomic memory, entity extraction, graph, revisions |
| v0.3.0 | Memory Universe | 3D graph, timeline, project galaxy, AI evolution |

## License

MIT License
