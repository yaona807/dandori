#!/usr/bin/env node
/**
 * GitHub MCP mutation approval gate for Copilot preToolUse.
 *
 * This is a prompt-layer approval request, not an authorization boundary.
 * A Host which cannot guarantee one-time approval must expose READ tools only.
 * Treat an unrecognized GitHub tool name or input schema as denied.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const READ = new Set([
  'pull_request_read', 'list_pull_requests', 'search_pull_requests',
  'issue_read', 'list_issues', 'search_issues',
  'actions_get', 'actions_list', 'get_job_logs',
  'get_file_contents', 'get_commit', 'list_branches', 'list_commits',
  'search_code', 'search_commits',
]);
const WRITE = new Set([
  'create_pull_request', 'update_pull_request', 'update_pull_request_branch',
  'merge_pull_request', 'pull_request_review_write', 'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment', 'issue_write', 'add_issue_comment',
  'update_issue_comment', 'actions_run_trigger', 'create_branch',
  'request_copilot_review',
]);
const DENY = (message) => ({ permissionDecision: 'deny', permissionDecisionReason: message });
const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
const hasId = (v) => Number.isSafeInteger(v) && v > 0;

function validWrite(tool, args) {
  const text = (key) => hasText(args[key]);
  const id = (key) => hasId(args[key]);
  switch (tool) {
    case 'create_pull_request': return text('head') && text('base') && text('title');
    case 'update_pull_request': return id('pullNumber')
      && ['title', 'body', 'base', 'draft', 'state', 'reviewers', 'maintainer_can_modify']
        .some(key => Object.hasOwn(args, key));
    case 'update_pull_request_branch': return id('pullNumber');
    case 'merge_pull_request': return id('pullNumber')
      && typeof args.expectedHeadSha === 'string' && /^[0-9a-f]{40}$/iu.test(args.expectedHeadSha);
    case 'pull_request_review_write': return id('pullNumber') && text('method')
      && (!['resolve_thread', 'unresolve_thread'].includes(args.method) || text('threadId'));
    case 'add_comment_to_pending_review': return id('pullNumber')
      && text('body') && text('path') && text('subjectType');
    case 'add_reply_to_pull_request_comment': return id('commentId')
      && (text('body') || text('reaction')) && (!text('body') || id('pullNumber'));
    case 'issue_write': return ['create', 'update'].includes(args.method)
      && (args.method === 'create' ? text('title') : id('issue_number'));
    case 'add_issue_comment': return id('issue_number') && (text('body') || text('reaction'));
    case 'update_issue_comment': return id('comment_id') && text('body');
    case 'actions_run_trigger': return text('method')
      && (args.method === 'run_workflow'
        ? text('ref') && text('workflow_id') : id('run_id'));
    case 'create_branch': return text('branch');
    case 'request_copilot_review': return id('pullNumber');
    default: return false;
  }
}

export function githubMcpDecision(name, rawArgs) {
  if (typeof name !== 'string') return null;
  // A runtime alias must be observed and explicitly added; it cannot silently
  // avoid the guard just because its namespace separator differs.
  if (name.startsWith('mcp__github__') || name.startsWith('github.')) {
    return DENY('Unknown GitHub MCP tool alias; verify the runtime tool name.');
  }
  if (!name.startsWith('github/')) return null;
  const tool = name.slice('github/'.length);
  if (READ.has(tool)) return {};
  if (!WRITE.has(tool)) return DENY('GitHub MCP tool is not in the approved inventory.');
  let args = rawArgs;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { return DENY('Invalid GitHub MCP arguments.'); }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || !hasText(args.owner) || !hasText(args.repo)
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(args.owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(args.repo)
    || !validWrite(tool, args)) {
    return DENY('Missing or invalid GitHub MCP mutation target or arguments.');
  }
  const subject = args.pullNumber ?? args.issue_number ?? args.commentId ?? args.comment_id;
  const details = subject ? ` #${subject}` : '';
  return {
    permissionDecision: 'ask',
    permissionDecisionReason:
      `GitHub write ${tool} on ${args.owner}/${args.repo}${details}; inspect ALL tool arguments and effects before approving this single call.`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const result = githubMcpDecision(input?.toolName ?? input?.tool_name,
      input?.toolArgs ?? input?.tool_input);
    process.stdout.write(JSON.stringify(result ?? {}) + '\n');
  } catch {
    process.stdout.write(JSON.stringify(DENY('Invalid preToolUse input.')) + '\n');
  }
}
