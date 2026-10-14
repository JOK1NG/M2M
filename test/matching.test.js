import assert from "node:assert/strict";
import test from "node:test";

import { createSongMatcher } from "../src/matching.js";

const matcher = createSongMatcher();
const song = (id, name, artistName, extra = {}) => ({
  id, type: "songs", attributes: { name, artistName, durationInMillis: 194120, albumName: "Album", ...extra }
});
const track = (name, artists, extra = {}) => ({ name, artists, album: "Album", durationMs: 194120, ...extra });

const reportedCases = [
  {
    source: track("晚风心里吹", ["阿梨粤"], { album: "晚风心里吹", durationMs: 186688 }),
    candidate: song("1632137525", "晚风心里吹 (DJ版)", "阿梨粤 & R7", {
      albumName: "晚风心里吹 - Single", durationInMillis: 187324
    }),
    reason: "version_mismatch", durationDifferenceMs: 636
  },
  {
    source: track("大笑江湖", ["小沈阳", "贾振峰", "郭梓"], { album: "天下无双", durationMs: 160000 }),
    candidate: song("1747672128", "大笑江湖", "小沈阳", { durationInMillis: 210596 }),
    reason: "duration_mismatch", durationDifferenceMs: 50596
  }
];

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
  const source = track("歌", ["歌手あ"], { album: "同じアルバム", artistAliases: ["Translated artist"], durationMs: 202000 });
  const result = await matcher.match(source, {
    storefront: "cn",
    search: async storefront => {
      if (storefront === "jp") throw Object.assign(new Error("Unavailable region"), { status: 404 });
      return [song("cn", "歌", "Translated artist", { albumName: "同じアルバム", contentRating: "clean" })];
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
  assert.deepEqual(searches, ["cn", "cn", "jp"]);
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

test("uses album and artist aliases to recognize a native catalog", () => {
  assert.deepEqual(matcher.nativeStorefronts(track("空種", ["南條愛乃"], {
    album: "穢翼のユースティア"
  })), ["jp"]);
  assert.deepEqual(matcher.nativeStorefronts(track("Spring Day", ["BTS"], {
    artistAliases: ["방탄소년단"]
  })), ["kr"]);
});

test("ambiguous Han-only titles try mainland China and Japan without assuming a language", () => {
  assert.deepEqual(matcher.nativeStorefronts(track("決意", ["V.W.P"])), ["cn", "jp"]);
  assert.deepEqual(matcher.nativeStorefronts(track("晴天", ["周杰伦"])), ["cn", "jp"]);
});

test("checks the original title-only before native verification of a Han-only title renamed in the US", async () => {
  const source = track("決意", ["V.W.P"]);
  const isrc = "JPY392402582";
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "us",
    search: async (region, query) => {
      calls.push({ region, query });
      return region === "us" ? [song("us", "Determination", "V.W.P", { isrc })]
        : [song("native", "決意", "V.W.P", { isrc })];
    },
    resolveIsrc: async () => assert.fail("The target search already contains the verified recording")
  });
  assert.equal(result.id, "us");
  assert.equal(result.matchMethod, "isrc");
  assert.deepEqual(calls, [
    { region: "us", query: "決意 V.W.P" },
    { region: "us", query: "決意" },
    { region: "cn", query: "決意 V.W.P" }
  ]);
});

test("falls back to Japan for an ambiguous title not identifiable in mainland China", async () => {
  const isrc = "JPY392402582";
  const calls = [];
  const result = await matcher.match(track("決意", ["V.W.P"]), {
    storefront: "us",
    search: async region => {
      calls.push(region);
      return region === "jp" ? [song("jp", "決意", "V.W.P", { isrc })] : [];
    },
    resolveIsrc: async region => {
      assert.equal(region, "us");
      return [song("us", "Determination", "V.W.P", { isrc })];
    }
  });
  assert.equal(result.id, "us");
  assert.ok(calls.includes("cn") && calls.includes("jp"));
});

test("never substitutes a Han-only native song that is unavailable in the subscriber catalog", async () => {
  const result = await matcher.match(track("決意", ["V.W.P"]), {
    storefront: "us",
    search: async region => region === "us" ? [] : [song("native", "決意", "V.W.P", { isrc: "JPY392402582" })],
    resolveIsrc: async () => []
  });
  assert.equal(result, null);
});

test("filters soundtrack descriptions before applying the alias search budget", () => {
  const queries = matcher.buildSearchQueries(track("ためすがめ", ["めらみぽっぷ"], {
    aliases: ["原曲：ニュースハウンド／天狗が見ている", "TV动画《学园孤岛》片头曲", "Tamesugame", "望远镜"]
  }));
  assert.ok(queries.some(query => query.includes("Tamesugame")));
  assert.ok(queries.some(query => query.includes("望远镜")));
  assert.ok(queries.every(query => !query.includes("原曲：") && !query.includes("TV动画")));
  assert.ok(matcher.buildSearchQueries(track("Song", ["Artist"], { aliases: ["Theme Song", "电影"] }))
    .includes("Theme Song"));
});

test("reports an unavailable recording only after bounded target fallbacks", async () => {
  const calls = [];
  const notices = [];
  const result = await matcher.match(track("歌あ", ["歌手あ"], { aliases: ["Translated title"] }), {
    storefront: "us",
    search: async (region, query) => {
      calls.push({ region, query });
      return region === "jp" ? [song("jp", "歌あ", "歌手あ", { isrc: "JPWP01671360" })] : [];
    },
    resolveIsrc: async () => [],
    onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.equal(calls.length, 5);
  assert.equal(notices[0].reason, "recording_unavailable");
});

test("does not lose an available original under a translated alias when another release ISRC is absent", async () => {
  const result = await matcher.match(track("歌あ", ["歌手あ"], { aliases: ["Translated title"] }), {
    storefront: "us",
    search: async (region, query) => region === "jp"
      ? [song("jp", "歌あ", "歌手あ", { isrc: "JPWP01671360" })]
      : query.includes("Translated title")
        ? [song("us-alternative", "Translated title", "歌手あ", { isrc: "JPWP01601512" })] : [],
    resolveIsrc: async () => [],
    onUnmatched: () => assert.fail("The alternate original release remains available")
  });
  assert.equal(result.id, "us-alternative");
});

test("does not repeat an unavailable ISRC lookup when two auxiliary catalogs identify the same recording", async () => {
  let resolutions = 0;
  const notices = [];
  const result = await matcher.match(track("決意", ["V.W.P"]), {
    storefront: "us",
    search: async region => region === "us" ? [] : [song(region, "決意", "V.W.P", { isrc: "JPY392402582" })],
    resolveIsrc: async () => { resolutions += 1; return []; },
    onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.equal(resolutions, 1);
  assert.equal(notices[0].reason, "recording_unavailable");
});

test("does not claim regional recording unavailability for a weak auxiliary candidate", async () => {
  let unavailable = false;
  const result = await matcher.match(track("歌あ", ["歌手あ"], { aliases: ["Translated title"], album: "Different album", durationMs: 204000 }), {
    storefront: "us",
    search: async (region, query) => region === "jp"
      ? [song("jp", "歌あ", "歌手あ", { isrc: "JPWP01671360" })]
      : query.includes("Translated title") ? [song("us", "Translated title", "歌手あ", { durationInMillis: 204000 })] : [],
    resolveIsrc: async () => [],
    onUnmatched: notice => { unavailable = notice.reason === "recording_unavailable"; }
  });
  assert.equal(result.id, "us");
  assert.equal(unavailable, false);
});

test("preserves a live recording explicitly labeled only in its source album", () => {
  const source = track("The Legend of Ashitaka", ["Joe Hisaishi"], { album: "WORKS II -Orchestra Nights- (Live)" });
  const result = matcher.scoreCandidates(source, [
    song("studio", "The Legend of Ashitaka", "Joe Hisaishi"),
    song("live", "The Legend of Ashitaka (Symphonic Suite / Live)", "Joe Hisaishi", {
      albumName: "WORKS II - Orchestra Nights (Live)"
    })
  ]);
  assert.equal(result.id, "live");
  assert.equal(matcher.scoreCandidates(source, [song("studio", "The Legend of Ashitaka", "Joe Hisaishi")]), null);
});

test("recognizes live album labels on targets without interpreting Live Forever as a version", () => {
  assert.equal(matcher.scoreCandidates(track("Song (Live)", ["Artist"]), [
    song("live", "Song", "Artist", { albumName: "Concert (Live)" })
  ]).id, "live");
  assert.equal(matcher.scoreCandidates(track("Song", ["Artist"]), [
    song("live", "Song", "Artist", { albumName: "Concert (Live)" })
  ]), null);
  assert.equal(matcher.scoreCandidates(track("Song", ["Artist"], { album: "Live Forever" }), [
    song("studio", "Song", "Artist", { albumName: "Live Forever" })
  ]).id, "studio");
});

test("compares short Chinese artists with exact target collaboration members", () => {
  const source = reportedCases[0].source;
  for (const artistName of ["阿梨粤 & R7", "R7 & 阿梨粤", "阿梨粤、R7", "阿梨粤 feat. R7"]) {
    const candidate = song("collaboration", source.name, artistName, {
      albumName: "Different release", durationInMillis: 187324
    });
    assert.ok(matcher.scoreCandidate(source, candidate) >= 0.84, artistName);
    assert.equal(matcher.scoreCandidates(source, [candidate])?.id, "collaboration");
  }
  const groupSource = track("大笑江湖", ["小沈阳", "贾振峰", "郭梓"]);
  assert.equal(matcher.scoreCandidates(groupSource, [song("member", groupSource.name, "贾振峰")])?.id, "member");
});

test("preserves whole band names and rejects partial names and unrelated singers on self-titled releases", () => {
  for (const artist of ["Simon & Garfunkel", "Earth, Wind & Fire", "AC/DC", "Of Monsters and Men"]) {
    assert.equal(matcher.scoreCandidates(track("Song", [artist]), [song("band", "Song", artist)])?.id, "band");
  }
  for (const [artist, wrongArtist] of [
    ["阿梨粤", "阿梨"], ["阿梨粤", "阿梨粤粤"], ["阿梨粤", "周杰伦"], ["阿梨粤", "周杰伦 & R7"],
    ["小沈阳", "沈阳"], ["Simon & Garfunkel", "Simon"], ["Earth, Wind & Fire", "Fire"],
    ["AC/DC", "AC"], ["Metallica", "Metallic"], ["The Beatles", "Beatles"]
  ]) {
    assert.equal(matcher.scoreCandidates(track("Song", [artist], { album: "Song" }), [
      song("wrong", "Song", wrongArtist, { albumName: "Song" })
    ]), null,
      artist + " / " + wrongArtist);
  }
});

test("does not split slash band names or accept uncredited partial band names", () => {
  for (const [artist, band] of [
    ["AC", "AC/DC"], ["Wind", "Earth Wind Fire"]
  ]) {
    assert.equal(matcher.scoreCandidates(track("Song", [artist]), [song("band", "Song", band)]), null,
      artist + " / " + band);
  }
  assert.equal(matcher.scoreCandidates(track("Song", ["Artist"]), [song("feature", "Song", "Artist feat. Guest")])?.id,
    "feature");
  assert.equal(matcher.scoreCandidates(track("Song", ["Artist", "Guest"]), [song("collab", "Song", "Artist & Guest")])?.id,
    "collab");
});

test("does not bypass a contradictory same-script artist alias using a self-titled release", () => {
  const source = track("Song", ["周杰伦"], { artistAliases: ["Jay Chou"], album: "Song" });
  assert.equal(matcher.scoreCandidates(source, [song("wrong", "Song", "JJ Lin", { albumName: "Song" })]), null);
});

test("retains literal Latin collaboration credits without arbitrary artist substrings", () => {
  for (const [artist, credit] of [
    ["Beyoncé", "Beyoncé & Shakira"], ["Beyoncé", "Shakira & Beyoncé"], ["Aimer", "Aimer & chelly"],
    ["Drake", "Drake x Future"], ["Future", "Drake X Future"], ["Drake", "Drake feat. Future"],
    ["Kendrick Lamar", "Taylor Swift, Kendrick Lamar"], ["IU", "IU & SUGA"]
  ]) {
    const source = track("Song", [artist], { album: "Source release" });
    const candidate = song("collaboration", "Song", credit, { albumName: "Target release" });
    assert.equal(matcher.scoreCandidates(source, [candidate])?.id, "collaboration", artist + " / " + credit);
    assert.equal(matcher.inspectCandidate(source, candidate).artistSimilarity, 1);
  }
  assert.equal(matcher.scoreCandidates(track("Song", ["Drake"], { album: "Source release" }), [
    song("partial", "Song", "Drakeford & Future", { albumName: "Target release" })
  ]), null);
});

test("retains a whole credited band inside a larger collaboration without accepting partial names", () => {
  for (const [artist, credit] of [
    ["Simon & Garfunkel", "Simon & Garfunkel & Guest"],
    ["Simon & Garfunkel", "Guest & Simon & Garfunkel"],
    ["Simon & Garfunkel", "Guest feat. Simon & Garfunkel"],
    ["Earth, Wind & Fire", "Earth, Wind & Fire & Guest"],
    ["AC/DC", "AC/DC & Guest"]
  ]) {
    const source = track("Song", [artist], { album: "Source release" });
    const candidate = song("collaboration", "Song", credit, { albumName: "Target release" });
    assert.equal(matcher.scoreCandidates(source, [candidate])?.id, "collaboration", artist + " / " + credit);
    assert.equal(matcher.inspectCandidate(source, candidate).artistSimilarity, 1);
  }
  for (const [artist, credit] of [
    ["Simon & Garfunkel", "Simon & Guest"], ["Simon & Garfunkel", "Simon & Garfunkelson & Guest"],
    ["Earth, Wind & Fire", "Earth, Wind & Fireplace & Guest"], ["AC", "AC/DC & Guest"],
    ["Drake", "Drakeford & Future"]
  ]) {
    assert.equal(matcher.scoreCandidates(track("Song", [artist], { album: "Source release" }), [
      song("wrong", "Song", credit, { albumName: "Target release" })
    ]), null,
      artist + " / " + credit);
  }
});

test("credited-band windows do not invent an artist by concatenating separate partial names", () => {
  for (const [artist, credit] of [["AC", "A & C & Guest"], ["Metallica", "Metal & Lica & Guest"]]) {
    const source = track("Song", [artist], { album: "Source release" });
    const candidate = song("wrong", "Song", credit, { albumName: "Target release" });
    assert.equal(matcher.scoreCandidates(source, [candidate]), null, artist + " / " + credit);
  }
});

test("requires confirmation for an unverified localized Han credit despite independent album and duration evidence", async () => {
  const source = track("The Legend of Ashitaka", ["久石譲"], {
    album: "WORKS II -Orchestra Nights- (Live)", durationMs: 335160
  });
  const candidate = song("1498699599", "The Legend of Ashitaka (Symphonic Suite \"Princess Mononoke\" / Live)", "久石让", {
    albumName: "WORKS II - Orchestra Nights (Live)", durationInMillis: 335160, isrc: "JPPO09904860"
  });
  assert.equal(matcher.scoreCandidates(source, [candidate]), null);
  assert.deepEqual(matcher.inspectCandidate(source, candidate), {
    score: 0, reason: "artist_mismatch", titleSimilarity: 1, artistSimilarity: 0, durationDifferenceMs: 0
  });
  const notices = [];
  const result = await matcher.match(source, {
    storefront: "cn", search: async region => region === "cn" ? [candidate] : [], resolveIsrc: async () => [],
    onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.equal(notices[0].candidates[0].id, "1498699599");
});

test("a self-titled album or single is not independent identity evidence for a wrong singer", () => {
  for (const album of ["Song", "Song - Single", "Song EP"]) {
    const source = track("Song", ["Artist"], { album });
    const candidate = song("wrong", "Song", "Another singer", { albumName: album });
    assert.equal(matcher.scoreCandidates(source, [candidate]), null, album);
    assert.equal(matcher.inspectCandidate(source, candidate).reason, "artist_mismatch");
  }
});

test("inspectCandidate exposes metadata evidence and specific rejection reasons without changing numeric scores", () => {
  assert.equal(typeof matcher.inspectCandidate, "function");
  const source = track("Shared Alpha", ["Artist"], { album: "", durationMs: 0 });
  const cases = [
    [track("Song", ["Artist"]), song("accepted", "Song", "Artist"), null],
    [track("Song", ["Artist"]), song("title", "Unrelated title", "Artist"), "title_mismatch"],
    [track("Song", ["Artist"], { album: "Song" }), song("artist", "Song", "Wrong singer", { albumName: "Song" }), "artist_mismatch"],
    [track("Song", ["Artist"]), song("version", "Song (Remix)", "Artist"), "version_mismatch"],
    [track("Song", ["Artist"]), song("duration", "Song", "Artist", { durationInMillis: 230000 }), "duration_mismatch"],
    [source, song("weak", "Shared Beta Alpha", "Artist", { albumName: "", durationInMillis: 0 }), "low_confidence"]
  ];
  for (const [input, candidate, reason] of cases) {
    const inspected = matcher.inspectCandidate(input, candidate);
    assert.deepEqual(Object.keys(inspected).sort(), [
      "score", "reason", "titleSimilarity", "artistSimilarity", "durationDifferenceMs"
    ].sort());
    assert.equal(inspected.reason, reason, candidate.id);
    assert.equal(inspected.score, matcher.scoreCandidate(input, candidate));
    assert.equal(typeof inspected.titleSimilarity, "number");
    assert.equal(typeof inspected.artistSimilarity, "number");
    assert.equal(typeof inspected.durationDifferenceMs, "number");
  }
  assert.equal(matcher.inspectCandidate(track("Song", ["Artist"]), null).reason, "title_mismatch");
});

for (const example of reportedCases) {
  test("inspects the reported " + example.reason + " with exact title and artist support", () => {
    assert.equal(typeof matcher.inspectCandidate, "function");
    assert.deepEqual(matcher.inspectCandidate(example.source, example.candidate), {
      score: 0, reason: example.reason, titleSimilarity: 1, artistSimilarity: 1,
      durationDifferenceMs: example.durationDifferenceMs
    });
    assert.equal(matcher.scoreCandidates(example.source, [example.candidate]), null);
  });

  for (const storefront of ["cn", "us"]) {
    test("offers the reported " + example.reason + " in " + storefront + " using only two target searches", async () => {
      const calls = [];
      const notices = [];
      const result = await matcher.match(example.source, {
        storefront,
        search: async (region, query) => {
          calls.push({ region, query });
          return region === storefront ? [example.candidate] : [];
        },
        resolveIsrc: async () => assert.fail("Version/duration alternatives do not need native ISRC lookups"),
        onUnmatched: notice => notices.push(notice)
      });
      assert.equal(result, null);
      assert.deepEqual(calls, [
        { region: storefront, query: example.source.name + " " + example.source.artists[0] },
        { region: storefront, query: example.source.name }
      ]);
      assert.deepEqual(notices, [{
        reason: example.reason, storefront,
        candidates: [{ ...example.candidate, confirmationReason: example.reason }]
      }]);
    });
  }
}

test("recognizes DJ title markers without interpreting a DJ artist name as a different version", () => {
  const source = track("Song", ["Artist"]);
  for (const name of ["Song (DJ版)", "Song（ＤＪ版）", "Song (DJ Version)", "Song - DJ Mix", "Song (DJ)"]) {
    assert.equal(matcher.scoreCandidates(source, [song("dj", name, "Artist")]), null, name);
  }
  assert.equal(matcher.scoreCandidates(track("Song (DJ版)", ["Artist"]), [
    song("original", "Song", "Artist"), song("dj", "Song (DJ Version)", "Artist")
  ])?.id, "dj");
  assert.equal(matcher.scoreCandidates(track("Song", ["DJ Artist"]), [song("original", "Song", "DJ Artist")])?.id,
    "original");
});

test("rejects bracketed and suffixed custom or hyphenated DJ variants for an unmarked original", async () => {
  const source = track("Song", ["Artist"]);
  for (const name of [
    "Song(DJ阿卓版)", "Song(DJ-Mix)", "Song [DJ阿卓版]", "Song（ＤＪ阿卓版）",
    "Song - DJ阿卓版", "Song - DJ-Mix", "Song - DJ阿卓 Mix", "Song DJ阿卓版"
  ]) {
    const candidate = song("dj", name, "Artist");
    assert.equal(matcher.scoreCandidate(source, candidate), 0, name);
    assert.equal(matcher.inspectCandidate(source, candidate).reason, "version_mismatch", name);
    assert.equal(matcher.scoreCandidates(source, [candidate]), null, name);
    const notices = [];
    assert.equal(await matcher.match(source, {
      storefront: "cn", search: async () => [candidate], onUnmatched: notice => notices.push(notice)
    }), null, name);
    assert.equal(notices[0].reason, "version_mismatch", name);
    if (matcher.inspectCandidate(source, candidate).titleSimilarity === 1) {
      assert.deepEqual(notices[0].candidates, [{ ...candidate, confirmationReason: "version_mismatch" }]);
    }
  }
});

test("DJ in an ordinary title is not a version marker when a source title alias matches", () => {
  const source = track("DJ Got Us Fallin' in Love", ["Artist"], { aliases: ["Localized title"] });
  assert.equal(matcher.scoreCandidates(source, [song("localized", "Localized title", "Artist")])?.id, "localized");
});

test("ordinary Django qualifiers are not misclassified as DJ versions", () => {
  const source = track("Song", ["Artist"]);
  for (const name of ["Song (Django)", "Song - Django", "Song [DJANGO]", "Song (Djamila)"]) {
    assert.equal(matcher.scoreCandidates(source, [song("same", name, "Artist")])?.id, "same", name);
  }
});

test("an explicit DJ version suffix still requires confirmation when the remixer's name has no space", () => {
  for (const name of ["Song(DJR7版)", "Song - DJKevin版", "Song [DJKevin Mix]"]) {
    assert.equal(matcher.inspectCandidate(track("Song", ["Artist"]), song("dj", name, "Artist")).reason,
      "version_mismatch", name);
  }
});

test("a strong original beats an explicit DJ version and performs one target search", async () => {
  const example = reportedCases[0];
  const original = song("original", example.source.name, "阿梨粤 & R7", {
    albumName: "Another release", durationInMillis: 187324, contentRating: "clean"
  });
  const dj = { ...example.candidate, attributes: { ...example.candidate.attributes, contentRating: "explicit" } };
  assert.equal(matcher.scoreCandidates(example.source, [dj, original])?.id, "original");
  const calls = [];
  const result = await matcher.match(example.source, {
    storefront: "us",
    search: async region => { calls.push(region); return [dj, original]; },
    resolveIsrc: async () => assert.fail("A strong original needs no native lookup"),
    onUnmatched: () => assert.fail("The original is accepted automatically")
  });
  assert.equal(result?.id, "original");
  assert.deepEqual(calls, ["us"]);
});

test("target title-only and alias fallbacks still find an original after a plausible DJ result", async () => {
  const example = reportedCases[0];
  const queries = matcher.buildSearchQueries({ ...example.source, aliases: ["Evening Breeze", "Night Wind"] });
  for (const fallbackQuery of [queries[1], queries.at(-1)]) {
    const calls = [];
    const result = await matcher.match({ ...example.source, aliases: ["Evening Breeze", "Night Wind"] }, {
      storefront: "us",
      search: async (region, query) => {
        calls.push({ region, query });
        return query === fallbackQuery ? [song("original", example.source.name, "阿梨粤", {
          durationInMillis: example.source.durationMs
        })] : [example.candidate];
      },
      resolveIsrc: async () => assert.fail("Initial same-artist DJ results skip native searches"),
      onUnmatched: () => assert.fail("The fallback finds the original")
    });
    assert.equal(result?.id, "original");
    assert.ok(calls.every(call => call.region === "us"));
    assert.equal(calls.length, queries.indexOf(fallbackQuery) + 1);
    assert.ok(calls.length <= 6);
  }
});

test("confirmation candidates are ranked, deduplicated, capped at three and exclude wrong singers", async () => {
  const example = reportedCases[0];
  const alternate = (id, difference) => song(id, example.source.name, "阿梨粤", {
    durationInMillis: example.source.durationMs + difference
  });
  const candidates = [alternate("longest", 100000), alternate("long", 60000), alternate("closer", 30000),
    song("wrong-singer", example.source.name + " (DJ版)", "周杰伦", { durationInMillis: 187324 }),
    song("partial-singer", example.source.name, "阿梨", { durationInMillis: 250000 }),
    example.candidate, alternate("unrelated-title", 50000)];
  candidates.at(-1).attributes.name = "Another song";
  const notices = [];
  assert.equal(await matcher.match(example.source, {
    storefront: "us", search: async () => candidates,
    resolveIsrc: async () => assert.fail("Plausible target alternatives skip native identification"),
    onUnmatched: notice => notices.push(notice)
  }), null);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, "version_mismatch");
  assert.deepEqual(notices[0].candidates.map(candidate => candidate.id), ["1632137525", "closer", "long"]);
  assert.deepEqual(notices[0].candidates.map(candidate => candidate.confirmationReason), [
    "version_mismatch", "duration_mismatch", "duration_mismatch"
  ]);
});

test("a version or duration marker on a wrong singer never produces a manual candidate or skips native identification", async () => {
  const source = reportedCases[0].source;
  const calls = [];
  const notices = [];
  const result = await matcher.match(source, {
    storefront: "us",
    search: async region => {
      calls.push(region);
      return region === "us" ? [song("wrong", source.name + " (DJ版)", "周杰伦", {
        albumName: source.album, durationInMillis: source.durationMs + 50000
      })] : [];
    },
    resolveIsrc: async () => [], onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.deepEqual(notices, [{ reason: "artist_mismatch", storefront: "us", candidates: [] }]);
  assert.ok(calls.includes("cn") && calls.includes("jp"));
});

test("manual candidates require the same base title, not just a substring title resemblance", async () => {
  const notices = [];
  const result = await matcher.match(track("Love", ["Artist"]), {
    storefront: "us", search: async () => [song("other-song", "Love Again (DJ版)", "Artist")],
    onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.equal(notices[0].reason, "version_mismatch");
  assert.deepEqual(notices[0].candidates, []);
});

test("manual candidates come from target search results, never native IDs or resolver results", async () => {
  const example = reportedCases[0];
  const notices = [];
  const native = song("native-original", example.source.name, "阿梨粤", {
    albumName: example.source.album, durationInMillis: example.source.durationMs, isrc: "CNAAA1200001"
  });
  const result = await matcher.match(example.source, {
    storefront: "us",
    search: async (region, query) => region !== "us" ? [native]
      : query === example.source.name ? [example.candidate] : [],
    resolveIsrc: async () => [song("resolver-only", example.source.name + " (DJ版)", "阿梨粤", {
      durationInMillis: 187324, isrc: "CNBBB1200001"
    })],
    onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.deepEqual(notices, [{ reason: "version_mismatch", storefront: "us", candidates: [
    { ...example.candidate, confirmationReason: "version_mismatch" }
  ] }]);
});

test("onUnmatched distinguishes candidate rejection, empty catalogs and weak identification", async () => {
  const source = track("Shared Alpha", ["Artist"], { album: "", durationMs: 0 });
  for (const [candidates, reason] of [
    [[], "no_results"],
    [[song("title", "Other", "Artist")], "title_mismatch"],
    [[song("artist", source.name, "Another singer")], "artist_mismatch"],
    [[song("weak", "Shared Beta Alpha", "Artist", { albumName: "", durationInMillis: 0 })], "low_confidence"]
  ]) {
    const notices = [];
    assert.equal(await matcher.match(source, {
      storefront: "gb", search: async () => candidates, onUnmatched: notice => notices.push(notice)
    }), null);
    assert.deepEqual(notices, [{ reason, storefront: "gb", candidates: [] }]);
  }
  const notices = [];
  assert.equal(await matcher.match(track("", ["Artist"]), {
    storefront: "gb", search: async () => assert.fail("A missing title cannot be searched"),
    onUnmatched: notice => notices.push(notice)
  }), null);
  assert.deepEqual(notices, [{ reason: "unconfirmed", storefront: "gb", candidates: [] }]);
});

test("candidate reasons take priority over recording_unavailable and include no native manual candidates", async () => {
  const notices = [];
  const result = await matcher.match(track("歌あ", ["歌手あ"], { album: "歌あ" }), {
    storefront: "us",
    search: async region => region === "us" ? [song("wrong", "歌あ", "別の歌手", { albumName: "歌あ" })]
      : [song("native", "歌あ", "歌手あ", { albumName: "歌あ", isrc: "JPWP01671360" })],
    resolveIsrc: async () => [], onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.deepEqual(notices, [{ reason: "artist_mismatch", storefront: "us", candidates: [] }]);
});

test("direct source ISRC resolution stays in the account region and preserves explicit preference", async () => {
  const isrc = "CNAAA1200001";
  const source = { ...reportedCases[0].source, isrc };
  const result = await matcher.match(source, {
    storefront: "gb", search: async () => assert.fail("A verified source ISRC needs no search"),
    resolveIsrc: async (region, isrcs) => {
      assert.equal(region, "gb");
      assert.deepEqual(isrcs, [isrc]);
      return [song("clean", "Localized title", "Localized artist", { isrc, contentRating: "clean" }),
        song("explicit", "Localized title", "Localized artist", { isrc, contentRating: "explicit" })];
    }
  });
  assert.equal(result.id, "explicit");
  assert.equal(result.matchMethod, "isrc");
});

test("the matcher factory exposes inspection and requires explicit version confirmation", async () => {
  const instance = createSongMatcher();
  assert.equal(typeof instance.inspectCandidate, "function");
  const example = reportedCases[0];
  assert.equal(instance.inspectCandidate(example.source, example.candidate).reason, "version_mismatch");
  const notices = [];
  assert.equal(await instance.match(example.source, {
    storefront: "us", search: async () => [example.candidate], onUnmatched: notice => notices.push(notice)
  }), null);
  assert.equal(notices[0].candidates[0].confirmationReason, "version_mismatch");
});

test("matches Chinese traditional titles, singer credits and albums without changing source metadata", async () => {
  const source = track("吹灭小山河", ["司南"], { album: "国风音乐合集", durationMs: 194120 });
  const original = structuredClone(source);
  const candidate = song("traditional", "吹滅小山河", "司南", { albumName: "國風音樂合集" });
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "cn", search: async region => { calls.push(region); return [candidate]; },
    resolveIsrc: async () => assert.fail("A supported traditional title needs no native catalog")
  });
  assert.equal(result?.id, "traditional");
  assert.deepEqual(calls, ["cn"]);
  assert.deepEqual(source, original);
  assert.equal(matcher.inspectCandidate(track("说好的幸福呢", ["周杰伦"]),
    song("traditional-artist", "說好的幸福呢", "周杰倫 & Guest")).artistSimilarity, 1);
});

test("Chinese conversion does not reinterpret Japanese names or remove recording version differences", () => {
  assert.equal(matcher.scoreCandidates(track("後ろ姿", ["歌手"], { album: "日本の歌" }), [
    song("not-the-same", "后ろ姿", "歌手")
  ]), null);
  assert.equal(matcher.inspectCandidate(track("吹灭小山河", ["司南"]),
    song("dj", "吹滅小山河 (DJ版)", "司南")).reason, "version_mismatch");
  assert.equal(matcher.inspectCandidate(track("同名歌曲", ["周杰伦"]),
    song("wrong-artist", "同名歌曲", "林俊傑")).reason, "artist_mismatch");
  assert.equal(matcher.scoreCandidates(track("中文歌", ["歌手"], { aliases: ["廣島の歌"] }), [
    song("not-a-chinese-variant", "广島の歌", "歌手")
  ]), null);
});

test("Chinese normalization alone without duration or independent album evidence cannot identify a recording", () => {
  const source = { name: "发", artists: ["歌手"], album: "发" };
  assert.equal(matcher.scoreCandidates(source, [{ id: "ambiguous", attributes: {
    name: "髮", artistName: "歌手", albumName: "髮"
  } }]), null);
});

test("queries an authoritative singer alias in the account catalog before native fallback", async () => {
  const source = track("Known Recording", ["加藤いづみ"], { artistAliases: ["Izumi Kato"] });
  const calls = [];
  const queries = matcher.buildSearchQueries(source);
  assert.ok(queries.includes("Known Recording Izumi Kato"));
  assert.ok(queries.length <= 6);
  const result = await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      calls.push({ region, query });
      return query === "Known Recording Izumi Kato" ? [song("alias", source.name, "Izumi Kato")] : [];
    },
    resolveIsrc: async () => assert.fail("Known artist aliases do not need a cross-region lookup")
  });
  assert.equal(result?.id, "alias");
  assert.deepEqual(calls.map(call => call.region), ["us", "us"]);
});

test("queries a translated title alias before native lookup without expanding every alias combination", async () => {
  const source = track("原始歌名", ["Artist"], { aliases: ["Verified Title", "Another Title", "Extra Title"],
    artistAliases: ["Artist", "Another Credit", "Third Credit", "Fourth Credit"] });
  const queries = matcher.buildSearchQueries(source);
  assert.ok(queries.length <= 6);
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      calls.push({ region, query });
      return query === "Verified Title Artist" ? [song("translated", "Verified Title", "Artist")] : [];
    },
    resolveIsrc: async () => []
  });
  assert.equal(result?.id, "translated");
  assert.ok(calls.every(call => call.region === "us"));
  assert.ok(calls.length <= 3);
});

for (const example of [
  {
    label: "multi-credit metadata", source: track("原語の曲", ["Publishing Credit", "Credited Singer"]),
    artist: "Credited Singer", queries: ["原語の曲 Publishing Credit", "原語の曲"]
  },
  {
    label: "authoritative singer aliases", source: track("原語の曲", ["歌手あ"], { artistAliases: ["Known Singer"] }),
    artist: "Known Singer", queries: ["原語の曲 歌手あ", "原語の曲 Known Singer", "原語の曲"]
  }
]) {
  test("original title-only discovery avoids native calls for " + example.label, async () => {
    const calls = [];
    const isrc = "JPAAA1200001";
    const result = await matcher.match(example.source, {
      storefront: "us", search: async (region, query) => {
        calls.push({ region, query });
        if (region === "jp") return [song("native-only", example.source.name, example.artist, { isrc })];
        return query === example.source.name ? [song("account-original", example.source.name, example.artist, { isrc })] : [];
      }, resolveIsrc: async (region, codes) => {
        calls.push({ region, isrcs: codes });
        return [];
      }
    });
    assert.equal(result?.id, "account-original");
    assert.equal(result.matchMethod, "metadata");
    assert.deepEqual(calls, example.queries.map(query => ({ region: "us", query })));
  });
}

test("original title-only localized artist evidence still needs native proof and reuses its exact ISRC", async () => {
  const source = track("原語の曲", ["歌手あ"]);
  const isrc = "JPAAA1200001";
  const account = song("account-localized", source.name, "Localized Singer", { isrc });
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      calls.push({ region, query });
      if (region === "jp") return [song("native-only", source.name, "歌手あ", { isrc })];
      return query === source.name ? [account] : [];
    }, resolveIsrc: async () => assert.fail("The account title-only result already contains the verified ISRC")
  });
  assert.equal(matcher.scoreCandidate(source, account), 0);
  assert.equal(result?.id, "account-localized");
  assert.equal(result.matchMethod, "isrc");
  assert.deepEqual(calls, [
    { region: "us", query: "原語の曲 歌手あ" },
    { region: "us", query: "原語の曲" },
    { region: "jp", query: "原語の曲 歌手あ" }
  ]);
});

for (const candidate of [
  song("uncertain", "Original Recording", "Localized Singer"),
  song("dj", "Original Recording (DJ版)", "歌手あ"),
  song("alias-dj", "Localized Title (DJ版)", "歌手あ"),
  song("weak", "Original Recording", "歌手あ", { albumName: "Other album", durationInMillis: 204120 })
]) {
  test("original title-only " + candidate.id + " evidence cannot suppress native proof", async () => {
    const source = track("Original Recording", ["歌手あ"], { aliases: ["Localized Title"] });
    const isrc = "JPAAA1200001";
    const calls = [];
    const result = await matcher.match(source, {
      storefront: "us", search: async (region, query) => {
        calls.push({ region, query });
        if (region === "jp") return [song("native-only", source.name, "歌手あ", { isrc })];
        return query === source.name ? [candidate] : [];
      }, resolveIsrc: async (region, codes) => {
        calls.push({ region, isrcs: codes });
        return [song("account-original", source.name, "歌手あ", { isrc })];
      }
    });
    assert.equal(result?.id, "account-original");
    assert.equal(result.matchMethod, "isrc");
    assert.deepEqual(calls, [
      { region: "us", query: "Original Recording 歌手あ" },
      { region: "us", query: "Localized Title 歌手あ" },
      { region: "us", query: "Original Recording" },
      { region: "jp", query: "Original Recording 歌手あ" },
      { region: "us", isrcs: [isrc] }
    ]);
  });
}

test("initial same-title version alternatives do not add a title-only query before a useful singer alias", async () => {
  const source = track("Original Recording", ["歌手あ"], { artistAliases: ["Known Singer"] });
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      calls.push({ region, query });
      return query === "Original Recording Known Singer" ? [song("account-original", source.name, "Known Singer")]
        : [song("dj", "Original Recording (DJ版)", "歌手あ")];
    }, resolveIsrc: async () => assert.fail("The useful authoritative singer alias found the original")
  });
  assert.equal(result?.id, "account-original");
  assert.deepEqual(calls, [
    { region: "us", query: "Original Recording 歌手あ" },
    { region: "us", query: "Original Recording Known Singer" }
  ]);
});

test("early original title-only discovery shares the six-query budget with all account fallbacks", async () => {
  const source = track("原語の曲", ["歌手あ"], {
    aliases: ["First Alias", "Second Alias", "Ignored Alias"], artistAliases: ["Known Singer"]
  });
  const calls = [];
  assert.equal(await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      assert.ok(query.normalize("NFKC").length <= 256);
      calls.push({ region, query });
      return [];
    }, resolveIsrc: async () => assert.fail("Empty catalogs cannot identify any ISRC")
  }), null);
  assert.deepEqual(calls, [
    { region: "us", query: "原語の曲 歌手あ" },
    { region: "us", query: "原語の曲 Known Singer" },
    { region: "us", query: "First Alias 歌手あ" },
    { region: "us", query: "原語の曲" },
    { region: "jp", query: "原語の曲 歌手あ" },
    { region: "jp", query: "原語の曲" },
    { region: "us", query: "Second Alias 歌手あ" },
    { region: "us", query: "First Alias" }
  ]);
  const accountQueries = calls.filter(call => call.region === "us").map(call => call.query);
  assert.equal(accountQueries.length, 6);
  assert.equal(new Set(accountQueries).size, 6);
});

test("original title-only discovery does not repeat an initial query without an artist credit", async () => {
  const calls = [];
  assert.equal(await matcher.match(track("原語の曲", []), {
    storefront: "us", search: async (region, query) => { calls.push({ region, query }); return []; },
    resolveIsrc: async () => assert.fail("Empty catalogs cannot identify any ISRC")
  }), null);
  assert.deepEqual(calls, [{ region: "us", query: "原語の曲" }, { region: "jp", query: "原語の曲" }]);
});

test("offers a distinctive same-title cross-script artist candidate only for explicit confirmation", async () => {
  const source = track("Kamura's Song of Purification", ["加藤いづみ"], {
    album: "Source soundtrack", durationMs: 194120
  });
  const candidate = song("uncertain-credit", source.name, "Izumi Kato", { albumName: "Target soundtrack" });
  const notices = [];
  const result = await matcher.match(source, {
    storefront: "cn", search: async region => region === "cn" ? [candidate] : [],
    resolveIsrc: async () => [], onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.equal(matcher.scoreCandidate(source, candidate), 0);
  assert.equal(notices[0].reason, "artist_mismatch");
  assert.deepEqual(notices[0].candidates.map(item => item.id), ["uncertain-credit"]);
});

test("artist-uncertainty review rejects same-script conflicts, known contradictory aliases, versions and weak titles", async () => {
  for (const [source, candidate] of [
    [track("Distinctive Recording", ["Artist"]), song("conflict", "Distinctive Recording", "Another Artist")],
    [track("Distinctive Recording", ["加藤いづみ"], { artistAliases: ["Izumi Kato"] }),
      song("conflict", "Distinctive Recording", "Another Artist")],
    [track("Distinctive Recording", ["加藤いづみ"]), song("version", "Distinctive Recording (DJ版)", "Izumi Kato")],
    [track("Pages", ["加藤いづみ"], { album: "Source" }), song("short", "Pages", "Izumi Kato", { albumName: "Target" })],
    [track("Distinctive Recording", ["加藤いづみ"]),
      song("duration", "Distinctive Recording", "Izumi Kato", { durationInMillis: 220000 })]
  ]) {
    const notices = [];
    assert.equal(await matcher.match(source, { storefront: "cn", search: async () => [candidate],
      onUnmatched: notice => notices.push(notice) }), null);
    assert.deepEqual(notices[0].candidates, [], candidate.id);
  }
});

test("native identification retains the original title-only query despite target alias priorities", async () => {
  const source = track("原語の曲", ["歌手あ"], { aliases: ["Translated Title", "Another Title"] });
  const isrc = "JPAAA1200001";
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      calls.push({ region, query });
      return region === "jp" && query === source.name ? [song("native", source.name, "歌手あ", { isrc })] : [];
    }, resolveIsrc: async () => [song("account", "Translated Title", "Localized Singer", { isrc })]
  });
  assert.equal(result?.id, "account");
  assert.deepEqual(calls.filter(call => call.region === "jp").map(call => call.query), [source.name + " 歌手あ", source.name]);
});

test("an exact target title with unconfirmed artist needs only the initial account search and native ISRC proof", async () => {
  const source = track("Distinctive Recording", ["歌手あ"], { aliases: ["译名一", "译名二"] });
  const isrc = "JPAAA1200001";
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      calls.push({ region, query });
      return [song(region, source.name, region === "us" ? "Localized Singer" : "歌手あ", { isrc })];
    }, resolveIsrc: async () => assert.fail("Verified recording is already in target candidates")
  });
  assert.equal(result?.id, "us");
  assert.equal(result.matchMethod, "isrc");
  assert.deepEqual(calls, [
    { region: "us", query: "Distinctive Recording 歌手あ" },
    { region: "jp", query: "Distinctive Recording 歌手あ" }
  ]);
});

test("an already identified account title still permits two independent original queries for native proof", async () => {
  const source = track("原語の曲", ["歌手あ"], { aliases: ["Translated Title"] });
  const isrc = "JPAAA1200001";
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      calls.push({ region, query });
      if (region === "us") return [song("account-localized", source.name, "Localized Singer", { isrc })];
      return query === source.name ? [song("native-only", source.name, "歌手あ", { isrc })] : [];
    }, resolveIsrc: async () => assert.fail("Native proof reuses the already collected account ISRC")
  });
  assert.equal(result?.id, "account-localized");
  assert.equal(result.matchMethod, "isrc");
  assert.deepEqual(calls, [
    { region: "us", query: "原語の曲 歌手あ" },
    { region: "jp", query: "原語の曲 歌手あ" },
    { region: "jp", query: "原語の曲" }
  ]);
});

test("independent album and exact duration can offer an unverified band versus vocalist credit but never auto-match it", async () => {
  const source = track("蘇る記憶", ["Ether"], { album: "深海都市セラノフィリア", durationMs: 346801 });
  const candidate = song("singer-credit", source.name, "Erum Nagi", { albumName: source.album, durationInMillis: 346802 });
  const notices = [];
  assert.equal(await matcher.match(source, { storefront: "cn", search: async region => region === "cn" ? [candidate] : [],
    resolveIsrc: async () => [], onUnmatched: notice => notices.push(notice) }), null);
  assert.equal(matcher.scoreCandidate(source, candidate), 0);
  assert.equal(notices[0].candidates[0]?.id, "singer-credit");
  const conflicting = { ...source, artistAliases: ["Verified Ether Credit"] };
  const conflicts = [];
  assert.equal(await matcher.match(conflicting, { storefront: "cn", search: async () => [candidate],
    onUnmatched: notice => conflicts.push(notice) }), null);
  assert.deepEqual(conflicts[0].candidates, []);
});

test("traditional Chinese recording markers never silently substitute instrumental or slowed versions", () => {
  const source = track("吹灭小山河", ["司南"]);
  for (const suffix of ["純音樂", "減速版", "現場版"]) {
    const candidate = song("different-version", "吹滅小山河 (" + suffix + ")", "司南");
    assert.equal(matcher.scoreCandidate(source, candidate), 0, suffix);
    assert.equal(matcher.inspectCandidate(source, candidate).reason, "version_mismatch", suffix);
  }
  const cleanSource = track("歌曲 (潔版)", ["歌手"]);
  assert.equal(matcher.scoreCandidates(cleanSource, [song("explicit", "歌曲", "歌手", { contentRating: "explicit" }),
    song("clean", "歌曲", "歌手", { contentRating: "clean" })])?.id, "clean");
});

test("an alias-only DJ alternative cannot suppress native proof of an available original", async () => {
  const source = track("Original Recording", ["歌手あ"], { aliases: ["Localized Title"] });
  const isrc = "JPAAA1200001";
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "us", search: async (region, query) => {
      calls.push(region);
      return region === "us" ? (query.startsWith(source.name) ? [] : [song("dj", "Localized Title (DJ版)", "歌手あ")])
        : [song("native", source.name, "歌手あ", { isrc })];
    }, resolveIsrc: async () => [song("original", "Localized Title", "歌手あ", { isrc })]
  });
  assert.equal(result?.id, "original");
  assert.ok(calls.includes("jp"));
});

test("credit separators and mixed collaborations do not disguise known same-script artist conflicts", async () => {
  const source = track("Distinctive Recording", ["周杰伦"], { album: "Source soundtrack" });
  for (const artist of ["林俊傑 feat. 王力宏", "林俊傑 ft. 王力宏", "林俊傑 & Guest"]) {
    const notices = [];
    assert.equal(await matcher.match(source, {
      storefront: "cn", search: async () => [song("wrong", source.name, artist, { albumName: "Target soundtrack" })],
      onUnmatched: notice => notices.push(notice)
    }), null);
    assert.deepEqual(notices[0].candidates, [], artist);
  }
});

test("ambiguous native credits can map a recording into the account region for review without automatic acceptance", async () => {
  const source = track("Distinctive Recording", ["歌手あ"], { album: "独立原声带" });
  const isrc = "JPAAA1200001";
  const native = song("native-only", source.name, "Publishing Band", { albumName: source.album, isrc });
  const account = song("account-review", "Localized Recording", "Localized Vocalist", { albumName: "Localized soundtrack", isrc });
  const notices = [];
  const calls = [];
  const result = await matcher.match(source, {
    storefront: "cn", search: async region => { calls.push(region); return region === "jp" ? [native] : []; },
    resolveIsrc: async (region, codes) => {
      assert.equal(region, "cn");
      assert.deepEqual(codes, [isrc]);
      return [account];
    }, onUnmatched: notice => notices.push(notice)
  });
  assert.equal(result, null);
  assert.equal(notices[0].reason, "artist_mismatch");
  assert.deepEqual(notices[0].candidates.map(item => item.id), ["account-review"]);
  assert.deepEqual(calls, ["cn", "cn", "jp"]);
});

test("review mapping rejects unrelated ISRCs, missing durations and recordings with conflicting versions", async () => {
  const source = track("Distinctive Recording", ["歌手あ"], { album: "独立原声带" });
  const isrc = "JPAAA1200001";
  for (const extra of [{ isrc: "USAAA1200001" }, { durationInMillis: 0 }, { name: "Localized Recording (DJ版)" }]) {
    const notices = [];
    const result = await matcher.match(source, {
      storefront: "cn", search: async region => region === "jp" ? [song("native-only", source.name, "Publishing Band", {
        albumName: source.album, isrc
      })] : [], resolveIsrc: async () => [song("bad", "Localized Recording", "Localized Vocalist", { isrc, ...extra })],
      onUnmatched: notice => notices.push(notice)
    });
    assert.equal(result, null);
    assert.deepEqual(notices[0].candidates, []);
  }
});

test("same-recording review can tolerate omitted locale version labels but not additional versions", async () => {
  const source = track("Distinctive Recording (Live)", ["歌手あ"], { album: "独立现场原声带" });
  const isrc = "JPAAA1200001";
  const notices = [];
  assert.equal(await matcher.match(source, {
    storefront: "cn", search: async region => region === "jp" ? [song("native", source.name, "Publishing Band", {
      albumName: source.album, isrc
    })] : [], resolveIsrc: async () => [song("account", "Localized Recording", "Localized Vocalist", { isrc })],
    onUnmatched: notice => notices.push(notice)
  }), null);
  assert.equal(notices[0].candidates[0]?.id, "account");
});

test("traditional version labels remain meaningful on Japanese songs without converting Japanese titles", () => {
  const source = track("日本の歌", ["歌手あ"]);
  for (const suffix of ["純音樂", "減速版"]) {
    assert.equal(matcher.scoreCandidate(source, song("wrong", source.name + " (" + suffix + ")", "歌手あ")), 0);
  }
});

test("query budgets use normalized lengths and review fallback never submits an oversized original title", async () => {
  const oversized = "ﬃ".repeat(90);
  assert.ok(matcher.buildSearchQueries(track(oversized, ["Artist"]))
    .every(query => query.normalize("NFKC").length <= 256));
  const source = track("x".repeat(300), ["歌手あ"], { aliases: ["Safe Recording"], album: "独立原声带" });
  const isrc = "JPAAA1200001";
  const notices = [];
  assert.equal(await matcher.match(source, {
    storefront: "cn", search: async (region, query) => {
      assert.ok(query.normalize("NFKC").length <= 256);
      return region === "jp" ? [song("native", "Safe Recording", "Publishing Band", { albumName: source.album, isrc })] : [];
    }, resolveIsrc: async () => [song("account", "Localized Recording", "Localized Vocalist", { isrc })],
    onUnmatched: notice => notices.push(notice)
  }), null);
  assert.equal(notices[0].candidates[0]?.id, "account");
});

test("1000 alternating Chinese and authoritative-alias tracks maintain bounded query counts", async () => {
  const instance = createSongMatcher();
  let requests = 0;
  for (let index = 0; index < 1000; index += 1) {
    const chinese = index % 2 === 0;
    const source = chinese ? track("吹灭小山河 " + index, ["周杰伦"])
      : track("Known Recording " + index, ["歌手あ"], { artistAliases: ["Known Singer"] });
    const result = await instance.match(source, {
      storefront: "cn", search: async (region, query) => {
        assert.equal(region, "cn");
        requests += 1;
        if (!chinese && !query.endsWith(" Known Singer")) return [];
        return [song(String(index), chinese ? "吹滅小山河 " + index : source.name, chinese ? "周杰倫" : "Known Singer")];
      }, resolveIsrc: async () => assert.fail("Canonical names and known aliases need no cross-region proof")
    });
    assert.equal(result?.id, String(index));
  }
  assert.equal(requests, 1500);
});

test("mapping retains a same-recording version proof when the account candidate was already searched", async () => {
  const source = track("Distinctive Recording (Live)", ["歌手あ"], { aliases: ["Localized Recording"], album: "Source soundtrack" });
  const isrc = "JPAAA1200001";
  const account = song("account", "Localized Recording", "Localized Vocalist", { albumName: "Account soundtrack", isrc });
  const notices = [];
  assert.equal(await matcher.match(source, {
    storefront: "cn", search: async region => region === "jp"
      ? [song("native", source.name, "Publishing Band", { albumName: "Native soundtrack", isrc })] : [account],
    resolveIsrc: async () => [account], onUnmatched: notice => notices.push(notice)
  }), null);
  assert.deepEqual(notices[0].candidates.map(candidate => candidate.id), ["account"]);
});

test("release suffixes cannot turn generic album names into recording identity evidence", async () => {
  for (const album of ["Unknown Album - Single", "OST - EP", "Album - Single - EP", "未知专辑 - Single"]) {
    const source = track("Song", ["歌手あ"], { album });
    const notices = [];
    assert.equal(await matcher.match(source, { storefront: "cn", search: async () => [song("wrong", source.name, "Another Singer", {
      albumName: album
    })], onUnmatched: notice => notices.push(notice) }), null);
    assert.deepEqual(notices[0].candidates, [], album);
  }
});

test("failed ambiguous mapping has one shared budget of three recording codes per track", async () => {
  const source = track("Distinctive Recording", ["中文歌手"], { album: "Source soundtrack" });
  let nativeQuery = 0;
  let lookupCodes = 0;
  assert.equal(await matcher.match(source, {
    storefront: "us", search: async region => {
      if (region === "us") return [];
      const start = nativeQuery++ * 3;
      return Array.from({ length: 3 }, (_, index) => song("native-" + (start + index), source.name, "Unknown Singer", {
        albumName: "Native soundtrack", isrc: "JPAAA" + String(1200001 + start + index)
      }));
    }, resolveIsrc: async (_region, codes) => { lookupCodes += codes.length; return []; }
  }), null);
  assert.equal(lookupCodes, 3);
});
