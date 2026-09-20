/**
 * Turn a <video> failure into something worth reading.
 *
 * Both players used to render a bare <video> with no error handling, so
 * anything Chromium refused to decode — a half-written file, a container it
 * does not support, media deleted from under the library — showed up as a
 * black rectangle that never started. That is indistinguishable from "this app
 * is broken", which is roughly how it got reported.
 */
export function describeMediaError(err: MediaError | null): string {
  switch (err?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'playback was stopped before it started'
    case MediaError.MEDIA_ERR_NETWORK:
      return 'the file could not be read — has it been moved or deleted?'
    case MediaError.MEDIA_ERR_DECODE:
      return 'this file is damaged partway through — try adding it again'
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'nothing here can play this file — it may be an unfinished download'
    default:
      return 'this edit would not play'
  }
}
