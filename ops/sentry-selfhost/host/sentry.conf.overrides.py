# >>> 6529 sentry-selfhost overrides (managed by ops/sentry-selfhost/host/install-sentry.sh)
# No calls to Sentry the company: no beacon (install stats and update checks)
# and no features that need the public internet.
SENTRY_BEACON = False
SENTRY_AIR_GAP = True

# TLS terminates at CloudFront. The bundled nginx always sends
# X-Forwarded-Proto: http to the web container, so trust CloudFront's own
# viewer-protocol header instead. Only the CloudFront VPC origin can reach
# this host, and viewers cannot set CloudFront-* headers.
SECURE_PROXY_SSL_HEADER = ("HTTP_CLOUDFRONT_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SOCIAL_AUTH_REDIRECT_IS_HTTPS = True
CSRF_TRUSTED_ORIGINS = ["__URL_PREFIX__"]
# <<< 6529 sentry-selfhost overrides
