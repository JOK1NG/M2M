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

test("verifies a Han-only title renamed in the US with just two searches", async () => {
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
  assert.deepEqual(calls.map(call => call.region), ["us", "cn"]);
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

test("retains the CN localized Han live recording using independent album and duration evidence", async () => {
  const source = track("The Legend of Ashitaka", ["久石譲"], {
    album: "WORKS II -Orchestra Nights- (Live)", durationMs: 335160
  });
  const candidate = song("1498699599", "The Legend of Ashitaka (Symphonic Suite \"Princess Mononoke\" / Live)", "久石让", {
    albumName: "WORKS II - Orchestra Nights (Live)", durationInMillis: 335160, isrc: "JPPO09904860"
  });
  assert.equal(matcher.scoreCandidates(source, [candidate])?.id, "1498699599");
  assert.deepEqual(matcher.inspectCandidate(source, candidate), {
    score: 0.74, reason: null, titleSimilarity: 1, artistSimilarity: 0, durationDifferenceMs: 0
  });
  const result = await matcher.match(source, {
    storefront: "cn", search: async region => region === "cn" ? [candidate] : [], resolveIsrc: async () => [],
    onUnmatched: () => assert.fail("The independently supported localized live recording is available")
  });
  assert.equal(result?.id, "1498699599");
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

test("the serialized factory exports inspectCandidate and works without external dependencies", async () => {
  const serialized = Function("return (" + createSongMatcher.toString() + ")()")();
  assert.equal(typeof serialized.inspectCandidate, "function");
  const example = reportedCases[0];
  assert.equal(serialized.inspectCandidate(example.source, example.candidate).reason, "version_mismatch");
  const notices = [];
  assert.equal(await serialized.match(example.source, {
    storefront: "us", search: async () => [example.candidate], onUnmatched: notice => notices.push(notice)
  }), null);
  assert.equal(notices[0].candidates[0].confirmationReason, "version_mismatch");
});
