# Teams app package

Before zipping this directory:

1. Replace `${TEAMS_APP_ID}` and `${TEAMS_CLIENT_ID}` with the app/client ID.
2. Replace `${PUBLIC_BASE_URL}` and `${PUBLIC_HOST}` with the public HTTPS origin and host.
3. Add a transparent 32×32 `outline.png` and a full-color 192×192 `color.png`.
4. Zip `manifest.json`, `outline.png`, and `color.png` at the archive root.

The app sends activities to the Azure Bot messaging endpoint configured separately as
`https://<PUBLIC_HOST>/api/messages`.
