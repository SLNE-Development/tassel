// The WebM muxer writes the START time of the last picture as the length of the file, so a video of
// 72 frames at 24 fps would claim 2.958 s instead of 3 s. This puts the real length into the header.

/** EBML id of Segment > Info > Duration, followed by the size byte of an 8-byte float. */
const DURATION = [0x44, 0x89, 0x88];
/** The header (EBML head, seek head, segment info) sits at the very start of the file. */
const SEARCH_BYTES = 4096;

/**
 * Sets the duration in the header of a WebM file to `milliseconds` (the muxer's time scale is 1 ms).
 * Only done if the field is found and holds what the muxer is known to write (a value in the last
 * frame's time, i.e. a little less than the real length); otherwise the file is left as it is.
 * Returns whether the header was changed.
 */
export function fixWebmDuration(buffer: ArrayBuffer, milliseconds: number, frameMilliseconds: number): boolean {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const end = Math.min(bytes.length - 11, SEARCH_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] !== DURATION[0] || bytes[i + 1] !== DURATION[1] || bytes[i + 2] !== DURATION[2]) continue;
    const written = view.getFloat64(i + 3);
    if (!(written >= 0) || written > milliseconds || milliseconds - written > frameMilliseconds + 1) continue;
    view.setFloat64(i + 3, milliseconds);
    return true;
  }
  return false;
}
