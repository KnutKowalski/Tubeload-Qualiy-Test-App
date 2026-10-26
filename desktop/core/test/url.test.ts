import { test } from "node:test";
import assert from "node:assert/strict";

import {
  channelVideosUrl,
  detectUrlKind,
  isAllowedYouTubeUrl,
  startUrlFor,
  toWatchPlaylistUrl,
  videoIdOf,
} from "../src/url";

test("isAllowedYouTubeUrl erlaubt nur https auf YouTube-Hosts", () => {
  for (const ok of [
    "https://www.youtube.com/watch?v=abc",
    "https://youtube.com/@name",
    "https://m.youtube.com/watch?v=abc",
    "https://music.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
  ]) {
    assert.equal(isAllowedYouTubeUrl(ok), true, ok);
  }

  for (const bad of [
    "http://www.youtube.com/watch?v=abc",
    "file:///etc/passwd",
    "https://evil.example/watch?v=abc",
    "https://www.youtube.com.evil.example/watch?v=abc",
    "https://user:pw@www.youtube.com/watch?v=abc",
    "https://www.youtube.com:8443/watch?v=abc",
    "http://169.254.169.254/latest/meta-data",
    "javascript:alert(1)",
    "not a url",
    "",
  ]) {
    assert.equal(isAllowedYouTubeUrl(bad), false, bad);
  }
});

test("detectUrlKind", () => {
  assert.equal(detectUrlKind("https://www.youtube.com/watch?v=abc"), "video");
  assert.equal(detectUrlKind("https://youtu.be/abc"), "video");
  assert.equal(detectUrlKind("https://www.youtube.com/shorts/abc"), "video");
  assert.equal(detectUrlKind("https://www.youtube.com/playlist?list=PL1"), "playlist");
  assert.equal(detectUrlKind("https://www.youtube.com/watch?v=abc&list=PL1"), "playlist");
  assert.equal(detectUrlKind("https://www.youtube.com/@name"), "channel");
  assert.equal(
    detectUrlKind("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"),
    "channel"
  );
  assert.equal(detectUrlKind("https://www.youtube.com/"), "unknown");
  assert.equal(detectUrlKind("garbage"), "unknown");
  assert.equal(detectUrlKind("https://www.youtube.com/@name", "video"), "video");
});

test("channelVideosUrl verwirft Query/Fragment (Teilen-Link mit ?si=)", () => {
  assert.equal(
    channelVideosUrl("https://www.youtube.com/@SomeChannel?si=abc123"),
    "https://www.youtube.com/@SomeChannel/videos"
  );
  assert.equal(
    channelVideosUrl("https://www.youtube.com/@SomeChannel/"),
    "https://www.youtube.com/@SomeChannel/videos"
  );
  assert.equal(
    channelVideosUrl("https://www.youtube.com/@SomeChannel/videos?x=1#frag"),
    "https://www.youtube.com/@SomeChannel/videos"
  );
  assert.throws(() => channelVideosUrl("kaputt"));
});

test("videoIdOf und toWatchPlaylistUrl", () => {
  assert.equal(videoIdOf("https://www.youtube.com/watch?v=abc&list=x"), "abc");
  assert.equal(videoIdOf("https://youtu.be/xyz?t=3"), "xyz");
  assert.equal(videoIdOf("https://www.youtube.com/shorts/s1"), "s1");
  assert.equal(videoIdOf("https://www.youtube.com/playlist?list=x"), null);
  assert.equal(
    toWatchPlaylistUrl("PL 1", 1),
    "https://www.youtube.com/watch?list=PL%201&index=1"
  );
});

test("startUrlFor: nur die Playlist-Übersicht wird zur Wiedergabeseite, alles andere bleibt", () => {
  assert.equal(
    startUrlFor("https://www.youtube.com/playlist?list=PLabc", "playlist"),
    "https://www.youtube.com/watch?list=PLabc&index=1"
  );
  assert.equal(
    startUrlFor("https://music.youtube.com/playlist?list=OLAK5uy_x&si=1", "playlist"),
    "https://www.youtube.com/watch?list=OLAK5uy_x&index=1"
  );

  for (const [u, kind] of [
    ["https://www.youtube.com/watch?v=abc&list=PLabc", "playlist"],
    ["https://www.youtube.com/watch?list=PLabc", "playlist"],
    ["https://www.youtube.com/playlist", "playlist"],
    ["https://www.youtube.com/playlist?list=PLabc", "video"],
    ["https://www.youtube.com/@name", "channel"],
    ["kein url", "playlist"],
  ] as const) {
    assert.equal(startUrlFor(u, kind), u, `${kind} ${u}`);
  }
});

test("detectUrlKind: Kurz-/Shorts-/Embed-Adressen ohne Video-ID sind nicht abspielbar", () => {
  assert.equal(detectUrlKind("https://youtu.be/abcdefghijk"), "video");
  assert.equal(detectUrlKind("https://www.youtube.com/shorts/abcdefghijk"), "video");
  assert.equal(detectUrlKind("https://www.youtube.com/embed/abcdefghijk"), "video");

  for (const u of ["https://youtu.be", "https://youtu.be/", "https://www.youtube.com/shorts/", "https://www.youtube.com/embed/"]) {
    assert.equal(detectUrlKind(u), "unknown", u);
  }
});
