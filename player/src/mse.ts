/**
 * mse.ts — MediaSource streaming for the transcoded fMP4.
 *
 * The server streams a *live* fragmented MP4 (ffmpeg `+empty_moov`), so the
 * `moov` written at the front of the stream declares a duration of 0 — the
 * browser only learns the real length once the whole stream has downloaded.
 * That breaks two things with a plain `<video src>`:
 *   1. Safari refuses to play a chunked `video/mp4` that has no known duration
 *      and no HTTP range support — it never starts.
 *   2. Chrome/Firefox only fill the seek bar as bytes arrive, so the scrubber
 *      doesn't reach the movie's real length until playback is fully buffered.
 *
 * We already know each title's true duration from the IFO. MediaSource lets us
 * fetch the transcoded bytes ourselves (no HTTP range support required — which
 * is what Safari's native <video> demands) and set `duration` explicitly up
 * front, so the seek bar shows the full length immediately on every browser.
 */

import { parseInitSegmentCodecs, type CodecInfo } from "./mp4-codec";

// Capability probe only. MediaSource — Safari especially — rejects a codec
// string that doesn't match the actual bitstream, so we don't declare a fixed
// codec: the real one is derived from the init segment at stream time (see
// onSourceOpen). This string just answers "can this browser MSE-decode the
// H.264 High\@4.0 + AAC-LC the server normally produces?" for support detection.
const PROBE_MIME = 'video/mp4; codecs="avc1.640028, mp4a.40.2"';

// Title buffer window (seconds). We can't hold a two-hour movie in memory, so
// we keep a bounded window around the playhead: pause fetching once we're
// MAX_AHEAD buffered ahead of currentTime (network back-pressure throttles the
// server transcode too), and drop data more than KEEP_BEHIND behind it.
const MAX_AHEAD = 30;
const KEEP_BEHIND = 20;

interface MediaSourceLike extends EventTarget {
  readyState: string;
  duration: number;
  addSourceBuffer(type: string): SourceBuffer;
  endOfStream(reason?: string): void;
}

interface MediaSourceCtor {
  isTypeSupported(type: string): boolean;
  new (): MediaSourceLike;
}

/**
 * Resolve the MediaSource constructor to use. ManagedMediaSource (Safari 17+
 * and iOS) is preferred when present — it's required on iOS and drives append
 * timing via startstreaming/endstreaming events.
 */
function mediaSourceCtor(): { ctor: MediaSourceCtor; managed: boolean } | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    ManagedMediaSource?: MediaSourceCtor;
    MediaSource?: MediaSourceCtor;
  };
  if (w.ManagedMediaSource?.isTypeSupported(PROBE_MIME)) {
    return { ctor: w.ManagedMediaSource, managed: true };
  }
  if (w.MediaSource?.isTypeSupported(PROBE_MIME)) {
    return { ctor: w.MediaSource, managed: false };
  }
  return null;
}

/** Whether MediaSource playback of the transcoded fMP4 is available. */
export function mseSupported(): boolean {
  return mediaSourceCtor() !== null;
}

export interface MseOptions {
  /** Best-estimate media duration in seconds, shown on the seek bar up front. */
  durationHintSec?: number;
  /**
   * Keep the entire stream buffered (no ahead-cap, no eviction). Used for
   * menus, which are short and loop over their whole range.
   */
  keepAll?: boolean;
  onLog?: (msg: string) => void;
  /**
   * Called if MSE setup or streaming fails. The session uses this to fall back
   * to a native `<video src>` when playback hasn't started yet.
   */
  onError?: (err: unknown) => void;
}

/**
 * Streams a transcode URL into a <video> element via MediaSource, setting the
 * duration up front. One instance owns one playback; call `destroy()` before
 * starting another.
 */
export class MseSource {
  private readonly video: HTMLVideoElement;
  private readonly ms: MediaSourceLike;
  private readonly ctor: MediaSourceCtor;
  private readonly managed: boolean;
  private readonly objectUrl: string;
  private readonly opts: MseOptions;
  private readonly ac = new AbortController();
  private sb: SourceBuffer | null = null;
  private destroyed = false;
  // ManagedMediaSource append gating. Plain MediaSource stays true throughout.
  private streaming = true;
  private wakeResolvers: Array<() => void> = [];

  constructor(video: HTMLVideoElement, url: string, opts: MseOptions) {
    const sel = mediaSourceCtor();
    if (!sel) throw new Error("MediaSource not supported");

    this.video = video;
    this.opts = opts;
    this.managed = sel.managed;
    this.ctor = sel.ctor;
    this.ms = new sel.ctor();
    this.objectUrl = URL.createObjectURL(this.ms as unknown as MediaSource);

    if (this.managed) {
      // ManagedMediaSource requires remote playback to be disabled and drives
      // fetching via streaming events.
      this.video.disableRemotePlayback = true;
      this.ms.addEventListener("startstreaming", () => {
        this.streaming = true;
        this.wake();
      });
      this.ms.addEventListener("endstreaming", () => {
        this.streaming = false;
      });
    }

    this.ms.addEventListener("sourceopen", () => void this.onSourceOpen(url), { once: true });

    // Re-check append conditions whenever the playhead or buffer state moves.
    this.video.addEventListener("timeupdate", this.onWake);
    this.video.addEventListener("seeking", this.onWake);

    this.video.src = this.objectUrl;
  }

  private log(msg: string) {
    this.opts.onLog?.(msg);
  }

  private onWake = () => this.wake();

  /** Release everything waiting on `nextWake()`. */
  private wake() {
    const resolvers = this.wakeResolvers;
    this.wakeResolvers = [];
    for (const r of resolvers) r();
  }

  private nextWake(): Promise<void> {
    return new Promise((resolve) => this.wakeResolvers.push(resolve));
  }

  private async onSourceOpen(url: string) {
    if (this.destroyed) return;
    try {
      const res = await fetch(url, { signal: this.ac.signal });
      if (!res.ok || !res.body) {
        throw new Error(`transcode fetch failed: ${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();

      // Read just enough of the stream to see the whole init segment (moov),
      // then derive the exact codec string from it. This keeps the SourceBuffer
      // MIME in lockstep with the actual bitstream with no hard-coded value to
      // drift out of sync with the server's ffmpeg flags.
      const prefix: Uint8Array[] = [];
      let prefixLen = 0;
      let codecs: CodecInfo | null = null;
      const INIT_CAP = 1 << 18; // 256 KiB — moov is a few KB; bail if we blow past
      while (!codecs) {
        const { done, value } = await reader.read();
        if (this.destroyed) {
          await reader.cancel().catch(() => {});
          return;
        }
        if (done) break;
        if (value && value.length) {
          prefix.push(value);
          prefixLen += value.length;
          codecs = parseInitSegmentCodecs(concat(prefix, prefixLen));
        }
        if (!codecs && prefixLen > INIT_CAP) break;
      }
      if (!codecs) throw new Error("could not derive codec string from init segment");
      if (!this.ctor.isTypeSupported(codecs.mime)) {
        throw new Error(`codec not supported by MediaSource: ${codecs.mime}`);
      }
      this.log(`MSE codec: ${codecs.mime}`);

      const sb = this.ms.addSourceBuffer(codecs.mime);
      this.sb = sb;
      sb.addEventListener("updateend", this.onWake);

      if (this.opts.durationHintSec && this.opts.durationHintSec > 0) {
        // Best-estimate duration so the seek bar shows full length right away.
        // endOfStream() later snaps it to the true buffered length.
        try {
          this.ms.duration = this.opts.durationHintSec;
        } catch {
          /* duration is refined on endOfStream */
        }
      }

      // Feed the bytes we buffered while sniffing, then stream the rest.
      await this.append(concat(prefix, prefixLen));
      await this.pump(reader);
    } catch (err) {
      if (this.destroyed || this.ac.signal.aborted) return;
      this.log(`MSE error: ${String(err)}`);
      this.opts.onError?.(err);
    }
  }

  /** Bytes currently buffered ahead of the playhead. */
  private bufferedAhead(): number {
    const { buffered, currentTime } = this.video;
    for (let i = 0; i < buffered.length; i++) {
      if (currentTime >= buffered.start(i) - 0.25 && currentTime <= buffered.end(i)) {
        return buffered.end(i) - currentTime;
      }
    }
    return 0;
  }

  private canAppendNow(): boolean {
    if (this.destroyed) return true; // let the pump exit
    if (!this.streaming) return false;
    if (this.sb?.updating) return false;
    if (this.opts.keepAll) return true;
    return this.bufferedAhead() < MAX_AHEAD;
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>) {
    for (;;) {
      // Wait until we're allowed to fetch/append more. The timeout is a safety
      // net so we re-poll even if no wake event fires.
      while (!this.canAppendNow()) {
        await Promise.race([this.nextWake(), this.sleep(250)]);
      }
      if (this.destroyed) {
        await reader.cancel().catch(() => {});
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) await this.append(value);
      await this.maybeEvict();
    }

    // Stream finished — signal end so `ended` fires and duration snaps to the
    // true buffered length.
    if (!this.destroyed && this.ms.readyState === "open") {
      await this.waitIdle();
      try {
        this.ms.endOfStream();
      } catch {
        /* already ended / closed */
      }
    }
  }

  /** Append one chunk, retrying once on quota pressure after evicting. */
  private async append(data: Uint8Array) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.appendOnce(data);
        return;
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === "QuotaExceededError" && attempt < 3 && !this.opts.keepAll) {
          this.log("MSE buffer full — evicting and retrying");
          await this.evictBehind(/* aggressive */ true);
          await Promise.race([this.nextWake(), this.sleep(250)]);
          continue;
        }
        throw err;
      }
    }
  }

  private appendOnce(data: Uint8Array): Promise<void> {
    const sb = this.sb!;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        sb.removeEventListener("updateend", onEnd);
        sb.removeEventListener("error", onErr);
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error("SourceBuffer error during append"));
      };
      sb.addEventListener("updateend", onEnd);
      sb.addEventListener("error", onErr);
      try {
        sb.appendBuffer(data as BufferSource);
      } catch (err) {
        cleanup();
        // Preserve the original DOMException (e.g. QuotaExceededError) so the
        // caller can branch on err.name to evict-and-retry.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(err);
      }
    });
  }

  private async maybeEvict() {
    if (this.opts.keepAll) return;
    await this.evictBehind(false);
  }

  private async evictBehind(aggressive: boolean) {
    const sb = this.sb;
    if (!sb || sb.updating) return;
    const keepBehind = aggressive ? KEEP_BEHIND / 2 : KEEP_BEHIND;
    const cutoff = this.video.currentTime - keepBehind;
    if (cutoff <= 0) return;
    const { buffered } = sb;
    if (buffered.length === 0 || buffered.start(0) >= cutoff) return;
    await new Promise<void>((resolve) => {
      const onEnd = () => {
        sb.removeEventListener("updateend", onEnd);
        resolve();
      };
      sb.addEventListener("updateend", onEnd);
      try {
        sb.remove(buffered.start(0), cutoff);
      } catch {
        sb.removeEventListener("updateend", onEnd);
        resolve();
      }
    });
  }

  private waitIdle(): Promise<void> {
    const sb = this.sb;
    if (!sb || !sb.updating) return Promise.resolve();
    return new Promise((resolve) => {
      const onEnd = () => {
        sb.removeEventListener("updateend", onEnd);
        resolve();
      };
      sb.addEventListener("updateend", onEnd);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Tear down: abort the fetch, detach listeners, release the object URL. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ac.abort();
    this.wake();
    this.video.removeEventListener("timeupdate", this.onWake);
    this.video.removeEventListener("seeking", this.onWake);
    this.sb?.removeEventListener("updateend", this.onWake);
    try {
      URL.revokeObjectURL(this.objectUrl);
    } catch {
      /* already revoked */
    }
  }
}

/** Concatenate buffered chunks into one contiguous Uint8Array. */
function concat(chunks: Uint8Array[], totalLen: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
