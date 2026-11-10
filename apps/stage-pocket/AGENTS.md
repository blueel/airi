# stage-pocket Agent Notes

Scope: `apps/stage-pocket/**`

## Android Release Updates

The phone installs updates through the in-app updater. Each phone build must be release-signed and published.

### Build and Publish

Run this command for each phone build:

```sh
node D:\AI\airi-updates\build-and-publish.mjs
```

You can also run `D:\AI\airi-updates\build-and-publish.cmd`.

The script runs these steps:

1. Increase `AIRI_VERSION_CODE` and the last part of `AIRI_VERSION_NAME`.
2. Clear `dist` and `android/app/src/main/assets/public`.
3. Build the web app with `HF_ENDPOINT=https://hf-mirror.com`.
4. Write `dist/bundle-index.json` with the hash of every page file.
5. Run `cap sync android`.
6. Build `assembleRelease`.
7. Sign the APK with `D:\Android\keys\airi-pocket.jks`.
8. Generate release notes from the commits since the last published build.
9. Publish the APK and update `latest.json`.
10. Publish the same pages as an over-the-air bundle in `bundles/<version>-<code>/`, and sign its index.
11. Update `E:\note\notes\内网穿透服务清单.md`.
12. Check the public manifest.

The script reads the alias and password from `D:\Android\keys\airi-pocket-keystore.txt`.

Pass `--notes "<text>"` to replace the generated notes for one build.
Write each change on its own line. Start each line with `- `.

### Update Rules

The updater compares `versionCode` and the signing certificate.

- Increase `AIRI_VERSION_CODE` for each published build. The script does this.
- Keep the signing certificate stable. Otherwise the phone rejects the update.
- Keep the signing key. A lost key blocks all future in-place updates.
- Do not publish an APK that the script did not sign and check.
- Do not install a debug APK on the phone. Android rejects it over the release app.
- Use `airi-pocket-release.apk` for a manual phone install.
- Install the first release build by hand. Then the in-app updater works.
- Commit the change in `android/app-version.properties` with the code that you build.

### Endpoints

- Update directory: `D:\AI\airi-updates`
- Local server: `http://127.0.0.1:9320`
- Public manifest: `http://airi.example/latest.json`
- Signing certificate: `9C:64:42:70:...:57:14` (`CN=AIRI Pocket`)

### Update Code

- `src/modules/app-updater.ts`: manifest URL and plugin interface.
- `src/modules/bundle-updater.ts`: page bundle state, the quiet check after launch, and the health report.
- `android/app/src/main/java/ai/moeru/airi_pocket/AppUpdaterPlugin.kt`: native update check and install.
- `android/app/src/main/java/ai/moeru/airi_pocket/BundleUpdater.kt`: page bundles: signed index, file diff, apply and rollback.
- `scripts/make-bundle-index.mjs`: writes `dist/bundle-index.json` before `cap sync`.
- `src/pages/settings/system/update.vue`: update page.

## Page Updates (no APK)

A page update ships the same `dist` without a new APK. The phone copies the files whose hash already matches and
downloads only the rest, so a typical update is a few megabytes instead of 90 MB.

- `latest.json` carries a `bundle` block: release id, `nativeVersion`, the index URL, and an RSA signature of the index.
- `BundleUpdater.PUBLIC_KEY` must match `D:\AI\airi-updates\bundle-signing-key.pem`. Without the key, no page update
  can be published, and without the matching public key in the APK no phone accepts one.
- `nativeVersion` is the lowest `AIRI_VERSION_CODE` that can run the bundle. Raise it only when the change needs new
  native code, and rebuild the APK for it.
- A bundle that never reports health is dropped on the next start and the app goes back to the bundle before it, or to
  the pages in the APK. `bridge.setServerBasePath` does the switch, and `Bridge.isNewBinary` resets it after an APK
  update.
- The page bundle replaces `assets/public` only. Native plugins, permissions, and `AndroidManifest.xml` still need an
  APK, and iOS has no such path because App Store rules forbid downloading code that changes the app.
