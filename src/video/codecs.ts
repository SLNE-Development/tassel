// Which video codecs a file format can carry, in order of preference, with codec strings that fit the
// picture size and frame rate. Pure: the encoder asks the browser which of them it can actually encode.
import type { VideoFormat } from '../core/video';

export interface CodecChoice {
  /** WebCodecs codec string, e.g. `avc1.640028`. */
  codec: string;
  /** What people call it. */
  name: 'H.264' | 'VP9' | 'VP8' | 'AV1';
  /** The codec's name for the muxer of the container. */
  mux: 'avc' | 'vp9' | 'av1' | 'V_VP9' | 'V_VP8' | 'V_AV1';
}

/** H.264 levels: [level_idc, most macroblocks per second, most macroblocks per picture]. */
const AVC_LEVELS: readonly (readonly [number, number, number])[] = [
  [30, 40_500, 1_620],
  [31, 108_000, 3_600],
  [32, 216_000, 5_120],
  [40, 245_760, 8_192],
  [42, 522_240, 8_704],
  [50, 589_824, 22_080],
  [51, 983_040, 36_864],
  [52, 2_073_600, 36_864],
  [60, 4_177_920, 139_264],
  [62, 16_711_680, 139_264],
];

/** The lowest H.264 level (level_idc, e.g. 40 for level 4.0) that allows this size and frame rate. */
export function avcLevel(width: number, height: number, fps: number): number {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  for (const [level, perSecond, perPicture] of AVC_LEVELS) {
    if (blocks <= perPicture && blocks * fps <= perSecond) return level;
  }
  return AVC_LEVELS[AVC_LEVELS.length - 1][0];
}

/** VP9 levels: [level x 10, most luma samples per second, most luma samples per picture]. */
const VP9_LEVELS: readonly (readonly [number, number, number])[] = [
  [10, 829_440, 36_864],
  [20, 4_608_000, 122_880],
  [30, 20_736_000, 552_960],
  [31, 36_864_000, 983_040],
  [40, 83_558_400, 2_228_224],
  [41, 160_432_128, 2_228_224],
  [50, 311_951_360, 8_912_896],
  [51, 588_251_136, 8_912_896],
  [52, 1_176_502_272, 8_912_896],
  [60, 1_176_502_272, 35_651_584],
  [62, 4_706_009_088, 35_651_584],
];

export function vp9Level(width: number, height: number, fps: number): number {
  const samples = width * height;
  for (const [level, perSecond, perPicture] of VP9_LEVELS) {
    if (samples <= perPicture && samples * fps <= perSecond) return level;
  }
  return VP9_LEVELS[VP9_LEVELS.length - 1][0];
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/**
 * The codecs to try for a format, best first. MP4: H.264 (High, Main, then Constrained Baseline profile),
 * which every player reads; if the system has no H.264 encoder, VP9 and AV1 also fit into MP4.
 * WebM: VP9, then VP8, then AV1.
 */
export function codecCandidates(format: VideoFormat, width: number, height: number, fps: number): CodecChoice[] {
  const vp9: Omit<CodecChoice, 'mux'> = { codec: `vp09.00.${vp9Level(width, height, fps)}.08`, name: 'VP9' };
  // Main profile, 8 bit; level 4.0 covers 1080p, 5.1 anything up to 4K.
  const av1: Omit<CodecChoice, 'mux'> = { codec: `av01.0.${width * height <= 2_228_224 ? '08' : '13'}M.08`, name: 'AV1' };
  if (format === 'webm') {
    return [
      { ...vp9, mux: 'V_VP9' },
      { codec: 'vp8', name: 'VP8', mux: 'V_VP8' },
      { ...av1, mux: 'V_AV1' },
    ];
  }
  // level_idc is the level times ten, written in hex (4.0 -> 40 = 0x28).
  const level = hex2(avcLevel(width, height, fps));
  const avc = (profile: string): CodecChoice => ({ codec: `avc1.${profile}${level}`, name: 'H.264', mux: 'avc' });
  return [avc('6400'), avc('4d00'), avc('42e0'), { ...vp9, mux: 'vp9' }, { ...av1, mux: 'av1' }];
}

/** The sentence that explains a codec that is not the format's first choice; null for the first choice. */
export function fallbackNote(format: VideoFormat, chosen: CodecChoice): string | null {
  const preferred = format === 'mp4' ? 'H.264' : 'VP9';
  if (chosen.name === preferred) return null;
  return format === 'mp4'
    ? `This system has no H.264 encoder, so the MP4 file was encoded as ${chosen.name}. Current browsers and players such as VLC read it; some older players and editing programs expect H.264.`
    : `This system has no VP9 encoder, so the WebM file was encoded as ${chosen.name}.`;
}
