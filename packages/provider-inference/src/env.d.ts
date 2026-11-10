// Build-time values that the host app passes through Vite. The package ships no
// public endpoint, so every value is optional and each default is local.
interface ImportMetaEnv {
  readonly VITE_AIRI_BREEZE_TTS_URL?: string
  readonly VITE_AIRI_FUNASR_URL?: string
  readonly VITE_AIRI_QWEN_TOKEN_PLAN_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
