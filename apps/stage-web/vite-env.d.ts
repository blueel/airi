/// <reference types="vite/client" />
/// <reference types="../../vite-env.d.ts" />

interface ImportMetaEnv {
  readonly VITE_APP_TARGET_HUGGINGFACE_SPACE: string
  /** Pre-fills the DeepSeek provider so a fresh browser profile can chat immediately. */
  readonly VITE_DEFAULT_DEEPSEEK_API_KEY?: string
  readonly VITE_DEFAULT_DEEPSEEK_BASE_URL?: string
  readonly VITE_DEFAULT_DEEPSEEK_MODEL?: string
  /** Seeds the local Breeze-TTS-2 speech provider so a fresh profile can speak. */
  readonly VITE_DEFAULT_BREEZE_TTS?: string
  /** Seeds a local Ollama chat provider pointing at the machine-local server. */
  readonly VITE_DEFAULT_OLLAMA?: string
  readonly VITE_DEFAULT_OLLAMA_BASE_URL?: string
  readonly VITE_DEFAULT_OLLAMA_MODEL?: string
  /** Makes the seeded Ollama provider the active chat selection. */
  readonly VITE_DEFAULT_OLLAMA_ACTIVE?: string
  // more env variables...
}
