# Teams app package

Before zipping this directory:

1. Replace `${TEAMS_APP_ID}` and `${TEAMS_CLIENT_ID}` with the app/client ID.
2. Replace `${PUBLIC_BASE_URL}` and `${PUBLIC_HOST}` with the public HTTPS origin and host.
3. Add a transparent 32×32 `outline.png` and a full-color 192×192 `color.png`.
4. Zip `manifest.json`, `outline.png`, and `color.png` at the archive root.

The app sends activities to the Azure Bot messaging endpoint configured separately as
`https://<PUBLIC_HOST>/api/messages`.

The installed app for every team is `gateway-manifest.json`. That package is the one
added to a group chat. This `manifest.json` remains the legacy single-instance package.

Group chats stay silent. MAKO, Easy Life, and Empasa scanner or scanning chats map to
the scanner project when that workspace sets `scannerGroupChats`. Each mapped chat gets
one T3 thread, one Discord thread in the alerts channel, and one thread in the mirror
channel. Later messages continue those threads.
