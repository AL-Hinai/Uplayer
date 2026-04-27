# Torrent Naming Survey — Report

Generated from `scripts\data\torrent-naming-data.json`.

- Corpus generated: 2026-04-27T20:04:59.700Z
- Shows surveyed: 198
- Records: 6104 (0 source errors)
- Sources: 1337x, YTS, PirateBay, Nyaa, SubsPlease

---

## 1. Per-source naming patterns (anime shows)

| Source | Total | SE_PAIR | LONGFORM | ANIME_SEASON_DASH | EP_ONLY | ANIME_DASH | SEASON_ONLY | NONE |
|--------|-------|------|------|------|------|------|------|------|
| 1337x | 0 | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| YTS | 0 | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| PirateBay | 948 | 676 (71.3%) | 0 (0.0%) | 2 (0.2%) | 9 (0.9%) | 52 (5.5%) | 26 (2.7%) | 183 (19.3%) |
| Nyaa | 2183 | 708 (32.4%) | 0 (0.0%) | 59 (2.7%) | 46 (2.1%) | 356 (16.3%) | 245 (11.2%) | 769 (35.2%) |
| SubsPlease | 714 | 0 (0.0%) | 0 (0.0%) | 168 (23.5%) | 0 (0.0%) | 510 (71.4%) | 3 (0.4%) | 33 (4.6%) |

## 1b. Per-source naming patterns (live-action shows)

| Source | Total | SE_PAIR | LONGFORM | ANIME_SEASON_DASH | EP_ONLY | ANIME_DASH | SEASON_ONLY | NONE |
|--------|-------|------|------|------|------|------|------|------|
| 1337x | 0 | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| YTS | 0 | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) |
| PirateBay | 1746 | 1660 (95.1%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 74 (4.2%) | 12 (0.7%) |
| Nyaa | 420 | 142 (33.8%) | 0 (0.0%) | 0 (0.0%) | 4 (1.0%) | 33 (7.9%) | 22 (5.2%) | 219 (52.1%) |
| SubsPlease | 93 | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 87 (93.5%) | 0 (0.0%) | 6 (6.5%) |

**Reading the table:** `SE_PAIR` = `SxxExx` style; `EP_ONLY` = episode tag with no season; `ANIME_DASH` = `Show - NN`; `SEASON_ONLY` = season tag with no episode (likely a season pack); `NONE` = no recognizable S/E.

---

## 2. "S omitted, only E present" cases

These are torrents for shows in **Season 2 or later** whose names tag only the episode and never the season. The user specifically flagged this — the production filter must accept them as implicit-season matches when no contradicting season tag is present.

- **Nyaa** — `[Anime Time] Dragon Ball Z Complete Series (Colour Corrected) (With Fixed Episodes & Missing EP218) [SoM] [DVD] [Dual Audio] [480p][HEVC 10bit x265][AAC,AC3][Eng Sub] [Batch]` _(Dragon Ball Z (tmdbId=12971, S9), parsed E218 vs requested E38, 24 seeders)_
- **Nyaa** — `[Anime Time] Dragon Ball Z Episode 87 & 276 (Fixed) (Colour Corrected) [SoM] [DVD] [Dual Audio] [480p][HEVC 10bit x265][AAC,AC3][Eng Sub]` _(Dragon Ball Z (tmdbId=12971, S9), parsed E87 vs requested E38, 26 seeders)_
- **Nyaa** — `[Anime Time] Dragon Ball Z Episode 20 (Fixed) (Colour Corrected) [SoM] [DVD] [Dual Audio] [480p][HEVC 10bit x265][AAC,AC3][Eng Sub]` _(Dragon Ball Z (tmdbId=12971, S9), parsed E20 vs requested E38, 2 seeders)_
- **Nyaa** — `Naruto Shippuden Multi Audio DD 2.0 (EP 197 - 220 ) 1080p 10bit AV1` _(Naruto (tmdbId=46260, S4), parsed E197 vs requested E220, 11 seeders)_
- **Nyaa** — `One.Piece.E1159.VOSTFR.1080p.WEBRiP.x265-KAF` _(One Piece (tmdbId=37854, S23), parsed E1159 vs requested E1159, 96 seeders)_
- **Nyaa** — `[ToonsHub] One Piece EP1159 2160p BILI WEB-DL AAC2.0 H.264 (Multi-Subs)` _(One Piece (tmdbId=37854, S23), parsed E1159 vs requested E1159, 435 seeders)_
- **Nyaa** — `[ToonsHub] One Piece EP1159 1080p BILI WEB-DL AAC2.0 H.265 (Multi-Subs)` _(One Piece (tmdbId=37854, S23), parsed E1159 vs requested E1159, 80 seeders)_
- **Nyaa** — `One.Piece.E1159.VOSTFR.1080p.WEBRiP.x265-KAF` _(One Piece (tmdbId=37854, S23), parsed E1159 vs requested E1159, 96 seeders)_
- **Nyaa** — `[ToonsHub] One Piece EP1159 2160p BILI WEB-DL AAC2.0 H.264 (Multi-Subs)` _(One Piece (tmdbId=37854, S23), parsed E1159 vs requested E1159, 435 seeders)_
- **Nyaa** — `[ToonsHub] One Piece EP1159 1080p BILI WEB-DL AAC2.0 H.265 (Multi-Subs)` _(One Piece (tmdbId=37854, S23), parsed E1159 vs requested E1159, 80 seeders)_
- **Nyaa** — `[CUMiSYUM] Hunter x Hunter (2011) E59-E70 (BD 1080p Opus) [Dual-Audio]` _(Hunter x Hunter (tmdbId=46298, S3), parsed E59 vs requested E148, 6 seeders)_
- **Nyaa** — `[AnimeRG] Hunter x Hunter (2011) Complete Series (EP 001-148) [1080p] [BD] [Batch] [x265] [pseudo]` _(Hunter x Hunter (tmdbId=46298, S3), parsed E1 vs requested E148, 5 seeders)_
- **Nyaa** — `[EssAirTé] JoJo's Bizarre Adventure STEEL BALL RUN - EP01 VOSTFR-custom` _(JoJo's Bizarre Adventure (tmdbId=45790, S6), parsed E1 vs requested E1, 7 seeders)_
- **PirateBay** — `Tokyo.Ghoul.Re.E04.SUBBED.WEB.x264-DARKFLiX` _(Tokyo Ghoul (tmdbId=61374, S4), parsed E4 vs requested E12, 1 seeders)_
- **PirateBay** — `Tokyo.Ghoul.Re.E01.DUBBED.WEB.x264-DARKFLiX` _(Tokyo Ghoul (tmdbId=61374, S4), parsed E1 vs requested E12, 1 seeders)_
- **PirateBay** — `Tokyo.Ghoul.Re.E07.SUBBED.WEB.x264-DARKFLiX` _(Tokyo Ghoul (tmdbId=61374, S4), parsed E7 vs requested E12, 1 seeders)_
- **PirateBay** — `Tokyo.Ghoul.Re.E08.SUBBED.WEB.x264-DARKFLiX` _(Tokyo Ghoul (tmdbId=61374, S4), parsed E8 vs requested E12, 1 seeders)_
- **Nyaa** — `[Ommex] Doraemon (2005) Episode 911 [ENG SUB][1080p x265 AAC]` _(Doraemon (tmdbId=57911, S27), parsed E911 vs requested E28, 8 seeders)_
- **Nyaa** — `[Ommex] Doraemon (2005) Episode 910 [ENG SUB][1080p x265 AAC]` _(Doraemon (tmdbId=57911, S27), parsed E910 vs requested E28, 5 seeders)_
- **Nyaa** — `[Ommex] Doraemon (2005) Episode 909 [ENG SUB][1080p x265 AAC]` _(Doraemon (tmdbId=57911, S27), parsed E909 vs requested E28, 5 seeders)_
- **Nyaa** — `[Ommex] Doraemon (2005) Episode 908 [ENG SUB][1080p x265 AAC]` _(Doraemon (tmdbId=57911, S27), parsed E908 vs requested E28, 29 seeders)_
- **PirateBay** — `Mobile.Suit.Gundam.Seed.E02.REMASTERED.WEB.x264-ANiURL` _(Mobile Suit Gundam SEED (tmdbId=20111, S2), parsed E2 vs requested E50, 1 seeders)_
- **Nyaa** — `[DKB] Kaguya-sama: Love Is War - Stairway to Adulthood - E02 (OVA)[1080p][HEVC x265 10bit][Multi-Subs]` _(Kaguya-sama: Love Is War (tmdbId=83121, S3), parsed E2 vs requested E13, 18 seeders)_
- **Nyaa** — `[DKB] Kaguya-sama: Love Is War - Stairway to Adulthood - E01 (OVA)[1080p][HEVC x265 10bit][Multi-Subs]` _(Kaguya-sama: Love Is War (tmdbId=83121, S3), parsed E1 vs requested E13, 20 seeders)_
- **Nyaa** — `[BDRAWS] Code Geass Lelouch of the Rebellion R2 ep 01 [1920x1080 x264 AAC][b50e522c].mp4` _(Code Geass: Lelouch of the Rebellion (tmdbId=31724, S2), parsed E1 vs requested E25, 0 seeders)_
- **Nyaa** — `Rurouni.Kenshin.(2023).E47.Final.WEBRip.x264-H3AsO3` _(Rurouni Kenshin (tmdbId=28136, S3), parsed E47 vs requested E32, 1 seeders)_
- **Nyaa** — `Rurouni.Kenshin.(2023).E46.Llàgrimes.WEBRip.x264-H3AsO3` _(Rurouni Kenshin (tmdbId=28136, S3), parsed E46 vs requested E32, 3 seeders)_
- **Nyaa** — `Rurouni.Kenshin.(2023).E45.El.Gran.Foc.de.Kyoto.Part.3.WEBRip.x264-H3AsO3` _(Rurouni Kenshin (tmdbId=28136, S3), parsed E45 vs requested E32, 1 seeders)_
- **Nyaa** — `One.Piece.E1159.VOSTFR.1080p.WEBRiP.x265-KAF` _(ONE PIECE (tmdbId=111110, S2), parsed E1159 vs requested E8, 97 seeders)_
- **Nyaa** — `[ToonsHub] One Piece EP1159 2160p BILI WEB-DL AAC2.0 H.264 (Multi-Subs)` _(ONE PIECE (tmdbId=111110, S2), parsed E1159 vs requested E8, 434 seeders)_
- _…and 1 more (see torrent-naming-summary.json)._

Total observed: **31**

---

## 3. Year-collision risks

Torrent names whose embedded year differs from the show's TMDB first-air year by ≥ 2 years. These are usually same-titled different shows (the `One Piece (1999)` vs `One Piece (2023)` case).

- **Nyaa** — `Yoshimasa Terui (照井順政) - Jujutsu Kaisen the Culling Game Part 1 (呪術廻戦 死滅回游 前編 ORIGINAL SOUNDTRACK) - 2026 (WEB - FLAC)` _(asked about JUJUTSU KAISEN (2020), name says 2026)_
- **PirateBay** — `Doraemon The Movie Nobitas Sky Utopia 2023 1080P Japanese BluRay HEVC x265 5.1` _(asked about Doraemon (2005), name says 2023)_
- **PirateBay** — `Doraemon.the.Movie.Nobitas.Secret.Gadget.Museum.2013.1080p.BluRa` _(asked about Doraemon (2005), name says 2013)_
- **PirateBay** — `Stand By Me Doraemon 1 And 2 2014-2020 720p.BluRay x264 Mkvking` _(asked about Doraemon (2005), name says 2014)_
- **PirateBay** — `Doraemon The Movie Nobitas Earth Symphony (2024) 1080p BluRay 5.1-WORLD` _(asked about Doraemon (2005), name says 2024)_
- **PirateBay** — `Doraemon.Nobita.and.the.Island.of.Miracles.Animal.Adventure.2012` _(asked about Doraemon (2005), name says 2012)_
- **PirateBay** — `Doraemon Nobitas New Dinosaur 2020 720p Japanese BluRay H264` _(asked about Doraemon (2005), name says 2020)_
- **PirateBay** — `Doraemon The Movie Nobitas Sky Utopia (2023) 1080p BluRay 5.1-WORLD` _(asked about Doraemon (2005), name says 2023)_
- **PirateBay** — `Doraemon The Movie Nobitas Earth Symphony (2024) 720p BluRay-WORLD` _(asked about Doraemon (2005), name says 2024)_
- **Nyaa** — `[Ommex] Doraemon Movie 21: Nobita's Legend of the Sun King (2000) [ENG SUB][1080p x265 EAC3 6ch]` _(asked about Doraemon (2005), name says 2000)_
- **Nyaa** — `[夜莺家族&YYQ字幕组]New Doraemon 哆啦A梦新番[911][2026.04.18][AVC][1080P][GB_JP]` _(asked about Doraemon (2005), name says 2026)_
- **Nyaa** — `[夜莺家族&YYQ字幕组]New Doraemon 哆啦A梦新番[910][2026.04.11][AVC][1080P][GB_JP]` _(asked about Doraemon (2005), name says 2026)_
- **Nyaa** — `[ZG] Doraemon Movie 44 - Nobita's Art World Tales (2025) (BDRip 1080p x264 10-bit CRF16 DD-AC3 2.0 DD-AC3 5.1)` _(asked about Doraemon (2005), name says 2025)_
- **Nyaa** — `[Polarwindz] Stand by Me Doraemon (2014) (BD 1080p HEVC Multi-Audio)` _(asked about Doraemon (2005), name says 2014)_
- **Nyaa** — `[NanakoRaws] Doraemon (1979) - 1769-1778 (EX-CS2 TV 1080p HEVC AAC)` _(asked about Doraemon (2005), name says 1979)_
- **Nyaa** — `[夜莺家族&YYQ字幕组]New Doraemon 哆啦A梦新番[909][2026.04.04][AVC][1080P][GB_JP]` _(asked about Doraemon (2005), name says 2026)_
- **Nyaa** — `[夜莺家族&YYQ字幕组]New Doraemon 哆啦A梦新番[908][2026.03.28][AVC][1080P][GB_JP]` _(asked about Doraemon (2005), name says 2026)_
- **PirateBay** — `Bleach Sennen Kessen Hen S01E22 2022 1080p Baha WEB-DL x264 AAC-ADWeb` _(asked about Bleach (2004), name says 2022)_
- **PirateBay** — `BLEACH Sennen Kessen hen S01E40 2024 1080p Baha WEB-DL x264 AAC-ADWeb` _(asked about Bleach (2004), name says 2024)_
- **PirateBay** — `Bleach Sennen Kessen Hen S01E25 2022 1080p Baha WEB-DL x264 AAC-ADWeb` _(asked about Bleach (2004), name says 2022)_
- **PirateBay** — `Bleach Sennen Kessen Hen S01E26 2022 1080p Baha WEB-DL x264 AAC-ADWeb` _(asked about Bleach (2004), name says 2022)_
- **PirateBay** — `BLEACH Sennen Kessen hen S01E27 2024 1080p Baha WEB-DL x264 AAC-ADWeb` _(asked about Bleach (2004), name says 2024)_
- **PirateBay** — `BLEACH Sennen Kessen hen S01E33 2024 1080p Baha WEB-DL x264 AAC-ADWeb` _(asked about Bleach (2004), name says 2024)_
- **PirateBay** — `The Girlfriend 2025 S01E01 1080p WEB h264-GRACE` _(asked about Girlfriend, Girlfriend (2021), name says 2025)_
- **PirateBay** — `The Girlfriend 2025 S01E06 1080p WEB h264-GRACE` _(asked about Girlfriend, Girlfriend (2021), name says 2025)_
- **PirateBay** — `The Girlfriend 2025 S01E04 1080p HEVC x265-MeGusta` _(asked about Girlfriend, Girlfriend (2021), name says 2025)_
- **PirateBay** — `The Girlfriend 2025 S01E02 1080p WEB h264-GRACE` _(asked about Girlfriend, Girlfriend (2021), name says 2025)_
- **PirateBay** — `The Girlfriend 2025 S01E05 1080p HEVC x265-MeGusta` _(asked about Girlfriend, Girlfriend (2021), name says 2025)_
- **PirateBay** — `The Girlfriend 2025 S01E04 1080p WEB h264-GRACE` _(asked about Girlfriend, Girlfriend (2021), name says 2025)_
- **PirateBay** — `The Girlfriend 2025 S01E01 1080p HEVC x265-MeGusta` _(asked about Girlfriend, Girlfriend (2021), name says 2025)_
- _…and 439 more (see torrent-naming-summary.json)._

Total observed: **469**

---

## 4. Cross-show contamination (bare-title query)

When the search query is just `{title}`, results whose name doesn't even contain the title prefix.

- **Nyaa** — `Jujutsu.Kaisen.S03.MULTi.1080p.WEBRiP.x265-KAF` _(query: JUJUTSU KAISEN)_
- **Nyaa** — `Jujutsu.Kaisen.S03E12.FiNAL.MULTi.1080p.WEBRiP.x265-KAF` _(query: JUJUTSU KAISEN)_
- **PirateBay** — `The Girlfriend 2025 S01E01 1080p WEB h264-GRACE` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `Friends S02E01 The One with Rosss New Girlfriend 1080p HMAX WEB-DL DDP5 1 H` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `The Girlfriend 2025 S01E06 1080p WEB h264-GRACE` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `The.Red.Green.Show.S06E15.The.Girlfriend.1080p.WEB.H264-13` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `The Girlfriend 2025 S01E04 1080p HEVC x265-MeGusta` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `Greys Anatomy S15E12 Girlfriend in a Coma 1080p WEBRip 10Bit DDP2 0 HEVC-d3` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `The Girlfriend 2025 S01E02 1080p WEB h264-GRACE` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `The Girlfriend 2025 S01E05 1080p HEVC x265-MeGusta` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `The Girlfriend 2025 S01E04 1080p WEB h264-GRACE` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `The Girlfriend 2025 S01E01 1080p HEVC x265-MeGusta` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `[Yameii] Rent-a-Girlfriend - S05E01 [English Dub] [CR WEB-DL 1080p H264 AAC] [33F7E2D2] (Kanojo, Okarishimasu Season 5 | S5)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `[Yameii] Rent-a-Girlfriend - S05E01 [English Dub] [CR WEB-DL 720p H264 AAC] [EAC8DC29] (Kanojo, Okarishimasu Season 5 | S5)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `[Judas] Kanojo Okarishimasu (Rent-A-Girlfriend) - S05E03 [1080p][HEVC x265 10bit][Multi-Subs] (Weekly)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `Rent a Girlfriend S05E01 Ex-Girlfriend Nanami Mami 1080p CR WEB-DL DUAL AAC2.0 H 264-VARYG (Kanojo, Okarishimasu 5th Season, Dual-Audio, Multi-Subs)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `Rent a Girlfriend S05E03 The End of the Girlfriend 1080p CR WEB-DL AAC2.0 H 264-VARYG (Kanojo, Okarishimasu 5th Season, Multi-Subs)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `Rent-a-Girlfriend S05E03 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws (CR) (Kanojo, Okarishimasu 5th Season,Rent-a-Girlfriend Season 5)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `[ToonsHub] Rent-a-Girlfriend S05E03 1080p CR WEB-DL AAC2.0 H.264 (Kanojo, Okarishimasu, Multi-Subs)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `[ToonsHub] Rent-a-Girlfriend S05E01 1080p CR WEB-DL DUAL AAC2.0 H.264 (Kanojo, Okarishimasu, Dual-Audio, Multi-Subs)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `Rent-a-Girlfriend S05E03 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) (Kanojo, Okarishimasu 5th Season,Rent-a-Girlfriend Season 5)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `[goon] Rent-a-Girlfriend - S05E02 [UNCENSORED WEB-DL 1080p] | Kanojo, Okarishimasu` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `Rent-a-Girlfriend S05E02 VOSTFR UNCENSORED 1080p WEB x264 AAC -LesPoroïniens (DMM) (Kanojo, Okarishimasu 5th Season,Rent-a-Girlfriend Season 5)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `[ToonsHub] Kanojo, Okarishimasu S05E02 1080p UNCENSORED DMM WEB-DL AAC2.0 H.264 (Rent-a-Girlfriend)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `[Judas] Kanojo Okarishimasu (Rent-A-Girlfriend) - S05E02 [1080p][HEVC x265 10bit][Multi-Subs] (Weekly)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `Rent-a-Girlfriend S05E02 VOSTFR 1080p WEB x264 AAC -Tsundere-Raws (CR) (Kanojo, Okarishimasu 5th Season,Rent-a-Girlfriend Season 5)` _(query: Girlfriend, Girlfriend)_
- **Nyaa** — `Rent-a-Girlfriend S05E02 VOSTFR 720p WEB x264 AAC -Tsundere-Raws (CR) (Kanojo, Okarishimasu 5th Season,Rent-a-Girlfriend Season 5)` _(query: Girlfriend, Girlfriend)_
- **PirateBay** — `[SMC] Pok&eacute;mon - Mewtwo Returns Dual Audio` _(query: Pokémon)_
- **PirateBay** — `Pok&eacute;mon Detective Pikachu (2019) [BluRay] [3D]` _(query: Pokémon)_
- **PirateBay** — `[EeveeTaku] Pok&eacute;mon Origins - 04 v0 (1280x720 x264 AAC)[F` _(query: Pokémon)_
- _…and 976 more (see torrent-naming-summary.json)._

Total observed: **1006**

---

## 5. Classifier hit rate (shared rules in `core/torrent-name-patterns.js`)

Of every torrent in the corpus, what fraction does the candidate classifier flag as a real match for the requested S/E?

| Outcome | Count | % of corpus |
|---|---|---|
| Any match | 1924 | 31.5% |
| Exact S##E## match | 1614 | 26.4% |
| Long-form "Season X Episode Y" | 0 | 0.0% |
| Episode-only (S omitted) | 15 | 0.2% |
| Anime " - NN" | 214 | 3.5% |
| Anime absolute episode | 298 | 4.9% |
| Wrong-season rejection | 647 | 10.6% |

Total records classified: **6104**.

> A high "Any match" % across both anime and live-action sources indicates the rule set generalises. A high "Wrong-season rejection" indicates how often the source returned a wrong-season result that we successfully rejected.

---

## 6. Failed source calls

_None._
