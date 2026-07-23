import { GAME_CONFIG } from "../generated/game-config.generated.ts";
import type { WeaponClass } from "../../types.ts";

const config = GAME_CONFIG.sound.battle;

export const DEFAULT_BATTLE_SOUND_VOLUME: number = config.volume.default;
export const MIN_BATTLE_SOUND_VOLUME: number = config.volume.min;
export const MAX_BATTLE_SOUND_VOLUME: number = config.volume.max;
export const BATTLE_SAMPLE_PATHS = config.samples;
export type BattleSampleKey = keyof typeof BATTLE_SAMPLE_PATHS;
export const BATTLE_SAMPLE_URLS: Record<BattleSampleKey, string> = Object.fromEntries(
  Object.entries(BATTLE_SAMPLE_PATHS).map(([key, path]) => [key, `/assets/audio/${path}`]),
) as Record<BattleSampleKey, string>;
export const FIRE_SAMPLE_KEYS = config.firePools as Record<WeaponClass, readonly BattleSampleKey[]>;
export const FIRE_SAMPLE_RATE = config.firePlaybackRates as Record<WeaponClass, number>;
export const BATTLE_SPATIAL_AUDIO_CONFIG = config.spatial;
export const BATTLE_SYNTH_AUDIO_CONFIG = config.synth;
