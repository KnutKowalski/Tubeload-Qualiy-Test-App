export function qaPageScript() {
  const w = window as any;

  if (w.__qa) return;

  const getVideo = () => document.querySelector("video");
  const getPlayer = () => document.getElementById("movie_player") as any;

  const qualityMap: Record<string, string> = {
    auto: "default",
    "144p": "tiny",
    "240p": "small",
    "360p": "medium",
    "480p": "large",
    "720p": "hd720",
    "1080p": "hd1080",
    "1440p": "hd1440",
    "2160p": "hd2160",
  };

  w.__qa = {
    stalls: 0,
    errors: 0,
    state: "idle",
    hooked: new WeakSet(),

    hook() {
      const v = getVideo();
      if (!v || this.hooked.has(v)) return;

      this.hooked.add(v);

      v.addEventListener("waiting", () => {
        this.stalls++;
        this.state = "buffering";
      });

      v.addEventListener("playing", () => {
        this.state = "playing";
      });

      v.addEventListener("pause", () => {
        if (!v.ended) this.state = "paused";
      });

      v.addEventListener("ended", () => {
        this.state = "ended";
      });

      v.addEventListener("error", () => {
        this.errors++;
        this.state = "error";
      });
    },

    available() {
      const player = getPlayer();
      try {
        return player?.getAvailableQualityLevels?.() ?? [];
      } catch {
        return [];
      }
    },

    setQuality(label: string) {
      const player = getPlayer();
      const q = qualityMap[label] ?? label;

      try {
        player?.setPlaybackQuality?.(q);
      } catch {}

      try {
        player?.setPlaybackQualityRange?.(q, q);
      } catch {}
    },

    stats() {
      this.hook();

      const v = getVideo();
      if (!v) return null;

      const q =
        typeof v.getVideoPlaybackQuality === "function"
          ? v.getVideoPlaybackQuality()
          : null;

      const player = getPlayer();

      const quality =
        (v as any).playbackQuality ||
        player?.getPlaybackQuality?.() ||
        "";

      return {
        currentTime: v.currentTime,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        paused: v.paused,
        ended: v.ended,
        readyState: v.readyState,
        bufferedAhead: v.buffered.length
          ? Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime)
          : 0,
        quality,
        droppedFrames: q?.droppedVideoFrames ?? 0,
        totalFrames: q?.totalVideoFrames ?? 0,
        corruptionFrames: q?.corruptedVideoFrames ?? 0,
        stalls: this.stalls,
        errors: this.errors,
        state: this.state,
      };
    },

    play() {
      getVideo()?.play().catch(() => {});
    },

    pause() {
      getVideo()?.pause();
    },

    seekBy(delta: number) {
      const v = getVideo();
      if (!v) return;

      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const next = Math.min(
        Math.max(0, v.currentTime + delta),
        Math.max(0, dur - 0.5)
      );

      v.currentTime = next;
    },
  };

  setInterval(() => {
    w.__qa.hook();
  }, 1000);
}
