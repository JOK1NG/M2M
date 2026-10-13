import assert from "node:assert/strict";
import test from "node:test";

import { createSongMatcher } from "../src/matching.js";

const matcher = createSongMatcher();
const song = (id, name, artistName, extra = {}) => ({
  id, type: "songs", attributes: { name, artistName, durationInMillis: 194120, albumName: "Album", ...extra }
});
const track = (name, artists, extra = {}) => ({ name, artists, album: "Album", durationMs: 194120, ...extra });

test("normalizes full-width Latin, decomposed Hangul and accented Latin without losing Japanese voicing", () => {
  assert.equal(matcher.normalizeText("ＧＵＭＩ"), "gumi");
  assert.equal(matcher.normalizeText("가".normalize("NFD")), matcher.normalizeText("가"));
  assert.equal(matcher.normalizeText("Beyoncé"), "beyonce");
  assert.notEqual(matcher.normalizeText("ガ"), matcher.normalizeText("カ"));
});

test("uses source aliases and keeps title-only fallback queries", () => {
  const source = track("生きていたんだよな", ["あいみょん"], {
    aliases: ["Ikiteitandayona"], artistAliases: ["爱缪"]
  });
  assert.ok(matcher.buildSearchQueries(source).includes("生きていたんだよな"));
  assert.ok(matcher.buildSearchQueries(source).some(query => query.includes("Ikiteitandayona")));
  assert.equal(matcher.scoreCandidates(source, [song("cn", "Ikiteitandayona", "爱缪")]).id, "cn");
});

test("recognizes native catalog regions for Japanese, Korean and Cyrillic metadata", () => {
  assert.deepEqual(matcher.nativeStorefronts(track("生きていたんだよな", ["あいみょん"])), ["jp"]);
  assert.deepEqual(matcher.nativeStorefronts(track("봄날", ["방탄소년단"])), ["kr"]);
  assert.deepEqual(matcher.nativeStorefronts(track("Группа крови", ["Кино"])), ["ru"]);
});

for (const example of [
  { native: "jp", name: "生きていたんだよな", artist: "あいみょん", translated: "Ikiteitandayona", translatedArtist: "爱缪" },
  { native: "kr", name: "봄날", artist: "방탄소년단", translated: "Spring Day", translatedArtist: "BTS" },
  { native: "ru", name: "Группа крови", artist: "Кино", translated: "Gruppa Krovi", translatedArtist: "Kino" }
]) {
  test("resolves " + example.native + " titles to the target catalog using verified ISRC", async () => {
    const isrc = "JPWP01671360";
    const source = track(example.name, [example.artist]);
    const calls = [];
    const result = await matcher.match(source, {
      storefront: "cn",
      search: async (storefront, query) => {
        calls.push({ storefront, query });
        return storefront === "cn"
          ? [song("cn-song", example.translated, example.translatedArtist, { isrc })]
          : [song("native-song", example.name, example.artist, { isrc })];
      },
      resolveIsrc: async (storefront, isrcs) => {
        assert.equal(storefront, "cn");
        assert.deepEqual(isrcs, [isrc]);
        return [song("cn-song", example.translated, example.translatedArtist, { isrc })];
      }
    });
    assert.equal(result.id, "cn-song");
    assert.equal(result.matchMethod, "isrc");
    assert.ok(calls.some(call => call.storefront === example.native));
  });
}

test("never imports a native-region ID if the recording is unavailable in the target region", async () => {
  const result = await matcher.match(track("生きていたんだよな", ["あいみょん"]), {
    storefront: "cn",
    search: async storefront => storefront === "jp" ? [song("jp-only", "生きていたんだよな", "あいみょん", { isrc: "JPWP01671360" })] : [],
    resolveIsrc: async () => []
  });
  assert.equal(result, null);
});

test("does not trust an unrelated recording returned by an ISRC resolver", async () => {
  const result = await matcher.match(track("生きていたんだよな", ["あいみょん"]), {
    storefront: "cn",
    search: async storefront => storefront === "jp" ? [song("jp", "生きていたんだよな", "あいみょん", { isrc: "JPWP01671360" })] : [],
    resolveIsrc: async () => [song("wrong", "Another song", "Another artist", { isrc: "USAAA1200001" })]
  });
  assert.equal(result, null);
});

test("rejects unrelated same-title artists even when duration matches", () => {
  assert.equal(matcher.scoreCandidates(track("Pages", ["発熱巫女～ず"], { album: "Different album" }), [
    song("wrong", "Pages", "古内东子")
  ]), null);
});

test("rejects karaoke and instrumental candidates for a vocal track", () => {
  const source = track("ninelie", ["Aimer", "EGOIST"]);
  const result = matcher.scoreCandidates(source, [
    song("instrumental", "ninelie (instrumental) [with chelly]", "Aimer"),
    song("karaoke", "ninelie (カラオケ)", "Aimer"),
    song("vocal", "ninelie (with chelly)", "Aimer")
  ]);
  assert.equal(result.id, "vocal");
});

test("preserves requested live, remix and instrumental versions", () => {
  for (const version of ["Live", "Remix", "Instrumental"]) {
    const result = matcher.scoreCandidates(track("Song (" + version + ")", ["Artist"]), [
      song("studio", "Song", "Artist"), song("requested", "Song (" + version + ")", "Artist")
    ]);
    assert.equal(result.id, "requested");
  }
});

test("prefers explicit only among credible matches and respects a requested clean version", () => {
  const candidates = [song("clean", "Song (Clean)", "Artist", { contentRating: "clean" }),
    song("explicit", "Song", "Artist", { contentRating: "explicit" })];
  assert.equal(matcher.scoreCandidates(track("Song", ["Artist"]), candidates).id, "explicit");
  assert.equal(matcher.scoreCandidates(track("Song (Clean)", ["Artist"]), candidates).id, "clean");
  assert.equal(matcher.scoreCandidates(track("Unrelated", ["Another artist"]), candidates), null);
});

test("a strong target match performs just one search", async () => {
  let searches = 0;
  const result = await matcher.match(track("Song", ["Artist"]), {
    storefront: "cn", search: async () => { searches += 1; return [song("same", "Song", "Artist")]; },
    resolveIsrc: async () => assert.fail("should not resolve an already strong match")
  });
  assert.equal(result.id, "same");
  assert.equal(searches, 1);
});

test("honors the subscriber region instead of hard-coding mainland China", async () => {
  const result = await matcher.match(track("Song", ["Artist"]), {
    storefront: "us", search: async storefront => { assert.equal(storefront, "us"); return [song("us", "Song", "Artist")]; }
  });
  assert.equal(result.id, "us");
});

test("propagates transient catalog errors instead of calling them missing songs", async () => {
  const error = Object.assign(new Error("Rate limited"), { status: 429 });
  await assert.rejects(matcher.match(track("Song", ["Artist"]), { storefront: "cn", search: async () => { throw error; } }),
    received => received === error);
});

test("an unavailable auxiliary catalog does not discard a valid target-region match", async () => {
  const source = track("歌", ["歌手あ"], { album: "同じアルバム" });
  const result = await matcher.match(source, {
    storefront: "cn",
    search: async storefront => {
      if (storefront === "jp") throw Object.assign(new Error("Unavailable region"), { status: 404 });
      return [song("cn", "歌", "Translated artist", { albumName: "同じアルバム" })];
    },
    resolveIsrc: async () => []
  });
  assert.equal(result.id, "cn");
});

test("ISRC identification is not broken by a word that resembles a version in a translated title", async () => {
  const isrc = "RUAAA1200001";
  const result = await matcher.match(track("Жить", ["Кино"]), {
    storefront: "cn",
    search: async storefront => storefront === "ru" ? [song("ru", "Жить", "Кино", { isrc })] : [],
    resolveIsrc: async () => [song("cn", "Live", "Kino", { isrc })]
  });
  assert.equal(result.id, "cn");
});

test("does not replace an original with a separately named rerecording", () => {
  const source = track("ゴーストルール", ["DECO*27"]);
  const result = matcher.scoreCandidates(source, [
    song("rerecorded", "ゴーストルール -Hello ver.-", "DECO*27"),
    song("original", "ゴーストルール", "DECO*27")
  ]);
  assert.equal(result.id, "original");
  assert.equal(matcher.scoreCandidates(source, [song("rerecorded", "ゴーストルール -Hello ver.-", "DECO*27")]), null);
  assert.equal(matcher.scoreCandidates(track("Song -Crossroads Version-", ["Artist"]), [
    song("requested", "Song (Crossroads Version)", "Artist")
  ]).id, "requested");
});

test("ISRC resolution preserves the native recording ranking even when Apple changes result order", async () => {
  const source = track("歌あ", ["歌手あ"], { album: "Original album" });
  const result = await matcher.match(source, {
    storefront: "cn",
    search: async region => region === "jp" ? [
      song("better", "歌あ", "歌手あ", { albumName: "Original album", isrc: "JPWP01671360" }),
      song("weaker", "歌あ", "歌手あ", { albumName: "Different album", isrc: "JPWP01601512" })
    ] : [],
    resolveIsrc: async () => [
      song("wrong-order", "Romanized", "Translated", { isrc: "JPWP01601512" }),
      song("correct", "Romanized", "Translated", { isrc: "JPWP01671360" })
    ]
  });
  assert.equal(result.id, "correct");
});

test("reuses target search candidates once a native catalog verifies their recording", async () => {
  const isrc = "JPWP01671360";
  const searches = [];
  const result = await matcher.match(track("生きていたんだよな", ["あいみょん"]), {
    storefront: "cn",
    search: async region => {
      searches.push(region);
      return region === "cn" ? [song("cn", "Ikiteitandayona", "爱缪", { isrc })]
        : [song("jp", "生きていたんだよな", "あいみょん", { isrc })];
    },
    resolveIsrc: async () => assert.fail("The CN result already proves regional availability")
  });
  assert.equal(result.id, "cn");
  assert.deepEqual(searches, ["cn", "jp"]);
});

test("equivalent generic version labels do not prevent a metadata match", () => {
  for (const version of ["Live", "Instrumental", "Acoustic", "Remix", "Clean"]) {
    const result = matcher.scoreCandidates(track("Song (" + version + ")", ["Artist"]), [
      song("same", "Song (" + version + " Version)", "Artist")
    ]);
    assert.equal(result.id, "same");
  }
});

test("falls back to a second translated alias if the native catalog cannot identify a recording", async () => {
  const result = await matcher.match(track("生きていたんだよな", ["あいみょん"], {
    aliases: ["Ikiteitandayona", "曾经活着啊"], artistAliases: ["爱缪"]
  }), {
    storefront: "cn",
    search: async (region, query) => region === "cn" && query.includes("曾经活着啊")
      ? [song("translated", "曾经活着啊", "爱缪")] : [],
    resolveIsrc: async () => []
  });
  assert.equal(result.id, "translated");
});

test("candidate reuse does not bypass a preferred recording that is missing from the initial search", async () => {
  const source = track("歌あ", ["歌手あ"], { album: "Original album" });
  let resolutions = 0;
  const result = await matcher.match(source, {
    storefront: "cn",
    search: async region => region === "jp" ? [
      song("better", "歌あ", "歌手あ", { albumName: "Original album", isrc: "JPWP01671360" }),
      song("secondary", "歌あ", "歌手あ", { isrc: "JPWP01601512" })
    ] : [song("target-secondary", "Romanized", "Translated", { isrc: "JPWP01601512" })],
    resolveIsrc: async () => {
      resolutions += 1;
      return [song("target-primary", "Romanized", "Translated", { isrc: "JPWP01671360" })];
    }
  });
  assert.equal(result.id, "target-primary");
  assert.equal(resolutions, 1);
});
