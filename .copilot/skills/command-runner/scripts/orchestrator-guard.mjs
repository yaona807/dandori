#!/usr/bin/env node
// Agent-scoped PreToolUse: a temporarily over-exposed Orchestrator may only
// delegate, never execute the tools inherited for Copilot subagent visibility.
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

if (name === 'task' || name === 'agent') {
  // Leave the host's ordinary permission checks in place.
  process.stdout.write('{}\n');
} else {
  const reason = 'Orchestrator may only delegate through task/agent. Direct worker-tool execution is prohibited.';
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
