// The match and round manager: two-teams economy, short rounds won by elimination or the bomb
// objective, money between rounds spent in a buy menu, and the round timer. Owns the flow;
// main.js tells it about events (kills, bomb planted, timer) and reads its state for the HUD.
import { WEAPONS } from './weapon.js';

const ROUND_TIME = 100; // seconds of action per round
const BUY_TIME = 15;
const BOMB_FUSE = 35;
const START_MONEY = 800;
const WIN_BONUS = 3200;
const LOSS_BONUS = 1900;
const KILL_BONUS = 300;
const BOMB_PLANT_BONUS = 300;
const BOMB_EXPLODE_BONUS = 400;

// Buy menu prices.
export const PRICES = {
  pistol: 0,
  rifle: 2700,
  smg: 1600,
  grenade: 300,
};

export function createMatch() {
  const match = {
    round: 1,
    score: { attacker: 0, defender: 0 },
    money: START_MONEY,
    phase: 'buy', // buy | live | end
    phaseTime: BUY_TIME,
    roundTime: ROUND_TIME,
    bombTimer: 0,
    bombPlanted: false,
    bombSite: null,
    roundResult: null,
    kills: 0,
    playerAlive: true,
    lastRoundResult: null,
  };

  function addMoney(n) {
    match.money = Math.max(0, match.money + n);
  }

  function spend(price) {
    if (match.money < price) return false;
    match.money -= price;
    return true;
  }

  function onKill(kind) {
    match.kills += 1;
    addMoney(KILL_BONUS);
  }

  function onBombPlanted() {
    match.bombPlanted = true;
    match.bombTimer = BOMB_FUSE;
    addMoney(BOMB_PLANT_BONUS);
  }

  function onBombExploded() {
    const result = { winner: 'attacker', reason: 'Bomb detonated' };
    endRound(result);
    addMoney(BOMB_EXPLODE_BONUS);
  }

  function onBombDefused() {
    endRound({ winner: 'defender', reason: 'Bomb defused' });
  }

  function onPlayerDied() {
    endRound({ winner: 'defender', reason: 'Attacker eliminated' });
  }

  function onAllDefendersDead() {
    endRound({ winner: 'attacker', reason: 'Defenders eliminated' });
  }

  function endRound(result) {
    match.phase = 'end';
    match.roundResult = result;
    match.lastRoundResult = result;
    match.score[result.winner] += 1;
    // Economy reward: win or loss bonus.
    if (result.winner === 'attacker') addMoney(WIN_BONUS);
    else addMoney(LOSS_BONUS);
  }

  function startRound() {
    match.round += 1;
    match.phase = 'buy';
    match.phaseTime = BUY_TIME;
    match.roundTime = ROUND_TIME;
    match.bombPlanted = false;
    match.bombTimer = 0;
    match.roundResult = null;
    match.playerAlive = true;
  }

  function tick(dt) {
    if (match.phase === 'buy') {
      match.phaseTime -= dt;
      if (match.phaseTime <= 0) {
        match.phase = 'live';
        match.roundTime = ROUND_TIME;
      }
      return;
    }
    if (match.phase === 'live') {
      if (match.bombPlanted) {
        match.bombTimer -= dt;
        if (match.bombTimer <= 0) {
          match.bombTimer = 0;
          onBombExploded();
          return;
        }
      } else {
        match.roundTime -= dt;
        if (match.roundTime <= 0) {
          match.roundTime = 0;
          endRound({ winner: 'defender', reason: 'Time expired' });
          return;
        }
      }
    }
    // In 'end' phase, the user presses to go next round (main.js handles).
  }

  function buyWeapon(key) {
    if (match.phase !== 'buy') return false;
    const price = PRICES[key];
    if (price === undefined) return false;
    if (!spend(price)) return false;
    return key;
  }

  return {
    match,
    tick,
    onKill,
    onBombPlanted,
    onBombExploded,
    onBombDefused,
    onPlayerDied,
    onAllDefendersDead,
    startRound,
    addMoney,
    spend,
    buyWeapon,
  };
}
