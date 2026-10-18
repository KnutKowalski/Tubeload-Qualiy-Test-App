/**
 * Läuft IM Browser (wird per addInitScript in jede Seite injiziert) und
 * misst das <video>-Element. Die Funktion muss vollständig eigenständig sein,
 * da Playwright sie als Text serialisiert.
 *
 * Wichtig: Der Zustand wird aus dem Video-Element abgeleitet (paused, ended,
 * readyState, seeking) und nicht aus dem Event-Verlauf. So bleibt er auch dann
 * korrekt, wenn die Wiedergabe schon lief, bevor der Hook angehängt wurde.
 */
export function qaPageScript(): void {
  const w = window as any;

  if (w.__qa) return;

  const getVideo = (): HTMLVideoElement | null =>
    document.querySelector("video");
  const getPlayer = (): any => document.getElementById("movie_player");

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

  const qa = {
    errors: 0,
    stalls: 0,
    stallMs: 0,
    stallStart: 0,
    startupMs: -1,
    everPlayed: false,
    hooked: null as HTMLVideoElement | null,
  };

  // Beendet einen laufenden Stall. keep=false verwirft ihn (Seek/Pause sind
  // keine Rebuffering-Ereignisse).
  const closeStall = (keep: boolean): void => {
    if (!qa.stallStart) return;

    if (keep) {
      qa.stallMs += performance.now() - qa.stallStart;
    } else {
      qa.stalls = Math.max(0, qa.stalls - 1);
    }

    qa.stallStart = 0;
  };

  const hook = (): void => {
    const v = getVideo();

    if (!v || qa.hooked === v) return;

    qa.hooked = v;
    qa.everPlayed = !v.paused && v.readyState >= 3 && v.currentTime > 0;

    v.addEventListener("loadstart", () => {
      qa.everPlayed = false;
      closeStall(false);
    });

    // Initiales Puffern (everPlayed=false) und Seeks zählen nicht als Stall.
    v.addEventListener("waiting", () => {
      if (!qa.everPlayed || v.seeking || qa.stallStart) return;

      qa.stalls++;
      qa.stallStart = performance.now();
    });

    v.addEventListener("playing", () => {
      closeStall(true);

      if (!qa.everPlayed) {
        qa.everPlayed = true;

        if (qa.startupMs < 0) {
          qa.startupMs = Math.round(performance.now());
        }
      }
    });

    v.addEventListener("seeking", () => closeStall(false));
    v.addEventListener("pause", () => closeStall(false));
    v.addEventListener("ended", () => closeStall(false));

    v.addEventListener("error", () => {
      qa.errors++;
    });
  };

  const computeState = (v: HTMLVideoElement): string => {
    if (v.error) return "error";
    if (v.ended) return "ended";
    if (v.seeking) return "buffering";
    if (v.paused) return "paused";
    if (v.readyState < 3) return "buffering";
    return "playing";
  };

  w.__qa = {
    hook,

    stats() {
      hook();

      const v = getVideo();
      if (!v) return null;

      const t = v.currentTime;

      // Puffer VOR der aktuellen Position: der Bereich, der currentTime enthält
      // (nicht einfach der letzte Bereich – nach Seeks gibt es mehrere).
      let ahead = 0;

      for (let i = 0; i < v.buffered.length; i++) {
        const start = v.buffered.start(i);
        const end = v.buffered.end(i);

        if (t >= start - 0.1 && t <= end) {
          ahead = Math.max(0, end - t);
          break;
        }
      }

      const pq =
        typeof v.getVideoPlaybackQuality === "function"
          ? v.getVideoPlaybackQuality()
          : null;

      const ongoingStall = qa.stallStart
        ? performance.now() - qa.stallStart
        : 0;

      return {
        currentTime: t,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        paused: v.paused,
        ended: v.ended,
        readyState: v.readyState,
        bufferedAhead: ahead,
        width: v.videoWidth,
        height: v.videoHeight,
        droppedFrames: pq?.droppedVideoFrames ?? 0,
        totalFrames: pq?.totalVideoFrames ?? 0,
        stalls: qa.stalls,
        stallMs: Math.round(qa.stallMs + ongoingStall),
        startupMs: qa.startupMs,
        errors: qa.errors,
        state: computeState(v),
        ad: !!getPlayer()?.classList?.contains("ad-showing"),
      };
    },

    play() {
      getVideo()
        ?.play()
        .catch(() => {});
    },

    // Best effort: YouTube hat die Qualitäts-API 2019 abgekündigt (No-op).
    // Die tatsächliche Auflösung steht deshalb immer in stats().height.
    setQuality(label: string) {
      const player = getPlayer();
      const q = qualityMap[label] ?? label;

      try {
        player?.setPlaybackQualityRange?.(q, q);
      } catch {}

      try {
        player?.setPlaybackQuality?.(q);
      } catch {}
    },
  };

  // Sobald das <video>-Element im DOM erscheint, sofort einhängen. Allein das
  // 1-s-Intervall würde das erste "playing"-Ereignis (Startzeit) verpassen,
  // wenn die Wiedergabe per Autoplay sofort beginnt.
  try {
    new MutationObserver(() => hook()).observe(document, {
      childList: true,
      subtree: true,
    });
  } catch {
    // Beobachter nicht verfügbar – das Intervall bleibt als Rückfall.
  }

  setInterval(hook, 1000);
}
