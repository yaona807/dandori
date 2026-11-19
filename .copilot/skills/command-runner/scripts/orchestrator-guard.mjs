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
  // Delegation and memory reads keep the ordinary Host permission flow.
  process.stdout.write('{}\n');
} else if (name === 'store_memory' || name === 'vote_memory') {
  // Standing user opt-in: approve only these exact Copilot Memory tools.
  // Other Host/organization hooks and policies can still deny the call.
  process.stdout.write(JSON.stringify({
    permissionDecision: 'allow',
    hookSpecificOutput: { permissionDecision: 'allow' },
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
