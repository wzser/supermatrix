---
last_updated: 2026-09-14
confidence: medium
refresh_cadence: event-driven
parent: null
children: []
unwritten_children: []
boundary_with: []
---

# Agent workflows

## 1. 什么是 agent workflow

An agent workflow is a bounded run in which an agent, its tools, context, and
handoffs are resolved for a task and produce a result that can be inspected.
This seed treats state ownership and protocol boundaries as separate concerns:
the SDK reference describes the local run boundary, while A2A describes the
cross-agent task boundary and MCP identifies a protocol/schema/documentation
surface.

## 2. 核心观察

Reusable agents should resolve dynamic instructions, enabled tools, and
handoffs against the current run context, and all surfaces should use the same
resolved view so that exposure and dispatch cannot diverge [S0001]. Nested
agent-tool runs may share application state while keeping approval and scoped
metadata separate; serialization is a distinct durability decision [S0001].

For cross-agent communication, A2A separates discovery metadata (Agent Card),
stateful work (Task), conversational turns (Message), content units (Part),
and concrete outputs (Artifact) [S0002]. The protocol supports polling,
server-sent-event streaming, and push notifications, so the choice of transport
should follow the required responsiveness and persistence [S0002].

MCP is a neighboring protocol surface rather than a replacement for the local
run or cross-agent task model. Its public repository contains the specification,
protocol schema, and documentation, with both TypeScript and JSON Schema forms
identified in the pinned overview [S0003]. This source is intentionally narrow;
it does not support claims about every MCP feature.

## 3. 离线检索边界

The public seed answers only claims supported by the three pinned sources. The
query fixture demonstrates a citation-bearing lookup and keeps the source IDs
stable. Questions about provider credentials, a user's remote targets, or live
runtime state are outside this seed and must be answered from the recipient's
own configuration.

## 来源一览

- [S0001] OpenAI Agents SDK run-context reference
- [S0002] A2A official core concepts
- [S0003] MCP official repository overview
