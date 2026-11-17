# make.fun Submissions

Monorepo berisi semua submission kompetisi **make.fun** yang dikerjakan di akun @alwi (alwialhuda11).

## Isi

| Direktori | Kompetisi | Deskripsi |
|---|---|---|
| `btc-race/` | Race a BTC trading bot live for 24 hours | Bot trading BTC (TypeScript), entry-timed buy-and-hold, protocol `bars-replay/v1` |
| `tiny-chess/` | Tiny chess | Engine catur mikro (Python) |
| `github-core-clone/` | GitHub core clone | Klon inti GitHub (TypeScript) |
| `threejs-fps/` | Three.js FPS | Game FPS Three.js (HTML/JS) |

## Struktur tiap submission

Setiap direktori submission berisi:
- **Kode entry** (bot/engine/game)
- `main.ts` / `main.py` — entrypoint
- `.makefun/freshness.json` — anchor drand + wallet address (bukti waktu pembuatan)

## Keamanan

File berikut **sengaja tidak** dimasukkan (bersifat rahasia):
- `makefun-keypair.json` — private key wallet make.fun
- `transcripts.tar.gz` — transcript session yang berisi data internal

## Cara menjalankan

Lihat `README.md` / dokumentasi di dalam tiap direktori submission masing-masing.
