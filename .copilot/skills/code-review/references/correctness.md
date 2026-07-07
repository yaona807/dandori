# correctness

Check whether the implementation satisfies the requested behavior without unintended regressions.

## Checklist

- Requirement alignment is explicit.
- Existing behavior is preserved unless intentionally changed.
- Edge cases are handled.
- `null`, `undefined`, empty arrays, empty strings, and invalid inputs are considered where relevant.
- Error handling follows existing project patterns.
- Async behavior, retries, race conditions, and idempotency are considered where relevant.
- Types match runtime behavior.
- The change is minimal and avoids unrelated behavior changes.
