import { ConverterFactory } from "opencc-js/core";
import chineseDictionaries from "opencc-js/to/cn";

let chineseConverter;

export function createSongMatcher() {
  const acceptScore = 0.66;
  const strongScore = 0.84;
  const chineseCache = new Map();

  function normalizeText(value) {
    return String(value || "").normalize("NFKC").toLowerCase().normalize("NFD")
      .replace(/([\p{Script=Latin}])\p{Mark}+/gu, "$1").normalize("NFC")
      .replace(/[^\p{Letter}\p{Number}]+/gu, " ").replace(/\s+/g, " ").trim();
  }

  function strings(values) {
    return Array.from(new Set(values.flat().filter(value => typeof value === "string" && value.trim())
      .map(value => value.trim())));
  }

  function chineseContext(track) {
    const metadata = strings([track.name, track.aliases || [], track.artists || [], track.artistAliases || [], track.album, track.albumAliases || []]).join(" ");
    return /\p{Script=Han}/u.test(metadata) &&
      !/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Cyrillic}/u.test(metadata);
  }

  function comparisonText(value, chinese = false) {
    const text = normalizeText(value);
    if (!chinese || !/\p{Script=Han}/u.test(text)) return text;
    if (chineseCache.has(text)) {
      const existing = chineseCache.get(text);
      chineseCache.delete(text);
      chineseCache.set(text, existing);
      return existing;
    }
    if (!chineseConverter) chineseConverter = ConverterFactory(...chineseDictionaries);
    const converted = chineseConverter(text);
    if (chineseCache.size >= 1000) chineseCache.delete(chineseCache.keys().next().value);
    chineseCache.set(text, converted);
    return converted;
  }

  function titleForms(value, chinese = false) {
    const raw = String(value || "");
    const withoutBrackets = raw.replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）/g, " ");
    return strings([raw, withoutBrackets, ...withoutBrackets.split(/\s+[-–—]\s+/)])
      .map(text => comparisonText(text, chinese)).filter(Boolean);
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

  function artistSimilarity(sourceArtists, targetArtist, chinese) {
    const identity = value => comparisonText(value, chinese).replace(/ /g, "");
    const sourceNames = sourceArtists.map(identity);
    const whole = identity(targetArtist);
    if (!whole) return 0;
    if (sourceNames.includes(whole)) return 1;
    const credits = String(targetArtist || "").normalize("NFKC").split(/\b(?:feat(?:uring)?|ft)\.?\s+/iu);
    for (const credit of credits) {
      if (sourceNames.includes(identity(credit))) return 1;
      const separator = /\p{Script=Han}/u.test(credit) ? /\s*(?:[&、,;/]|\s+x\s+)\s*/iu
        : /\s*(?:[&、,;]|\s+x\s+|\s+\/\s+)\s*/iu;
      const members = credit.split(separator).map(value => comparisonText(value, chinese)).filter(Boolean);
      if (members.some(member => sourceNames.includes(identity(member)))) return 1;
      for (let startIndex = 0; startIndex < members.length - 1; startIndex += 1) {
        let creditedName = members[startIndex];
        for (const member of members.slice(startIndex + 1)) {
          creditedName += " " + member;
          if (sourceArtists.includes(creditedName)) return 1;
        }
      }
    }
    return 0;
  }

  function partialArtistName(sourceArtists, targetArtist) {
    const target = normalizeText(targetArtist).replace(/ /g, "");
    if (!target) return false;
    return sourceArtists.some(artist => {
      const source = artist.replace(/ /g, "");
      return source && source !== target && (source.includes(target) || target.includes(source));
    });
  }

  function versions(value, chinese = false) {
    const raw = String(value || "").normalize("NFKC");
    const text = chinese ? raw + " " + comparisonText(raw, true) : raw;
    const markers = {
      instrumental: /\b(instrumental|off[ -]?vocal|inst\.?|instrumentalny[yi])\b|伴奏|纯音乐|純音樂|純音楽|インスト|오프.?보컬|инструментал/iu,
      karaoke: /\bkaraoke\b|カラオケ|卡拉|노래방|카라오케|караоке/iu,
      live: /\blive\b|现场|現場|ライブ|라이브|концерт/iu,
      remix: /\b(remix|mix version)\b|混音|リミックス|리믹스|ремикс/iu,
      dj: /[([]\s*dj\b[^)\]]*[)\]]|[-–—]\s*dj\b[^()[\]]*$|\bdj[\p{Letter}\p{Number}\s._-]*(?:版|ver(?:sion)?\.?|(?:re)?mix)\s*[)\]]?\s*$/iu,
      acoustic: /\bacoustic\b|unplugged|弾き語り|アコースティック|어쿠스틱|акустич/iu,
      piano: /\bpiano\b|钢琴|鋼琴|ピアノ|피아노|фортепиано/iu,
      sped: /\b(sped[ -]?up|speed[ -]?up|nightcore)\b|加速|倍速/iu,
      slowed: /\bslowed\b|减速|減速|降速/iu
    };
    return Object.keys(markers).filter(key => markers[key].test(text));
  }

  function wantsEdited(value) {
    return /\b(clean|edited|censored|radio edit)\b|消音|和谐|和諧|洁版|潔版/iu.test(String(value || ""));
  }

  function compatibleVersion(track, candidate) {
    const chinese = chineseContext(track);
    const source = recordingVersions(track.name, track.album, chinese);
    const target = recordingVersions(candidate?.attributes?.name, candidate?.attributes?.albumName, chinese);
    const sourceLabels = namedVersions(track.name, chinese);
    const targetLabels = namedVersions(candidate?.attributes?.name, chinese);
    return source.length === target.length && source.every(version => target.includes(version)) &&
      sourceLabels.length === targetLabels.length && sourceLabels.every(label => targetLabels.includes(label));
  }

  function recordingVersions(name, album, chinese) {
    const markers = versions(name, chinese);
    const albumText = String(album || "").normalize("NFKC");
    const liveAlbum = /[([][^)\]]*\blive\b[^)\]]*[)\]]|\blive (?:at|in|from)\b|ライブ盤|现场专辑|現場專輯/iu.test(albumText);
    if (liveAlbum && !markers.includes("live")) markers.push("live");
    return markers;
  }

  function namedVersions(value, chinese) {
    const text = String(value || "").normalize("NFKC");
    const segments = Array.from(text.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/gu))
      .map(result => result[1] || result[2]);
    const suffix = text.match(/[-–—]\s*([^()\[\]]{1,60}?\s+ver(?:sion)?\.?)\s*[-–—]?$/iu);
    if (suffix) segments.push(suffix[1]);
    return strings(segments.filter(segment => /ver(?:sion)?\.?\s*$/iu.test(segment))
      .map(segment => comparisonText(segment.replace(/ver(?:sion)?\.?\s*$/iu, ""), chinese))
      .filter(label => label && !/^(original|studio|album|dj)$/.test(label) && !versions(label, chinese).length && !wantsEdited(label)));
  }

  function ratingBonus(track, candidate) {
    const edited = wantsEdited(track.name);
    const rating = candidate.attributes?.contentRating;
    if (edited) return rating === "clean" ? 0.025 : -0.08;
    let bonus = rating === "explicit" ? 0.045 : rating === "clean" ? -0.07 : 0;
    if (wantsEdited(candidate.attributes?.name)) bonus -= 0.04;
    return bonus;
  }

  function inspectCandidate(track, candidate) {
    const attributes = candidate?.attributes || {};
    const chinese = chineseContext(track);
    const sourceTitles = searchTitles(track).flatMap(name => titleForms(name, chinese));
    const title = bestSimilarity(sourceTitles, titleForms(attributes.name, chinese));
    const rawTitle = bestSimilarity(searchTitles(track).flatMap(name => titleForms(name)), titleForms(attributes.name));
    const sourceArtists = strings([track.artists || [], track.artistAliases || []]).map(value => comparisonText(value, chinese));
    const artist = artistSimilarity(sourceArtists, attributes.artistName, chinese);
    const sourceAlbums = strings([track.album, track.albumAliases || []]).map(value => comparisonText(value, chinese));
    const targetAlbum = comparisonText(attributes.albumName, chinese);
    const album = bestSimilarity(sourceAlbums, [targetAlbum]);
    const durationDifference = track.durationMs && attributes.durationInMillis
      ? Math.abs(track.durationMs - attributes.durationInMillis) : Infinity;
    const duration = durationDifference <= 2500 ? 0.16 : durationDifference <= 7000 ? 0.1 : 0;
    let reason = title < 0.65 ? "title_mismatch" : artist < 0.65 ? "artist_mismatch"
      : !compatibleVersion(track, candidate) ? "version_mismatch"
        : Number.isFinite(durationDifference) && durationDifference > 15000 ? "duration_mismatch"
          : rawTitle < 0.65 && durationDifference > 7000 ? "low_confidence" : null;
    const score = reason ? 0 : title * 0.5 + artist * 0.26 + duration + album * 0.08 + ratingBonus(track, candidate);
    if (!reason && score < acceptScore) reason = "low_confidence";
    return { score, reason, titleSimilarity: title, artistSimilarity: artist, durationDifferenceMs: durationDifference };
  }

  function scoreCandidate(track, candidate) {
    return inspectCandidate(track, candidate).score;
  }

  function creditScripts(value) {
    const credits = String(value || "").normalize("NFKC")
      .split(/\b(?:feat(?:uring)?|ft)\.?\s+|[&、,;]|\s+[x/]\s+/iu);
    const scripts = new Set();
    for (const text of credits) {
      if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) scripts.add("ja");
      else if (/\p{Script=Han}/u.test(text)) scripts.add("han");
      if (/\p{Script=Hangul}/u.test(text)) scripts.add("ko");
      if (/\p{Script=Cyrillic}/u.test(text)) scripts.add("ru");
      if (/\p{Script=Latin}/u.test(text)) scripts.add("latin");
    }
    return Array.from(scripts);
  }

  function independentAlbum(track, candidate) {
    const chinese = chineseContext(track);
    const titleNames = searchTitles(track).flatMap(name => titleForms(name, chinese));
    const artistNames = strings([track.artists || [], track.artistAliases || []]).map(value => comparisonText(value, chinese));
    const target = comparisonText(candidate.attributes?.albumName, chinese);
    return strings([track.album, track.albumAliases || []]).some(value => {
      const album = comparisonText(value, chinese);
      const base = album.replace(/(?:\s+(single|ep))+$/u, "");
      if (/^(album|unknown album|unknown|soundtrack|ost|single|ep|未知|未知专辑)$/u.test(base)) return false;
      const identity = base.replace(/ /g, "");
      return album && album === target &&
        ![...titleNames, ...artistNames].some(name => name.replace(/ /g, "") === identity);
    });
  }

  function mappedVersionCompatible(track, candidate) {
    const chinese = chineseContext(track);
    const source = recordingVersions(track.name, track.album, chinese);
    const labels = namedVersions(track.name, chinese);
    return recordingVersions(candidate.attributes?.name, candidate.attributes?.albumName, chinese)
      .every(version => source.includes(version)) &&
      namedVersions(candidate.attributes?.name, chinese).every(label => labels.includes(label));
  }

  function needsConfirmation(track, evidence) {
    const { candidate, inspection } = evidence;
    if (inspection.titleSimilarity !== 1) return false;
    if (inspection.artistSimilarity === 1) {
      return inspection.reason === "version_mismatch" || inspection.reason === "duration_mismatch";
    }
    if (inspection.reason !== "artist_mismatch" || inspection.durationDifferenceMs > 2500 ||
      !(compatibleVersion(track, candidate) || evidence.mappedVersion === true)) return false;
    const artists = strings([track.artists || [], track.artistAliases || []]);
    const targetScripts = creditScripts(candidate.attributes?.artistName);
    if (!artists.length || !targetScripts.length || partialArtistName(artists.map(normalizeText), candidate.attributes?.artistName)) return false;
    const overlaps = artist => creditScripts(artist).some(script => targetScripts.includes(script));
    const sameScript = artists.some(overlaps);
    const album = independentAlbum(track, candidate) || evidence.supportingAlbum === true;
    const knownAliasConflict = strings(track.artistAliases || []).some(overlaps);
    if (knownAliasConflict || (sameScript && !album)) return false;
    return album || searchTitles(track).some(name => normalizeText(name).replace(/ /g, "").length >= 8);
  }

  function compareEvidence(left, right) {
    const confidence = inspection => inspection.titleSimilarity * 0.5 + inspection.artistSimilarity * 0.26;
    return confidence(right.inspection) - confidence(left.inspection) ||
      left.inspection.durationDifferenceMs - right.inspection.durationDifferenceMs ||
      right.inspection.score - left.inspection.score;
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
    const alias = strings(track.artistAliases || []).find(value => normalizeText(value) !== normalizeText(artist));
    const queries = names.length ? [names[0] + " " + artist] : [];
    if (alias) queries.push(names[0] + " " + alias);
    for (const name of names.slice(1)) queries.push(name + " " + artist);
    if (names.length) queries.push(names[0]);
    for (const name of names.slice(1)) queries.push(name);
    return strings(queries).filter(query => query.normalize("NFKC").length <= 256).slice(0, 6);
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
    const reviewIsrcs = new Set();
    const targetEvidence = new Map();
    let sawTargetResults = false;
    let identifiedUnavailable = false;
    function collectTargetCandidates(candidates, nativeEvidence = []) {
      if (candidates.length) sawTargetResults = true;
      for (const candidate of candidates) {
        if (!candidate?.id || !candidate.attributes) continue;
        let inspection = inspectCandidate(track, candidate);
        const identified = nativeEvidence.find(entry => entry.candidate.attributes.isrc === candidate.attributes.isrc);
        if (identified && inspection.artistSimilarity === 0) {
          inspection = { ...inspection, score: 0, reason: "artist_mismatch", titleSimilarity: identified.inspection.titleSimilarity };
        }
        const evidence = { candidate, inspection, supportingAlbum: identified && independentAlbum(track, identified.candidate),
          mappedVersion: Boolean(identified && mappedVersionCompatible(track, candidate)) };
        const key = String(candidate.id);
        const previous = targetEvidence.get(key);
        const comparison = previous ? compareEvidence(evidence, previous) : -1;
        if (previous && comparison === 0 && candidate.attributes.isrc &&
          previous.candidate.attributes.isrc === candidate.attributes.isrc) {
          evidence.supportingAlbum = Boolean(evidence.supportingAlbum || previous.supportingAlbum);
          evidence.mappedVersion = evidence.mappedVersion || previous.mappedVersion;
        }
        if (!previous || comparison < 0 || (comparison === 0 &&
          ((evidence.supportingAlbum && !previous.supportingAlbum) || (evidence.mappedVersion && !previous.mappedVersion)))) {
          targetEvidence.set(key, evidence);
        }
      }
    }
    if (!track.name || !queries.length) {
      if (options.onUnmatched) options.onUnmatched({ reason: "unconfirmed", storefront, candidates: [] });
      return null;
    }
    if (track.isrc && options.resolveIsrc) {
      const direct = verifiedMatch(track, await options.resolveIsrc(storefront, [track.isrc]), [track.isrc]);
      if (direct) return direct;
      resolvedIsrcs.add(track.isrc);
    }
    let best = null;
    let mappedForReview = false;
    const targetCandidates = await options.search(storefront, queries[0]);
    collectTargetCandidates(targetCandidates);
    best = scoreCandidates(track, targetCandidates);
    if (best && best.score >= strongScore) return best;
    const hasInitialAlternatives = Array.from(targetEvidence.values()).some(evidence =>
      evidence.inspection.artistSimilarity === 1 && needsConfirmation(track, evidence));
    const searched = new Set([queries[0]]);
    const sourceNames = searchTitles(track);
    const hasArtistAlias = strings(track.artistAliases || []).some(alias => normalizeText(alias) !== normalizeText(track.artists?.[0]));
    const identifiedTitle = Array.from(targetEvidence.values()).some(evidence => evidence.inspection.titleSimilarity === 1);
    const earlyQueries = hasArtistAlias || !identifiedTitle
      ? queries.slice(1).filter(query => !sourceNames.includes(query)).slice(0, 2) : [];
    if (!hasInitialAlternatives && !identifiedTitle && queries.includes(sourceNames[0]) && !searched.has(sourceNames[0])) {
      earlyQueries.push(sourceNames[0]);
    }
    for (const query of earlyQueries) {
      const candidates = await options.search(storefront, query);
      searched.add(query);
      collectTargetCandidates(candidates);
      const result = scoreCandidates(track, candidates);
      if (result && (!best || result.score > best.score)) best = result;
      if (best && best.score >= strongScore) return best;
    }
    if (options.resolveIsrc && !hasInitialAlternatives) {
      const nativeQueries = strings([queries[0], sourceNames[0]]).filter(query => query.normalize("NFKC").length <= 256);
      for (const native of nativeStorefronts(track).filter(region => region !== storefront)) {
        for (const query of nativeQueries) {
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
          if (!isrcs.length) {
            const ambiguous = candidates.filter(candidate => candidate.attributes?.isrc)
              .map(candidate => ({ candidate, inspection: inspectCandidate(track, candidate) }))
              .filter(evidence => evidence.inspection.reason === "artist_mismatch" && needsConfirmation(track, evidence))
              .sort(compareEvidence).slice(0, 3);
            const uncertainIsrcs = strings(ambiguous.map(evidence => evidence.candidate.attributes.isrc))
              .filter(isrc => !resolvedIsrcs.has(isrc)).slice(0, Math.max(0, 3 - reviewIsrcs.size));
            if (uncertainIsrcs.length) {
              uncertainIsrcs.forEach(isrc => reviewIsrcs.add(isrc));
              const knownRecordings = Array.from(targetEvidence.values()).map(evidence => evidence.candidate)
                .filter(candidate => uncertainIsrcs.includes(candidate.attributes.isrc) && compatibleVersion(track, candidate) &&
                  inspectCandidate(track, candidate).durationDifferenceMs <= 2500);
              const missingIsrcs = uncertainIsrcs.filter(isrc => !knownRecordings.some(candidate => candidate.attributes.isrc === isrc));
              const recordings = [...knownRecordings, ...(missingIsrcs.length ? await options.resolveIsrc(storefront, missingIsrcs) : [])];
              uncertainIsrcs.forEach(isrc => resolvedIsrcs.add(isrc));
              const accountCandidates = recordings.filter(candidate => uncertainIsrcs.includes(candidate.attributes?.isrc));
              collectTargetCandidates(accountCandidates, ambiguous);
              const result = scoreCandidates(track, accountCandidates);
              if (result && (!best || result.score > best.score)) best = result;
              if (best && best.score >= strongScore) return best;
              mappedForReview = accountCandidates.some(candidate => {
                const evidence = targetEvidence.get(String(candidate.id));
                return evidence && needsConfirmation(track, evidence);
              });
              if (mappedForReview) break;
            }
            continue;
          }
          const known = verifiedMatch(track, Array.from(targetEvidence.values()).map(evidence => evidence.candidate), isrcs);
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
        if (mappedForReview) break;
      }
    }
    const fallbackQueries = mappedForReview ? strings([sourceNames[0]]) : queries.slice(1, best ? 2 : queries.length);
    for (const query of fallbackQueries.filter(query => query.normalize("NFKC").length <= 256)) {
      if (searched.has(query)) continue;
      const candidates = await options.search(storefront, query);
      collectTargetCandidates(candidates);
      const result = scoreCandidates(track, candidates);
      if (result && (!best || result.score > best.score)) best = result;
      if (best && best.score >= strongScore) return best;
    }
    if (!best && options.onUnmatched) {
      const evidence = Array.from(targetEvidence.values()).sort(compareEvidence);
      const alternatives = evidence.filter(entry => needsConfirmation(track, entry)).slice(0, 3);
      const reason = alternatives[0]?.inspection.reason || evidence[0]?.inspection.reason ||
        (identifiedUnavailable ? "recording_unavailable" : sawTargetResults ? "unconfirmed" : "no_results");
      const candidates = alternatives.map(entry => ({ ...entry.candidate, confirmationReason: entry.inspection.reason }));
      options.onUnmatched({ reason, storefront, candidates });
    }
    return best;
  }

  return { normalizeText, buildSearchQueries, nativeStorefronts, inspectCandidate, scoreCandidate, scoreCandidates, match };
}
