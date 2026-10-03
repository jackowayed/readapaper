declare module "mespeak" {
  const mespeak: {
    speak(text: string, opts?: Record<string, unknown>): unknown;
    loadConfig(data: unknown): void;
    loadVoice(data: unknown): void;
    isConfigLoaded(): boolean;
    isVoiceLoaded(voice?: string): boolean;
  };
  export default mespeak;
}
