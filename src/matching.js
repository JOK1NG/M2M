export function createSongMatcher() {
  const acceptScore = 0.66;
  const strongScore = 0.84;

  function normalizeText(value) {
    return String(value || "").normalize("NFKC").toLowerCase().normalize("NFD")
      .replace(/([\p{Script=Latin}])\p{Mark}+/gu, "$1").normalize("NFC")
      .replace(/[^\p{Letter}\p{Number}]+/gu, " ").replace(/\s+/g, " ").trim();
  }

  function strings(values) {
    return Array.from(new Set(values.flat().filter(value => typeof value === "string" && value.trim())
      .map(value => value.trim())));
  }

  function titleForms(value) {
    const raw = String(value || "");
    const withoutBrackets = raw.replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）/g, " ");
    return strings([raw, withoutBrackets, ...withoutBrackets.split(/\s+[-–—]\s+/)])
      .map(normalizeText).filter(Boolean);
  }

  function similarity(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 1;
    const compactLeft = left.replace(/ /g, "");
    const compactRight = right.replace(/ /g, "");
    if (compactLeft === compactRight) return 1;
    if (Math.min(compactLeft.length, compactRight.length) >= 4 &&
      (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))) return 0.9;
    const leftTokens = new Set(left.split(" "));
    const rightTokens = new Set(right.split(" "));
    const overlap = Array.from(leftTokens).filter(token => rightTokens.has(token)).length;
    return overlap / Math.max(leftTokens.size, rightTokens.size);
  }

  function bestSimilarity(left, right) {
    let best = 0;
    for (const source of left) for (const candidate of right) {
      best = Math.max(best, similarity(source, candidate));
    }
    return best;
  }

  function versions(value) {
    const text = String(value || "").normalize("NFKC");
    const markers = {
      instrumental: /\b(instrumental|off[ -]?vocal|inst\.?|instrumentalny[yi])\b|伴奏|纯音乐|純音楽|インスト|오프.?보컬|инструментал/iu,
      karaoke: /\bkaraoke\b|カラオケ|卡拉|노래방|카라오케|караоке/iu,
      live: /\blive\b|现场|現場|ライブ|라이브|концерт/iu,
      remix: /\b(remix|mix version)\b|混音|リミックス|리믹스|ремикс/iu,
      acoustic: /\bacoustic\b|unplugged|弾き語り|アコースティック|어쿠스틱|акустич/iu,
      piano: /\bpiano\b|钢琴|鋼琴|ピアノ|피아노|фортепиано/iu,
      sped: /\b(sped[ -]?up|speed[ -]?up|nightcore)\b|加速|倍速/iu,
      slowed: /\bslowed\b|减速|降速/iu
    };
    return Object.keys(markers).filter(key => markers[key].test(text));
  }

  function wantsEdited(value) {
    return /\b(clean|edited|censored|radio edit)\b|消音|和谐|洁版/iu.test(String(value || ""));
  }

  function compatibleVersion(track, candidate) {
    const source = recordingVersions(track.name, track.album);
    const target = recordingVersions(candidate.attributes?.name, candidate.attributes?.albumName);
    const sourceLabels = namedVersions(track.name);
    const targetLabels = namedVersions(candidate.attributes?.name);
    return source.length === target.length && source.every(version => target.includes(version)) &&
      sourceLabels.length === targetLabels.length && sourceLabels.every(label => targetLabels.includes(label));
  }

  function recordingVersions(name, album) {
    const markers = versions(name);
    const albumText = String(album || "").normalize("NFKC");
    const liveAlbum = /[([][^)\]]*\blive\b[^)\]]*[)\]]|\blive (?:at|in|from)\b|ライブ盤|现场专辑|現場專輯/iu.test(albumText);
    if (liveAlbum && !markers.includes("live")) markers.push("live");
    return markers;
  }

  function namedVersions(value) {
    const text = String(value || "").normalize("NFKC");
    const segments = Array.from(text.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/gu))
      .map(result => result[1] || result[2]);
    const suffix = text.match(/[-–—]\s*([^()\[\]]{1,60}?\s+ver(?:sion)?\.?)\s*[-–—]?$/iu);
    if (suffix) segments.push(suffix[1]);
    return strings(segments.filter(segment => /ver(?:sion)?\.?\s*$/iu.test(segment))
      .map(segment => normalizeText(segment.replace(/ver(?:sion)?\.?\s*$/iu, "")))
      .filter(label => label && !/^(original|studio|album)$/.test(label) && !versions(label).length && !wantsEdited(label)));
  }

  function ratingBonus(track, candidate) {
    const edited = wantsEdited(track.name);
    const rating = candidate.attributes?.contentRating;
    if (edited) return rating === "clean" ? 0.025 : -0.08;
    let bonus = rating === "explicit" ? 0.045 : rating === "clean" ? -0.07 : 0;
    if (wantsEdited(candidate.attributes?.name)) bonus -= 0.04;
    return bonus;
  }

  function scoreCandidate(track, candidate) {
    const attributes = candidate?.attributes || {};
    if (!compatibleVersion(track, candidate)) return 0;
    const sourceTitles = searchTitles(track).flatMap(titleForms);
    const title = bestSimilarity(sourceTitles, titleForms(attributes.name));
    const sourceArtists = strings([track.artists || [], track.artistAliases || []]).map(normalizeText);
    const artist = bestSimilarity(sourceArtists, [normalizeText(attributes.artistName)]);
    const sourceAlbums = strings([track.album, track.albumAliases || []]).map(normalizeText);
    const album = bestSimilarity(sourceAlbums, [normalizeText(attributes.albumName)]);
    const durationDifference = track.durationMs && attributes.durationInMillis
      ? Math.abs(track.durationMs - attributes.durationInMillis) : Infinity;
    const duration = durationDifference <= 2500 ? 0.16 : durationDifference <= 7000 ? 0.1 : 0;
    if (title < 0.65 || (Number.isFinite(durationDifference) && durationDifference > 15000)) return 0;
    if (artist < 0.65 && !(title >= 0.9 && album === 1 && durationDifference <= 2500)) return 0;
    return title * 0.5 + artist * 0.26 + duration + album * 0.08 + ratingBonus(track, candidate);
  }

  function rankedCandidates(track, candidates) {
    return candidates.filter(candidate => candidate && candidate.id && candidate.attributes)
      .map(candidate => ({ ...candidate, score: scoreCandidate(track, candidate), matchMethod: "metadata" }))
      .filter(candidate => candidate.score >= acceptScore).sort((left, right) => right.score - left.score);
  }

  function scoreCandidates(track, candidates) {
    return rankedCandidates(track, candidates)[0] || null;
  }

  function searchTitles(track) {
    const aliases = strings(track.aliases || []).filter(alias =>
      !/^原曲\s*[:：]|《[^》]+》.*(?:片头|片尾|主题|插曲|OP|ED)|^(?:TV|テレビ|映画|ドラマ).*?(?:主題歌|挿入歌|オープニング|エンディング)/iu.test(alias));
    const seen = new Set();
    return strings([track.name, aliases]).filter(name => {
      const key = normalizeText(name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function buildSearchQueries(track) {
    const names = searchTitles(track).slice(0, 3);
    const artist = (track.artists || [])[0] || "";
    return strings(names.flatMap(name => [name + " " + artist, name])).slice(0, 6);
  }

  function nativeStorefronts(track) {
    const core = strings([track.name, track.artists || [], track.artistAliases || []]).join(" ");
    const text = strings([core, searchTitles(track), track.album, track.albumAliases || []]).join(" ");
    const regions = [];
    if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) regions.push("jp");
    if (/\p{Script=Hangul}/u.test(text)) regions.push("kr");
    if (/\p{Script=Cyrillic}/u.test(text)) regions.push("ru");
    if (!regions.length && /\p{Script=Han}/u.test(core)) regions.push("cn", "jp");
    return regions.slice(0, 2);
  }

  function verifiedMatch(track, candidates, verifiedIsrcs) {
    return candidates.filter(candidate => verifiedIsrcs.includes(candidate.attributes?.isrc))
      .map(candidate => ({ ...candidate, score: 1 + ratingBonus(track, candidate) -
        verifiedIsrcs.indexOf(candidate.attributes.isrc) * 0.06, matchMethod: "isrc" }))
      .sort((left, right) => right.score - left.score)[0] || null;
  }

  async function match(track, options) {
    const storefront = options.storefront || "cn";
    const queries = buildSearchQueries(track);
    const resolvedIsrcs = new Set();
    let identifiedUnavailable = false;
    if (!track.name || !queries.length) return null;
    if (track.isrc && options.resolveIsrc) {
      const direct = verifiedMatch(track, await options.resolveIsrc(storefront, [track.isrc]), [track.isrc]);
      if (direct) return direct;
      resolvedIsrcs.add(track.isrc);
    }
    let best = null;
    const targetCandidates = await options.search(storefront, queries[0]);
    best = scoreCandidates(track, targetCandidates);
    if (best && best.score >= strongScore) return best;
    if (options.resolveIsrc) {
      for (const native of nativeStorefronts(track).filter(region => region !== storefront)) {
        for (const query of queries.slice(0, 2)) {
          let candidates;
          try {
            candidates = await options.search(native, query);
          } catch (error) {
            if (error.status === 400 || error.status === 404) break;
            throw error;
          }
          const originals = rankedCandidates(track, candidates);
          const isrcs = strings(originals.filter(candidate => candidate.score >= 0.72)
            .map(candidate => candidate.attributes.isrc)).slice(0, 3);
          if (!isrcs.length) continue;
          const known = verifiedMatch(track, targetCandidates, isrcs);
          if (known && known.attributes.isrc === isrcs[0]) return known;
          const remainingIsrcs = isrcs.filter(isrc => !resolvedIsrcs.has(isrc));
          const recordings = remainingIsrcs.length ? await options.resolveIsrc(storefront, remainingIsrcs) : [];
          remainingIsrcs.forEach(isrc => resolvedIsrcs.add(isrc));
          const resolved = verifiedMatch(track, recordings, isrcs);
          if (resolved) return resolved;
          if (known) return known;
          if (!best && originals.find(candidate => candidate.attributes.isrc === isrcs[0]).score >= strongScore) {
            identifiedUnavailable = true;
          }
          break;
        }
      }
    }
    for (const query of queries.slice(1, best ? 2 : queries.length)) {
      const result = scoreCandidates(track, await options.search(storefront, query));
      if (result && (!best || result.score > best.score)) best = result;
      if (best && best.score >= strongScore) return best;
    }
    if (!best && options.onUnmatched) {
      options.onUnmatched({ reason: identifiedUnavailable ? "recording_unavailable" : "unconfirmed", storefront });
    }
    return best;
  }

  return { normalizeText, buildSearchQueries, nativeStorefronts, scoreCandidate, scoreCandidates, match };
}
