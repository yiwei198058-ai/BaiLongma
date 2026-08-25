---
type: product-brief
title: Bailongma Voice Operator
status: draft
created: 2026-08-25
---

# Bailongma Voice Operator

## Product Thesis

Bailongma should become a voice-first personal work operator for a person who spends long periods at a computer. The user speaks an intention once; Bailongma understands it, remembers the relevant context, performs permitted work, and returns only when a decision, result, or follow-up is needed.

This is not a voice-only chatbot and not an unrestricted always-listening companion. Voice is the primary input and feedback channel for a continuous agent loop.

## Target User

An individual creator, developer, or operator who regularly switches between conversations, files, web research, media work, and follow-up tasks. The first release optimizes for one local user rather than teams or public voice agents.

## Core Promise

"说清楚一次，事情有回音。"

The agent should preserve intent across turns, make progress visible, ask before risky actions, and proactively close the loop on commitments.

## First-Release Scope

1. Voice capture through push-to-talk and continuous mode.
2. Streaming speech recognition and streaming TTS with interruption recovery.
3. Explicit memory capture, lookup, correction, and deletion by voice.
4. Voice-created tasks and reminders with completion feedback.
5. A small set of file, web, search, and media actions routed through existing tools.
6. Confirmation cards and spoken confirmations for high-risk actions.
7. A compact voice state display: listening, thinking, speaking, interrupted, confirming, executing, completed, failed.
8. A turn trace that links transcript, intent, tool calls, result, and spoken response.

## Non-Goals

- Unrestricted background recording.
- Autonomous destructive shell or filesystem actions.
- Emotional dependency or mental-health positioning.
- Multi-user collaboration and public voice endpoints in the first release.
- Adding more voice providers before the interaction loop is reliable.

## Canonical User Flows

### Capture

User: "记一下，周五给客户发报价。"

Agent: identifies a commitment, asks for missing time or recipient only when necessary, persists a memory/task, and confirms briefly.

### Execute

User: "找出这个项目最近修改的接口文件，整理成清单。"

Agent: recalls the active project context, uses read-only tools, speaks a short result, and exposes the detailed list in Brain UI.

### Confirm

User: "把这些文件全部删掉。"

Agent: describes the exact scope, shows a confirmation card, waits for explicit confirmation, then executes or cancels.

### Follow Up

Agent: "你昨天提到的报价还没有标记完成，要现在处理吗？"

The reminder must include the original intent and related thread, not only a generic alarm.

## Voice State Contract

The UI and runtime should share a small state machine:

`idle -> listening -> thinking -> speaking -> listening`

Side states:

- `confirming`: waiting for explicit user approval;
- `interrupted`: user barge-in paused TTS and resumed ASR;
- `executing`: a tool or task is running;
- `completed` / `failed`: result is available and the next state is explicit.

Every state transition should have a timestamp, turn ID, and user-visible reason. TTS should be concise; detailed results belong in the UI.

## Safety and Privacy Gates

1. Microphone state must always be visible and user-controlled.
2. Raw audio retention is off by default; transcript retention is configurable.
3. API keys must never be returned by settings endpoints or committed to the repository.
4. High-risk tools require a user-driven turn and explicit confirmation.
5. Installed tools must run outside the Electron main process with scoped capabilities.
6. Memory records need inspect, edit, forget, export, and reset paths.
7. Proactive reminders must be rate-limited and snoozable.

## Success Measures

- Median time from final transcript to first feedback <= 2 seconds on a warm connection.
- At least 95% of deliberate barge-ins preserve the user's first spoken words in the next turn.
- At least 90% of voice-created tasks retain the correct intent, due time, and thread.
- Zero high-risk actions execute without the required confirmation in the test suite.
- Users can explain why the agent acted by following one turn trace.
- False proactive interruptions remain below a configurable daily budget.

## Implementation Sequence

### Gate 0: Trust and Release

Rotate committed credentials, stop returning plaintext API keys, formalize API authentication, and isolate installed tool execution before widening voice-triggered actions.

### Gate 1: Interaction Backbone

Define the voice state event schema, turn IDs, transcript finalization rules, interruption behavior, and a single response policy for spoken versus visual output.

### Gate 2: Valuable Loops

Connect voice intents to memory capture, task/reminder creation, read-only workspace actions, and confirmation cards. Add deterministic fixtures for each flow.

### Gate 3: Follow-Up and Quality

Add commitment follow-up, voice-specific evaluation metrics, trace review, latency instrumentation, and retention controls.

## Open Decisions

- Whether continuous mode is opt-in per session or can be enabled for a time window.
- Whether the first default ASR path is cloud streaming or local Whisper.
- Which five tools are allowed in the first voice action profile.
- Whether proactive follow-up is enabled by default or starts in suggestion-only mode.
