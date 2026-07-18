# Engine benchmark results — WebTorrent vs TorrServer

Per engine: **TTFB · avg download speed · peers · peak RSS**. WebTorrent RSS = peak (+growth over Node baseline); TorrServer = Go process. Throughput = engine-reported download rate averaged over 30s (immune to read-buffer artifacts).

| when | torrent | WebTorrent | TorrServer |
|---|---|---|---|
| 2026-06-13 init | Sintel (web-seeded — biased toward WebTorrent) | 3.4s · 9.14 MB/s · 196.0MB (+141.7) | 4.4s · 2.43 MB/s · 189.1MB |
| 2026-06-13 init | Ubuntu 24.04.3 desktop ISO (pure BT, no web seed) | error: no peer data within timeout (early harness hung before timeouts existed) | error: not run — WebTorrent phase hung first (since fixed) |
| 2026-06-13 08:40 | One Piece 1165 (1080p anime) | 3.3s · 22.00 MB/s · 48p · 270.0MB (+209.3) | 5.1s · 7.28 MB/s · 19p · 191.4MB |
| 2026-06-13 08:41 | Matrix Revolutions 2160p UHD | 5.5s · 2.60 MB/s · 5p · 428.1MB (+246.6) | 4.0s · 0.13 MB/s · 8p · 97.9MB |
| 2026-06-13 08:43 | LotR Return of the King 1080p EXT | 21.8s · 4.88 MB/s · 3p · 379.7MB (+201.6) | 2.7s · 1.13 MB/s · 4p · 143.8MB |
