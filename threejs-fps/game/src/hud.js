// The DOM HUD: crosshair, hit marker, health, ammo, round info, economy, kill feed, damage
// flash and the two overlays (buy menu and round end). It never touches the simulation;
// main.js pushes numbers in and reads the callbacks out.
export function createHud() {
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayCopy = document.getElementById('overlay-copy');
  const buyArea = document.getElementById('buy-area');
  const endArea = document.getElementById('end-area');
  const endTitle = document.getElementById('end-title');
  const endReason = document.getElementById('end-reason');
  const endScore = document.getElementById('end-score');
  const cont = document.getElementById('cont');
  const cont2 = document.getElementById('cont2');

  const healthFill = document.getElementById('health-fill');
  const healthNum = document.getElementById('health-num');
  const bombEl = document.getElementById('bomb');

  const weaponName = document.getElementById('weapon-name');
  const ammoMag = document.getElementById('ammo-mag');
  const ammoReserve = document.getElementById('ammo-reserve');
  const ammo = document.getElementById('ammo');

  const scoreA = document.querySelector('#round-score .a');
  const scoreD = document.querySelector('#round-score .d');
  const roundTimer = document.getElementById('round-timer');
  const roundPhase = document.getElementById('round-phase');

  const moneyEl = document.querySelector('#money b');
  const killsEl = document.querySelector('#kills b');
  const feed = document.getElementById('feed');
  const damage = document.getElementById('damage');
  const hitmarker = document.getElementById('hitmarker');

  let hitTimer = 0;
  let damageTimer = 0;
  let lastHealth = -1;
  let lastMag = -1;
  let lastReserve = -1;

  let buyCallback = null;
  let contCallback = null;

  function setHealth(value) {
    if (value === lastHealth) return;
    lastHealth = value;
    healthFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    healthNum.textContent = Math.max(0, Math.round(value));
    if (value <= 30) healthFill.style.background = 'var(--bomb)';
    else healthFill.style.background = 'var(--accent)';
  }

  function setAmmo(mag, reserve) {
    if (mag === lastMag && reserve === lastReserve) return;
    lastMag = mag;
    lastReserve = reserve;
    ammoMag.textContent = String(mag);
    ammoReserve.textContent = `/ ${reserve}`;
    ammo.classList.toggle('empty', mag === 0);
  }

  function setWeapon(name) {
    weaponName.textContent = name;
  }

  function setRound(scoreAVal, scoreDVal) {
    scoreA.textContent = String(scoreAVal);
    scoreD.textContent = String(scoreDVal);
  }

  function setTimer(seconds, phase) {
    const whole = Math.max(0, Math.ceil(seconds));
    roundTimer.textContent = String(whole);
    roundPhase.textContent = phase;
    if (phase === 'BUY') {
      roundTimer.textContent = String(whole);
      roundPhase.style.color = 'var(--accent)';
      roundTimer.classList.remove('low');
    } else if (phase === 'LIVE') {
      roundPhase.style.color = 'var(--muted)';
      roundTimer.classList.toggle('low', whole <= 15);
    }
  }

  function setMoney(value) {
    moneyEl.textContent = value.toLocaleString('en-US');
  }

  function setKills(value) {
    killsEl.textContent = String(value);
  }

  function setBomb(planted) {
    bombEl.classList.toggle('on', planted);
  }

  function addFeed(type, text) {
    const el = document.createElement('div');
    el.className = `feed-item ${type === 'kill' ? 'feed-kill' : 'feed-death'}`;
    el.textContent = text;
    feed.prepend(el);
    while (feed.children.length > 4) feed.removeChild(feed.lastChild);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 6000);
  }

  function hitMarker(killed) {
    hitmarker.classList.add('on');
    hitmarker.style.transform = killed ? 'translate(-50%, -50%) rotate(45deg) scale(1.3)' : '';
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => {
      hitmarker.classList.remove('on');
      hitmarker.style.transform = '';
    }, 90);
  }

  function damageFlash() {
    damage.classList.add('on');
    clearTimeout(damageTimer);
    damageTimer = setTimeout(() => damage.classList.remove('on'), 180);
  }

  function showBuy(mode) {
    overlay.hidden = false;
    overlayTitle.textContent = 'Operation Depository';
    overlayCopy.textContent = 'Buy weapons with your round money, then deploy.';
    buyArea.hidden = false;
    endArea.hidden = true;
    cont.focus();
  }

  function showEnd(result, scoreAVal, scoreDVal) {
    overlay.hidden = false;
    buyArea.hidden = true;
    endArea.hidden = false;
    const won = result.winner === 'attacker';
    endTitle.textContent = won ? 'ROUND WON' : 'ROUND LOST';
    endTitle.className = won ? 'won' : 'lost';
    endReason.textContent = result.reason;
    endScore.textContent = `${scoreAVal} — ${scoreDVal}`;
    cont2.focus();
  }

  function hideOverlay() {
    overlay.hidden = true;
  }

  function onBuy(cb) {
    buyCallback = cb;
    document.querySelectorAll('.buy-row').forEach((row) => {
      row.addEventListener('click', () => {
        const weapon = row.dataset.weapon;
        if (buyCallback) buyCallback(weapon, row);
      });
    });
  }

  function onCont(contCb, cont2Cb) {
    contCallback = contCb;
    cont.addEventListener('click', contCb);
    cont2.addEventListener('click', cont2Cb);
  }

  function buyRowState(weapon, affordable) {
    const row = document.querySelector(`.buy-row[data-weapon="${weapon}"]`);
    if (row) row.classList.toggle('disabled', !affordable);
  }

  return {
    setHealth,
    setAmmo,
    setWeapon,
    setRound,
    setTimer,
    setMoney,
    setKills,
    setBomb,
    addFeed,
    hitMarker,
    damageFlash,
    showBuy,
    showEnd,
    hideOverlay,
    onBuy,
    onCont,
    buyRowState,
  };
}
