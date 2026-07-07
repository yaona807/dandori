# security

Use this perspective when the change touches auth, authorization, user data, file handling, external APIs, secrets, logging, admin features, or payment.

## Checklist

- Authentication is required where necessary.
- Authorization is enforced at the correct layer.
- Direct API calls cannot bypass permission checks.
- User input is validated, normalized, and encoded where relevant.
- Sensitive data is not logged or exposed.
- Error messages do not leak internals.
- External URLs, paths, filenames, and redirects are not trusted blindly.
- File upload/download paths are constrained.
- Secrets and environment variables are not exposed.
- CSRF, XSS, SSRF, injection, and privilege escalation risks are considered where relevant.
