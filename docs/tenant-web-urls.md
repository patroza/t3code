# Tenant web URLs

The combined Discord/Teams bot uses deployment configuration for web links. Product
code must not invent a tenant hostname or rewrite a public PR link to a shared host.

| Variable                    | Purpose                                                            | Unset behavior                                             |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `T3_WEB_UI_BASE_URL`        | Bot cards, thread links and private-repository PR links            | Omit web links                                             |
| `T3_WEB_UI_PUBLIC_BASE_URL` | Explicitly publishable base for public/unknown-repository PR links | Omit those PR links; never fall back to the private origin |
| `T3_HTTP_BASE_URL`          | Bot-to-server transport                                            | Local server default; independent of the browser URL       |

Set both web bases to the tenant's protected public hostname when that hostname may
appear in public PRs. They may differ when the normal browser address is private:

```env
T3_WEB_UI_BASE_URL=https://workspace.private.example.test
T3_WEB_UI_PUBLIC_BASE_URL=https://workspace.public.example.test
T3_HTTP_BASE_URL=http://127.0.0.1:3773
```

The public base must be an HTTP(S) URL without user credentials, query or fragment.
Invalid values omit public links. Only the thread ID and message anchor are retained
from the private link; private query parameters and origin are not published.
Configure each deployment separately. No tenant domain is a product default.

This controls newly generated links. Previously posted cards, PR bodies and saved
client environment URLs do not change automatically; preserve their legacy routes.
Teams app manifest URLs and Azure Bot callbacks are separate external registration
settings and must be migrated independently while preserving callback aliases.

The native scheduled-hook API exposes its delivery path. Without a relay origin,
the advertised full URL may be null; operators can combine their verified public
origin with that native path. Do not set a relay origin to fake direct ingress.

Cloudflare Access login does not currently replace T3 pairing. Changing these URL
variables does not enable Cloudflare JWT identity authentication.
