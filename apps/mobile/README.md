# T3 Code Mobile

> [!WARNING]
> T3 Code Mobile is currently in development and is not distributed yet. If you want to try it out, you can build it from source.

## Quickstart

> [!NOTE]
> Uses native modules so using Expo Go is not supported. You need to use the Expo Dev Client.

This app has three variants:

- `development`: Expo dev client, installable side-by-side as `T3 Code Dev`
- `preview`: persistent internal preview build, installable side-by-side as `T3 Code Preview`
- `production`: store/release build as `T3 Code`

Run commands from `apps/mobile`.

T3 Connect is optional and disabled in a fresh clone. Public configuration belongs in the
repository-root `.env` or `.env.local`, not an `apps/mobile/.env` file. See
[`../../.env.example`](../../.env.example).

To sign a fork with your own Apple Developer account, set
`T3CODE_MOBILE_IOS_TEAM_ID`, `T3CODE_MOBILE_IOS_BUNDLE_IDENTIFIER`,
`T3CODE_MOBILE_EAS_PROJECT_ID`, and `T3CODE_MOBILE_EXPO_OWNER` in the repository-root
`.env.local`. Development and preview builds append `.dev` and `.preview` to your bundle
identifier. Run `eas init` once under your Expo account to create the project ID, then use
the existing EAS iOS build commands below. EAS can perform the build remotely; a local
`ios:*` build still requires macOS and Xcode.

### Free Apple Personal Team build

For temporary testing on your own iPhone, a borrowed Mac and a free Apple Account are enough.
This mode removes capabilities that a Personal Team cannot sign: widgets and Live Activities,
push notifications, App Groups, associated domains, and EAS updates. Apple expires free
provisioning profiles after seven days, so the app must then be rebuilt and reinstalled.

On the Mac:

1. Install Xcode, open it once, accept its license, and add your Apple Account under
   **Xcode → Settings → Accounts**.
2. Enable **Developer Mode** on the iPhone and connect it to the Mac by USB.
3. Set `T3CODE_MOBILE_IOS_BUNDLE_IDENTIFIER=dev.patroza.t3code` in the repository-root
   `.env.local`. `T3CODE_MOBILE_IOS_TEAM_ID` is optional; leave it unset to select your
   Personal Team interactively in Xcode.
4. From `apps/mobile`, run `vp run config:personal` to confirm that `associatedDomains` and
   the `expo-widgets` plugin are absent.
5. Run `vp run ios:personal`. If Xcode requests a team, open `ios/T3Code.xcworkspace`, select
   the main T3Code target, choose **Signing & Capabilities → Team → your name (Personal
   Team)**, select your iPhone as the run destination, and press **Run** in Xcode. Do not run
   the clean prebuild command again after choosing the team, because it regenerates `ios/`.

The personal build uses the development bundle ID `dev.patroza.t3code.dev`, so it remains
separate from a future production build.

## Development

Start Metro for the dev client:

```bash
vp run dev:client
```

Build and run the local iOS dev client:

```bash
vp run ios:dev
```

If your Xcode account only has a Personal Team, use a bundle identifier you control and opt into the
reduced-capability local build. Personal Team builds omit the widget and share extensions, push
entitlement, and native Sign in with Apple entitlement; builds without this opt-in are unchanged.

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code.dev \
vp run ios:dev
```

Build and install a self-contained Release app that does not need Metro:

```bash
vp run ios:release
```

The Personal Team equivalent also needs a unique bundle identifier:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3code \
vp run ios:release
```

Build and run the local iOS preview app:

```bash
vp run ios:preview
```

Force the review diff highlighter engine:

```bash
EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=javascript vp run ios:dev
```

`javascript` is the default and recommended setting for the review diff screen. Set `EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when you explicitly want to test the native Shiki engine.

Inspect the resolved Expo config for a variant:

```bash
vp run config:dev
vp run config:preview
```

Run static checks for mobile native code:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The native lint task runs SwiftLint for Swift plus ktlint and detekt for Kotlin. Missing native tools are reported as warnings and skipped locally. CI installs the default toolset from `apps/mobile/Brewfile` before running the native checks.

## EAS Builds

CI uses Expo fingerprinting with the `preview:dev` profile to reuse an existing compatible build when possible, or start a new internal EAS build when native runtime inputs change. Production and default local builds continue to use the `appVersion` runtime policy.

For preview or production EAS environments, set `T3CODE_CLERK_PUBLISHABLE_KEY`,
`T3CODE_CLERK_JWT_TEMPLATE`, and `T3CODE_RELAY_URL`
as EAS environment variables. Expo config maps the canonical values into the mobile build.

Create a PR preview dev-client build manually:

```bash
vp run eas:ios:preview:dev
```

Create a cloud dev-client build:

```bash
vp run eas:ios:dev
```

Create a persistent preview build:

```bash
vp run eas:ios:preview
```

Android equivalents:

```bash
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```
