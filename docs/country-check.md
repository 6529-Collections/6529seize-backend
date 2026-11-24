# Country checks

`GET /api/policies/country-check` returns the existing `country` and `is_eu`
fields for cookie-consent decisions. The EU/EEA country set is unchanged.
Sanctions enforcement remains in AWS WAF and is independent of this endpoint.

## Country source

The API can prefer the `x-amzn-waf-country` header on REST API Gateway
requests. This requires `TRUST_WAF_COUNTRY_HEADER=true`; the default is to
ignore the header. Only a single uppercase ISO 3166-1 alpha-2 country code is
accepted. Missing, unknown (`XX`), malformed or duplicate values fall back to
FindIP. Local HTTP servers and other request contexts ignore the header.

The FindIP fallback retains its three-second timeout and per-process 24-hour
cache. It is permanent, including for environments that do not enable WAF
header trust. Localhost retains its existing EU/unknown-country response.
Missing source IPs and failed FindIP lookups retain their existing error
responses. This change does not alter stored cookie preferences or public
request/response schemas.

## Enabling header trust

Before setting `TRUST_WAF_COUNTRY_HEADER=true` in an environment:

1. Ensure the REST API stage is protected by the intended WAF web ACL.
2. Ensure a client-IP GeoMatch statement evaluates before every Allow path.
   It supplies the `awswaf:clientip:geo:country:` label even for countries that
   do not match the statement's blocking list.
3. Configure **every** Allow path, including the web ACL default action and
   explicit SSR Allow rules, to insert a header named `country` with value
   `${awswaf:clientip:geo:country:}`. WAF prefixes the name with `x-amzn-waf-`
   and overwrites any caller-supplied header of the same name.
4. Verify the resolved country and overwritten spoofed value in WAF samples.
   Verify receipt through the API Gateway Lambda proxy integration when
   validating the deployed application.

An API Gateway request context does not by itself authenticate the header.
Do not enable trust on a local server, an unprotected stage, or an environment
whose WAF has an Allow path that leaves the caller's header intact. For SSR,
WAF's country describes its caller's IP, not a visitor named in a forwarding
header; browser/native country checks must originate from the visitor.

AWS references: [geographic match statements](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-geo-match.html),
[dynamic label interpolation](https://docs.aws.amazon.com/waf/latest/developerguide/waf-dynamic-label-interpolation.html),
and [header insertion and overwrite](https://docs.aws.amazon.com/waf/latest/developerguide/customizing-the-incoming-request.html).

Only the `api` service (`seizeAPI`) requires deployment. Enable header trust
only after the environment's WAF prerequisites are verified; disabling it
returns all country lookups to FindIP without changing access restrictions.
