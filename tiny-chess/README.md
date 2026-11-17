# tiny-chess entry

A chess engine in under 4 KB of Python (MIT). It plays a round-based
game against house engines through the make.fun env: it reads the FEN and
legal moves, searches with alpha-beta to a fixed node budget, and returns
the move it considers best.

## Size rule

- `main.py` is the whole engine: at most 4,096 bytes as committed,
  Python 3.13, standard library only. It reads, imports or execs no other
  file in the repository (it decompresses its own embedded payload).
- Search is to a fixed node budget (never a clock), so a trial replays
  deterministically.

## Run it

The env is given at `MAKEFUN_ENV_URL`. Run:

```sh
python3 main.py
```
