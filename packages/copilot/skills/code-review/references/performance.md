# performance

Use this perspective when the change touches large data, database queries, rendering, caching, batch jobs, or network calls.

## Checklist

- Avoid N+1 queries and avoid repeated network calls in loops.
- Large arrays or result sets are paginated, filtered, streamed, or bounded where relevant.
- Expensive work is not repeated unnecessarily.
- Caching is used only when invalidation behavior is clear.
- UI rendering avoids unnecessary rerenders and expensive synchronous work.
- Batch jobs have bounded memory and time characteristics.
- Performance tradeoffs are explained when relevant.
