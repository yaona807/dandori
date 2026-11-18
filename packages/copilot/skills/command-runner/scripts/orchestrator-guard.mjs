#!/usr/bin/env node
// Agent-scoped PreToolUse: a temporarily over-exposed Orchestrator may only
// delegate or manage approved Copilot Memory; inherited Worker tools stay blocked.
import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let name = '';
try {
  const event = JSON.parse(input);
  const candidate = event.toolName ?? event.tool_name;
  if (typeof candidate === 'string') name = candidate.toLowerCase();
} catch {
  // Malformed input is denied rather than treated as normal permission.
}

if (name === 'task' || name === 'agent' || name === 'read_memories') {
  // Read-only memory and delegation retain ordinary Host checks.
  process.stdout.write('{}\n');
} else if (name === 'store_memory' || name === 'vote_memory') {
  // Model-side TFR grants are not readable here; require Host confirmation
  // for each actual cloud-memory mutation, even if permissions were cached.
  const reason = 'Copilot Memory writes require explicit scoped TFR authority and human Host approval.';
  process.stdout.write(JSON.stringify({
    permissionDecision: 'ask',
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }) + '\n');
} else {
  const reason = 'Orchestrator may only delegate through task/agent or use exact Copilot Memory tools. Direct worker-tool execution is prohibited.';
  // Copilot CLI uses top-level decision fields; VS Code compatibility hooks
  // use hookSpecificOutput. Emit both to support either hook payload format.
  process.stdout.write(JSON.stringify({
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n');
}
