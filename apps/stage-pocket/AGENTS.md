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
4. Run `cap sync android`.
5. Build `assembleRelease`.
6. Sign the APK with `D:\Android\keys\airi-pocket.jks`.
7. Generate release notes from the commits since the last published build.
8. Publish the APK and update `latest.json`.
9. Update `E:\note\notes\内网穿透服务清单.md`.
10. Check the public manifest.

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
- `android/app/src/main/java/ai/moeru/airi_pocket/AppUpdaterPlugin.kt`: native update check and install.
- `src/pages/settings/system/update.vue`: update page.
