const canvas = document.getElementById("battleCanvas");
const ctx = canvas.getContext("2d");

const basePanel = document.getElementById("basePanel");
const mapPanel = document.getElementById("mapPanel");
const battlePanel = document.getElementById("battlePanel");
const selectedInfo = document.getElementById("selectedInfo");
const logBox = document.getElementById("logBox");
const metaBar = document.getElementById("metaBar");

const tabs = {
  base: document.getElementById("tabBase"),
  map: document.getElementById("tabMap"),
  battle: document.getElementById("tabBattle"),
};

const MATERIALS = {
  basic: { label: "Basic Steel", mass: 10, armor: 1.0, hp: 110, color: "#95a4b8" },
  reinforced: { label: "Reinforced", mass: 13, armor: 1.3, hp: 150, color: "#8ca3bd" },
  ceramic: { label: "Ceramic", mass: 9, armor: 1.2, hp: 120, color: "#a8d1e6" },
  reactive: { label: "Reactive", mass: 14, armor: 1.55, hp: 170, color: "#d0bb90" },
  combined: { label: "Combined Mk1", mass: 12, armor: 1.5, hp: 165, color: "#bda9d8" },
};

const COMPONENTS = {
  control: { mass: 8, hpMul: 0.9, type: "control" },
  engineS: { mass: 10, hpMul: 1.0, type: "engine" },
  engineM: { mass: 16, hpMul: 1.0, type: "engine" },
  mg: { mass: 6, hpMul: 0.9, type: "weapon", recoil: 1.2, hitImpulse: 0.8, damage: 16, range: 240, cooldown: 0.22 },
  cannonL: {
    mass: 12,
    hpMul: 0.9,
    type: "weapon",
    recoil: 8.0,
    hitImpulse: 6.0,
    damage: 52,
    range: 330,
    cooldown: 1.4,
  },
  cannonM: {
    mass: 18,
    hpMul: 0.9,
    type: "weapon",
    recoil: 14.0,
    hitImpulse: 11.0,
    damage: 78,
    range: 360,
    cooldown: 2.1,
  },
  rocket: {
    mass: 14,
    hpMul: 0.85,
    type: "weapon",
    recoil: 9.0,
    hitImpulse: 10.0,
    damage: 64,
    range: 300,
    cooldown: 1.0,
  },
  fuel: { mass: 9, hpMul: 0.8, type: "fuel" },
  ammo: { mass: 7, hpMul: 0.8, type: "ammo" },
};

const laneY = [130, 260, 390];
let uidCounter = 0;

const game = {
  screen: "base",
  running: true,
  now: 0,
  lastTs: 0,
  commanderSkill: 1,
  gas: 250,
  tech: {
    reinforced: false,
    ceramic: false,
    combined: false,
    reactive: false,
    mediumWeapons: false,
  },
  base: {
    areaLevel: 1,
    refineries: 1,
    workshops: 1,
    labs: 0,
    hp: 2200,
  },
  strategic: {
    lastTick: 0,
    occupied: {},
    nodes: [
      { id: "mine", name: "Frontier Mine", owner: "neutral", garrison: false, reward: 55, defense: 1.0 },
      { id: "pass", name: "Ridge Pass", owner: "enemy", garrison: false, reward: 85, defense: 1.2 },
      { id: "relay", name: "Sky Relay", owner: "enemy", garrison: false, reward: 110, defense: 1.35 },
      { id: "core", name: "Enemy Core Base", owner: "enemy", garrison: false, reward: 180, defense: 1.7 },
    ],
    selectedNode: "mine",
    pendingOccupation: null,
  },
  battle: createEmptyBattle(),
  templates: createInitialTemplates(),
  selectedUnitId: null,
  playerControlledId: null,
  keys: { a: false, d: false, w: false, s: false, space: false },
};

function createEmptyBattle() {
  return {
    active: false,
    nodeId: null,
    units: [],
    projectiles: [],
    particles: [],
    playerBase: { hp: 1300, maxHp: 1300, x: 18, y: 180, w: 38, h: 160 },
    enemyBase: { hp: 1300, maxHp: 1300, x: canvas.width - 56, y: 180, w: 38, h: 160 },
    enemyGas: 220,
    enemyCap: 3,
    enemySpawnTimer: 0,
    outcome: null,
  };
}

function createInitialTemplates() {
  return [
    {
      id: "scout-ground",
      name: "Scout Buggy",
      type: "ground",
      gasCost: 22,
      structure: [
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
      ],
      attachments: [
        { component: "control", cell: 1 },
        { component: "engineS", cell: 0 },
        { component: "mg", cell: 2 },
        { component: "fuel", cell: 0 },
      ],
    },
    {
      id: "tank-ground",
      name: "Line Tank",
      type: "ground",
      gasCost: 38,
      structure: [
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
      ],
      attachments: [
        { component: "control", cell: 2 },
        { component: "engineM", cell: 1 },
        { component: "cannonL", cell: 3 },
        { component: "ammo", cell: 2 },
      ],
    },
    {
      id: "air-light",
      name: "Skylance",
      type: "air",
      gasCost: 34,
      structure: [
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
        { material: "basic" },
      ],
      attachments: [
        { component: "control", cell: 1 },
        { component: "engineS", cell: 0 },
        { component: "rocket", cell: 2 },
        { component: "fuel", cell: 3 },
      ],
    },
  ];
}

function armyCap() {
  return 3 + Math.floor(game.commanderSkill / 2);
}

function activeFriendlyCount() {
  return game.battle.units.filter((u) => u.side === "player" && u.alive).length;
}

function addLog(text, tone = "") {
  const item = document.createElement("div");
  item.className = tone;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logBox.prepend(item);
  while (logBox.children.length > 120) {
    logBox.removeChild(logBox.lastChild);
  }
}

function uid(prefix) {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

function instantiateUnit(templateId, side, x, y, laneIndex = 1) {
  const tpl = game.templates.find((t) => t.id === templateId);
  if (!tpl) {
    return null;
  }

  const structure = tpl.structure.map((cell, idx) => {
    const mat = MATERIALS[cell.material];
    return {
      id: idx,
      material: cell.material,
      hp: mat.hp,
      maxHp: mat.hp,
      destroyed: false,
    };
  });

  const attachments = tpl.attachments.map((a, idx) => ({
    id: idx,
    component: a.component,
    cell: a.cell,
    alive: true,
  }));

  const controls = attachments.filter((a) => COMPONENTS[a.component].type === "control" && a.alive);
  if (controls.length !== 1) {
    addLog(`Blueprint invalid (${tpl.name}): must have exactly one control unit`, "bad");
    return null;
  }

  const weaponAttachment = attachments.find((a) => COMPONENTS[a.component].type === "weapon");
  const engineAttachment = attachments.find((a) => COMPONENTS[a.component].type === "engine");

  const unit = {
    id: uid(`${side}-${tpl.type}`),
    side,
    type: tpl.type,
    name: tpl.name,
    laneIndex,
    x,
    y,
    vx: 0,
    vy: 0,
    accel: tpl.type === "ground" ? 105 : 120,
    maxSpeed: tpl.type === "ground" ? 100 : 135,
    turnDrag: tpl.type === "ground" ? 0.9 : 0.93,
    radius: 16 + structure.length * 1.4,
    structure,
    attachments,
    controlAttachmentId: controls[0].id,
    weaponAttachmentId: weaponAttachment ? weaponAttachment.id : null,
    engineAttachmentId: engineAttachment ? engineAttachment.id : null,
    fireTimer: 0,
    laneSwapTimer: 0,
    aiTimer: 0,
    alive: true,
    vibrate: 0,
    altitude: y,
    targetY: y,
  };

  recalcMass(unit);
  return unit;
}

function recalcMass(unit) {
  let total = 0;
  for (const cell of unit.structure) {
    if (!cell.destroyed) {
      total += MATERIALS[cell.material].mass;
    }
  }
  for (const att of unit.attachments) {
    if (att.alive) {
      total += COMPONENTS[att.component].mass;
    }
  }
  unit.mass = Math.max(14, total);
}

function structureIntegrity(unit) {
  let hp = 0;
  let maxHp = 0;
  for (const cell of unit.structure) {
    maxHp += cell.maxHp;
    hp += Math.max(0, cell.hp);
  }
  return maxHp > 0 ? hp / maxHp : 0;
}

function firstAliveWeapon(unit) {
  const a = unit.attachments.find((att) => att.id === unit.weaponAttachmentId && att.alive);
  if (!a) {
    return null;
  }
  return COMPONENTS[a.component];
}

function canOperate(unit) {
  if (!unit.alive) {
    return false;
  }
  const c = unit.attachments.find((att) => att.id === unit.controlAttachmentId && att.alive);
  return Boolean(c);
}

function destroyAttachment(unit, attachmentId) {
  const att = unit.attachments.find((a) => a.id === attachmentId);
  if (!att || !att.alive) {
    return;
  }
  att.alive = false;
  const c = COMPONENTS[att.component];
  if (c.type === "control") {
    unit.alive = false;
    addLog(`${unit.name} lost control unit and is mission-killed`, "bad");
  }
  if (c.type === "ammo" && Math.random() < 0.3) {
    const blast = 18;
    for (const cell of unit.structure) {
      if (!cell.destroyed) {
        cell.hp -= blast;
      }
    }
  }
}

function destroyCell(unit, cellId) {
  const cell = unit.structure.find((c) => c.id === cellId);
  if (!cell || cell.destroyed) {
    return;
  }
  cell.destroyed = true;
  cell.hp = 0;
  for (const att of unit.attachments) {
    if (att.alive && att.cell === cellId) {
      destroyAttachment(unit, att.id);
    }
  }
  recalcMass(unit);
  if (unit.structure.every((c) => c.destroyed)) {
    unit.alive = false;
    addLog(`${unit.name} has been fully destroyed`, "bad");
  }
}

function applyHitToUnit(unit, incomingDamage, incomingImpulse, impactSide = 1) {
  if (!canOperate(unit)) {
    return;
  }

  const aliveCells = unit.structure.filter((c) => !c.destroyed);
  if (aliveCells.length === 0) {
    unit.alive = false;
    return;
  }

  const targetCell = aliveCells[Math.floor(Math.random() * aliveCells.length)];
  const mat = MATERIALS[targetCell.material];
  const stress = incomingDamage / Math.max(0.7, mat.armor);
  targetCell.hp -= stress;

  const deltaV = incomingImpulse / unit.mass;
  unit.vx += impactSide * deltaV;
  unit.vibrate = Math.min(1.7, unit.vibrate + deltaV * 1.6);

  if (targetCell.hp <= 0) {
    destroyCell(unit, targetCell.id);
  }

  const exposed = unit.attachments.filter((a) => a.alive && !unit.structure.find((c) => c.id === a.cell)?.destroyed);
  if (exposed.length > 0 && Math.random() < 0.16) {
    const pick = exposed[Math.floor(Math.random() * exposed.length)];
    if (Math.random() < 0.35) {
      destroyAttachment(unit, pick.id);
    }
  }

  if (!canOperate(unit)) {
    unit.alive = false;
  }
}

function fireUnit(unit, manual = false) {
  if (!canOperate(unit)) {
    return;
  }

  const w = firstAliveWeapon(unit);
  if (!w || unit.fireTimer > 0) {
    return;
  }

  unit.fireTimer = w.cooldown;
  const dir = unit.side === "player" ? 1 : -1;
  const recoilDv = w.recoil / unit.mass;
  unit.vx -= dir * recoilDv;

  const speed = 260;
  game.battle.projectiles.push({
    x: unit.x + dir * (unit.radius + 4),
    y: unit.y,
    vx: dir * speed,
    vy: 0,
    ttl: 2.0,
    sourceId: unit.id,
    side: unit.side,
    damage: w.damage,
    hitImpulse: w.hitImpulse,
    r: Math.max(2, Math.sqrt(w.damage) * 0.35),
  });

  unit.vibrate = Math.min(1.2, unit.vibrate + recoilDv * 2.2);
  if (manual) {
    addLog(`${unit.name} fired`, "warn");
  }
}

function pickTarget(unit) {
  let best = null;
  let bestDist = Infinity;
  for (const other of game.battle.units) {
    if (!other.alive || !canOperate(other)) {
      continue;
    }
    if (other.side === unit.side) {
      continue;
    }
    const dx = Math.abs(other.x - unit.x);
    const dy = Math.abs(other.y - unit.y);
    const d = dx + dy * 0.8;
    if (d < bestDist) {
      bestDist = d;
      best = other;
    }
  }
  return best;
}

function updateUnitAI(unit, dt) {
  unit.aiTimer -= dt;
  if (unit.aiTimer > 0) {
    return;
  }
  unit.aiTimer = 0.2 + Math.random() * 0.28;

  const target = pickTarget(unit);
  if (!target) {
    const dir = unit.side === "player" ? 1 : -1;
    unit.vx += dir * unit.accel * dt * 0.2;
    return;
  }

  const dirToTarget = Math.sign(target.x - unit.x);
  unit.vx += dirToTarget * unit.accel * dt * 0.9;

  if (unit.type === "ground") {
    unit.laneSwapTimer -= dt;
    if (unit.laneSwapTimer <= 0) {
      unit.laneSwapTimer = 1.4 + Math.random() * 1.6;
      if (Math.abs(target.y - unit.y) > 28) {
        const nearestLane = laneY.reduce((acc, yVal, idx) => {
          const d = Math.abs(yVal - target.y);
          if (d < acc.d) {
            return { d, idx };
          }
          return acc;
        }, { d: Infinity, idx: unit.laneIndex }).idx;
        unit.laneIndex = nearestLane;
        unit.targetY = laneY[nearestLane];
      }
    }
  } else {
    const desired = Math.max(70, Math.min(canvas.height - 70, target.y + (Math.random() - 0.5) * 60));
    unit.targetY = desired;
    unit.vy += Math.sign(desired - unit.y) * unit.accel * dt * 0.55;
  }

  const weapon = firstAliveWeapon(unit);
  if (weapon) {
    const dx = Math.abs(target.x - unit.x);
    const dy = Math.abs(target.y - unit.y);
    if (dx < weapon.range && dy < 90) {
      fireUnit(unit, false);
    }
  }
}

function updateControlledUnit(unit, dt) {
  let dx = 0;
  let dy = 0;
  if (game.keys.a) dx -= 1;
  if (game.keys.d) dx += 1;
  if (game.keys.w) dy -= 1;
  if (game.keys.s) dy += 1;

  if (unit.type === "ground") {
    unit.vx += dx * unit.accel * dt;
    if (dy !== 0) {
      let next = unit.laneIndex + (dy > 0 ? 1 : -1);
      next = Math.max(0, Math.min(2, next));
      if (next !== unit.laneIndex) {
        unit.laneIndex = next;
        unit.targetY = laneY[next];
      }
    }
  } else {
    unit.vx += dx * unit.accel * dt;
    unit.vy += dy * unit.accel * dt;
    unit.targetY = Math.max(62, Math.min(canvas.height - 62, unit.targetY + dy * 3));
  }

  if (game.keys.space) {
    fireUnit(unit, true);
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function updateBattle(dt) {
  const b = game.battle;
  if (!b.active || b.outcome) {
    return;
  }

  b.enemySpawnTimer -= dt;
  if (b.enemySpawnTimer <= 0) {
    b.enemySpawnTimer = 4.2 + Math.random() * 2.8;
    maybeSpawnEnemy();
  }

  for (const unit of b.units) {
    if (!unit.alive || !canOperate(unit)) {
      continue;
    }

    const isControlled = unit.id === game.playerControlledId;
    if (isControlled && unit.side === "player") {
      updateControlledUnit(unit, dt);
    } else {
      updateUnitAI(unit, dt);
    }

    if (unit.type === "ground") {
      const laneTarget = laneY[unit.laneIndex] || unit.targetY;
      unit.targetY = laneTarget;
    }

    const ySpring = (unit.targetY - unit.y) * (unit.type === "ground" ? 4.2 : 2.8);
    unit.vy += ySpring * dt;
    unit.vx = clamp(unit.vx, -unit.maxSpeed, unit.maxSpeed);
    unit.vy = clamp(unit.vy, -80, 80);
    unit.x += unit.vx * dt;
    unit.y += unit.vy * dt;

    unit.vx *= unit.turnDrag;
    unit.vy *= 0.88;
    unit.fireTimer = Math.max(0, unit.fireTimer - dt);
    unit.vibrate *= 0.85;

    unit.y = clamp(unit.y, 56, canvas.height - 56);
    unit.x = clamp(unit.x, 44, canvas.width - 44);

    if (unit.side === "player" && unit.x >= b.enemyBase.x - 24) {
      b.enemyBase.hp -= 24 * dt;
    }
    if (unit.side === "enemy" && unit.x <= b.playerBase.x + b.playerBase.w + 24) {
      b.playerBase.hp -= 24 * dt;
    }
  }

  for (const p of b.projectiles) {
    p.ttl -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    for (const target of b.units) {
      if (!target.alive || !canOperate(target) || target.side === p.side) {
        continue;
      }
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const r = target.radius + p.r;
      if (dx * dx + dy * dy <= r * r) {
        applyHitToUnit(target, p.damage, p.hitImpulse, p.side === "player" ? 1 : -1);
        p.ttl = -1;
        b.particles.push({ x: p.x, y: p.y, life: 0.23 + Math.random() * 0.2, size: 6 + p.damage * 0.05 });
        break;
      }
    }

    if (p.ttl > 0 && p.side === "player") {
      if (
        p.x > b.enemyBase.x &&
        p.x < b.enemyBase.x + b.enemyBase.w &&
        p.y > b.enemyBase.y &&
        p.y < b.enemyBase.y + b.enemyBase.h
      ) {
        b.enemyBase.hp -= p.damage * 0.5;
        p.ttl = -1;
      }
    }

    if (p.ttl > 0 && p.side === "enemy") {
      if (
        p.x > b.playerBase.x &&
        p.x < b.playerBase.x + b.playerBase.w &&
        p.y > b.playerBase.y &&
        p.y < b.playerBase.y + b.playerBase.h
      ) {
        b.playerBase.hp -= p.damage * 0.5;
        p.ttl = -1;
      }
    }
  }

  b.projectiles = b.projectiles.filter((p) => p.ttl > 0 && p.x > 0 && p.x < canvas.width);
  for (const fx of b.particles) {
    fx.life -= dt;
  }
  b.particles = b.particles.filter((fx) => fx.life > 0);

  b.units = b.units.filter((u) => u.alive);

  if (b.playerBase.hp <= 0) {
    endBattle(false, "Player battle base destroyed");
  } else if (b.enemyBase.hp <= 0) {
    endBattle(true, "Enemy base destroyed");
  }
}

function maybeSpawnEnemy() {
  const b = game.battle;
  const aliveEnemy = b.units.filter((u) => u.side === "enemy" && u.alive).length;
  if (aliveEnemy >= b.enemyCap || b.enemyGas < 20) {
    return;
  }

  const pickList = ["scout-ground", "tank-ground", "air-light"];
  const pick = pickList[Math.floor(Math.random() * pickList.length)];
  const tpl = game.templates.find((t) => t.id === pick);
  if (!tpl || b.enemyGas < tpl.gasCost) {
    return;
  }

  b.enemyGas -= tpl.gasCost;
  const laneIndex = Math.floor(Math.random() * 3);
  const y = tpl.type === "air" ? 120 + Math.random() * 280 : laneY[laneIndex];
  const enemy = instantiateUnit(pick, "enemy", canvas.width - 120, y, laneIndex);
  if (enemy) {
    b.units.push(enemy);
  }
}

function startBattle(nodeId) {
  const node = game.strategic.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return;
  }

  game.battle = createEmptyBattle();
  game.battle.active = true;
  game.battle.nodeId = nodeId;
  game.battle.enemyCap = Math.max(3, Math.ceil((node.defense * 3.2) + 1));
  game.battle.enemyGas = 190 + Math.floor(node.defense * 130);

  const starterA = instantiateUnit("scout-ground", "player", 140, laneY[0], 0);
  const starterB = instantiateUnit("tank-ground", "player", 150, laneY[2], 2);
  if (starterA) game.battle.units.push(starterA);
  if (starterB) game.battle.units.push(starterB);

  for (let i = 0; i < 2; i += 1) {
    maybeSpawnEnemy();
  }

  game.playerControlledId = starterA ? starterA.id : null;
  game.selectedUnitId = game.playerControlledId;

  addLog(`Battle started at ${node.name}`);
  setScreen("battle");
}

function endBattle(victory, reason) {
  const b = game.battle;
  if (!b.active || b.outcome) {
    return;
  }

  b.outcome = { victory, reason };
  b.active = false;

  const node = game.strategic.nodes.find((n) => n.id === b.nodeId);
  if (!node) {
    return;
  }

  if (victory) {
    node.owner = "player";
    game.gas += node.reward;
    game.commanderSkill += node.id === "core" ? 2 : 1;
    game.strategic.pendingOccupation = node.id;
    addLog(`Victory at ${node.name}. +${node.reward} gas, commander skill up`, "good");
  } else {
    game.base.hp -= 280;
    addLog(`Defeat at ${node.name}. Base HP damaged`, "bad");
    if (game.base.hp <= 0) {
      addLog("Main army base destroyed. Campaign lost.", "bad");
      game.running = false;
    }
  }

  renderPanels();
}

function deployUnit(templateId) {
  if (!game.battle.active) {
    return;
  }
  const tpl = game.templates.find((t) => t.id === templateId);
  if (!tpl) {
    return;
  }

  if (activeFriendlyCount() >= armyCap()) {
    addLog("Commander cap reached", "warn");
    return;
  }

  if (game.gas < tpl.gasCost) {
    addLog("Not enough gas for deployment", "warn");
    return;
  }

  game.gas -= tpl.gasCost;
  const laneIndex = Math.floor(Math.random() * 3);
  const y = tpl.type === "air" ? 150 + Math.random() * 220 : laneY[laneIndex];
  const unit = instantiateUnit(templateId, "player", 120, y, laneIndex);
  if (unit) {
    game.battle.units.push(unit);
    addLog(`Deployed ${tpl.name} (-${tpl.gasCost} gas)`);
  }
}

function settleGarrison() {
  const id = game.strategic.pendingOccupation;
  if (!id) {
    return;
  }
  const node = game.strategic.nodes.find((n) => n.id === id);
  if (!node) {
    return;
  }
  node.garrison = true;
  game.strategic.pendingOccupation = null;
  addLog(`Garrison established at ${node.name} (gas upkeep active)`);
  renderPanels();
}

function updateStrategic(dt) {
  game.strategic.lastTick += dt;
  if (game.strategic.lastTick < 1) {
    return;
  }
  game.strategic.lastTick = 0;

  const income = 8 + game.base.refineries * 6;
  const upkeep = game.strategic.nodes.filter((n) => n.garrison).length * 4;
  game.gas += income - upkeep;
  game.gas = Math.max(0, game.gas);
}

function drawBattle() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (game.screen !== "battle") {
    drawIdleMessage();
    return;
  }

  const b = game.battle;

  for (let i = 0; i < laneY.length; i += 1) {
    const y = laneY[i];
    ctx.strokeStyle = "rgba(139, 170, 205, 0.2)";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  drawBase(b.playerBase, "#5d8bb3", "Player Base");
  drawBase(b.enemyBase, "#b36b63", "Enemy Base");

  for (const fx of b.particles) {
    ctx.globalAlpha = clamp(fx.life / 0.4, 0, 1);
    ctx.fillStyle = "#f5c07a";
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, fx.size * (1 - fx.life * 0.8), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const p of b.projectiles) {
    ctx.fillStyle = p.side === "player" ? "#9bd5ff" : "#ffb19a";
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const unit of b.units) {
    drawUnit(unit);
  }

  if (b.outcome) {
    ctx.fillStyle = "rgba(10, 14, 22, 0.78)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = b.outcome.victory ? "#74d8a0" : "#f28b8b";
    ctx.font = "700 34px Trebuchet MS";
    ctx.fillText(b.outcome.victory ? "VICTORY" : "DEFEAT", canvas.width / 2 - 82, canvas.height / 2 - 8);
    ctx.fillStyle = "#dce8f5";
    ctx.font = "16px Trebuchet MS";
    ctx.fillText(b.outcome.reason, canvas.width / 2 - 110, canvas.height / 2 + 24);
  }
}

function drawIdleMessage() {
  ctx.fillStyle = "rgba(10, 15, 24, 0.9)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#d6e4f2";
  ctx.font = "600 28px Trebuchet MS";
  ctx.fillText("Map/Base Mode", canvas.width / 2 - 92, canvas.height / 2 - 10);
  ctx.fillStyle = "#98abc3";
  ctx.font = "16px Trebuchet MS";
  ctx.fillText("Select a map node and launch battle.", canvas.width / 2 - 128, canvas.height / 2 + 24);
}

function drawBase(base, color, label) {
  ctx.fillStyle = color;
  ctx.fillRect(base.x, base.y, base.w, base.h);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(base.x, base.y + base.h + 6, 100, 8);
  const hpRatio = clamp(base.hp / base.maxHp, 0, 1);
  ctx.fillStyle = hpRatio > 0.5 ? "#67d39b" : hpRatio > 0.25 ? "#efc16a" : "#ee6f6f";
  ctx.fillRect(base.x, base.y + base.h + 6, 100 * hpRatio, 8);
  ctx.fillStyle = "#d7e3f0";
  ctx.font = "12px Trebuchet MS";
  ctx.fillText(label, base.x - 2, base.y - 8);
}

function drawUnit(unit) {
  const integrity = structureIntegrity(unit);
  const mat = unit.structure.find((c) => !c.destroyed);
  const color = mat ? MATERIALS[mat.material].color : "#666";

  const shakeX = Math.sin(game.now * 28) * unit.vibrate * 2.2;
  const shakeY = Math.cos(game.now * 21) * unit.vibrate * 1.8;

  ctx.save();
  ctx.translate(unit.x + shakeX, unit.y + shakeY);

  const sideSign = unit.side === "player" ? 1 : -1;
  const w = unit.radius * 1.7;
  const h = unit.type === "ground" ? unit.radius * 0.95 : unit.radius * 0.7;

  ctx.fillStyle = color;
  ctx.fillRect(-w / 2, -h / 2, w, h);

  const weapon = firstAliveWeapon(unit);
  if (weapon) {
    ctx.fillStyle = unit.side === "player" ? "#a7d9ff" : "#f4b09d";
    ctx.fillRect(0, -2, sideSign * 16, 4);
  }

  if (unit.type === "air") {
    ctx.strokeStyle = "rgba(203, 229, 255, 0.65)";
    ctx.beginPath();
    ctx.moveTo(-w * 0.46, h * 0.45);
    ctx.lineTo(-w * 0.12, h * 0.86);
    ctx.lineTo(w * 0.33, h * 0.45);
    ctx.stroke();
  }

  if (unit.id === game.playerControlledId) {
    ctx.strokeStyle = "#8de4a9";
    ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6);
  }
  if (unit.id === game.selectedUnitId) {
    ctx.strokeStyle = "#ffd37f";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-w / 2 - 6, -h / 2 - 6, w + 12, h + 12);
  }

  ctx.restore();

  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(unit.x - 20, unit.y + 18, 40, 5);
  ctx.fillStyle = integrity > 0.45 ? "#65ce8d" : integrity > 0.2 ? "#efbe67" : "#e87373";
  ctx.fillRect(unit.x - 20, unit.y + 18, 40 * integrity, 5);
}

function renderPanels() {
  metaBar.textContent = `Gas: ${Math.floor(game.gas)} | Commander Skill: ${game.commanderSkill} | Army Cap: ${armyCap()} | Base HP: ${Math.max(
    0,
    Math.floor(game.base.hp)
  )}`;

  basePanel.innerHTML = `
    <h3>Base</h3>
    <div class="small">Area Lv.${game.base.areaLevel} | Refineries: ${game.base.refineries} | Workshops: ${game.base.workshops} | Labs: ${game.base.labs}</div>
    <div class="row">
      <button id="btnBuildRefinery">Build Refinery (90 gas)</button>
      <button id="btnExpandBase">Expand Base (120 gas)</button>
      <button id="btnBuildLab">Build Lab (110 gas)</button>
    </div>
    <div class="small">Tech unlocks: ${Object.entries(game.tech)
      .filter(([, v]) => v)
      .map(([k]) => `<span class="tag">${k}</span>`)
      .join("") || "None"}</div>
    <div class="row" style="margin-top:8px;">
      <button id="btnUnlockReinforced">Unlock Reinforced (130 gas)</button>
      <button id="btnUnlockCombined">Unlock Combined Box (180 gas)</button>
      <button id="btnUnlockMediumWeapon">Unlock Medium Cannon (170 gas)</button>
    </div>
  `;

  mapPanel.innerHTML = `
    <h3>Map</h3>
    <div class="small">Choose where to fight from your base.</div>
    ${game.strategic.nodes
      .map((n) => {
        const ownClass = n.owner === "player" ? "good" : n.owner === "enemy" ? "bad" : "warn";
        return `<div style="margin:8px 0;padding:7px;border:1px solid #3b536e;border-radius:8px;">
          <div><strong>${n.name}</strong> <span class="${ownClass}">(${n.owner})</span></div>
          <div class="small">Defense: ${n.defense.toFixed(2)} | Reward: ${n.reward} gas ${n.garrison ? "| Garrisoned" : ""}</div>
          <div class="row"><button data-node="${n.id}" class="nodeSelect">Select</button><button data-attack="${n.id}" class="nodeAttack">Launch Battle</button></div>
        </div>`;
      })
      .join("")}
    ${
      game.strategic.pendingOccupation
        ? `<div class="row"><button id="btnSettle">Station Garrison (upkeep 4 gas/min)</button></div>`
        : ""
    }
  `;

  battlePanel.innerHTML = `
    <h3>Battle Ops</h3>
    <div class="small">Call reinforcements using global gas. Active cap from commander skill.</div>
    <div class="row">
      ${game.templates
        .map((t) => `<button data-deploy="${t.id}">${t.name} (${t.gasCost} gas)</button>`)
        .join("")}
    </div>
    <div class="small">Friendly active: ${activeFriendlyCount()} / ${armyCap()}</div>
    ${
      game.battle.outcome
        ? `<div class="row"><button id="btnBackToMap">Return to Map</button></div>`
        : ""
    }
  `;

  const selected = game.battle.units.find((u) => u.id === game.selectedUnitId);
  if (!selected) {
    selectedInfo.innerHTML = `<span class="small">No unit selected.</span>`;
  } else {
    const weapon = firstAliveWeapon(selected);
    selectedInfo.innerHTML = `
      <div><strong>${selected.name}</strong> (${selected.side})</div>
      <div class="small">Type: ${selected.type} | Mass: ${selected.mass.toFixed(1)} | Speed: ${selected.vx.toFixed(1)}</div>
      <div class="small">Integrity: ${(structureIntegrity(selected) * 100).toFixed(0)}% | Weapon: ${weapon ? weapon.type : "none"}</div>
      <div class="small">Control Unit: ${canOperate(selected) ? "online" : "offline"}</div>
    `;
  }

  bindPanelActions();
}

function bindPanelActions() {
  document.getElementById("btnBuildRefinery")?.addEventListener("click", () => {
    if (game.gas < 90) return;
    game.gas -= 90;
    game.base.refineries += 1;
    addLog("Built Refinery", "good");
    renderPanels();
  });

  document.getElementById("btnExpandBase")?.addEventListener("click", () => {
    if (game.gas < 120) return;
    game.gas -= 120;
    game.base.areaLevel += 1;
    addLog("Expanded base area", "good");
    renderPanels();
  });

  document.getElementById("btnBuildLab")?.addEventListener("click", () => {
    if (game.gas < 110) return;
    game.gas -= 110;
    game.base.labs += 1;
    addLog("Built Research Lab", "good");
    renderPanels();
  });

  document.getElementById("btnUnlockReinforced")?.addEventListener("click", () => {
    if (game.tech.reinforced || game.gas < 130 || game.base.labs < 1) return;
    game.gas -= 130;
    game.tech.reinforced = true;
    upgradeTemplateMaterials("reinforced");
    addLog("Unlocked Reinforced structure boxes", "good");
    renderPanels();
  });

  document.getElementById("btnUnlockCombined")?.addEventListener("click", () => {
    if (game.tech.combined || game.gas < 180 || game.base.labs < 1) return;
    game.gas -= 180;
    game.tech.combined = true;
    upgradeTemplateMaterials("combined");
    addLog("Unlocked Combined box material", "good");
    renderPanels();
  });

  document.getElementById("btnUnlockMediumWeapon")?.addEventListener("click", () => {
    if (game.tech.mediumWeapons || game.gas < 170 || game.base.labs < 1) return;
    game.gas -= 170;
    game.tech.mediumWeapons = true;
    upgradeTemplatesWeapon();
    addLog("Unlocked medium cannon option", "good");
    renderPanels();
  });

  document.querySelectorAll(".nodeSelect").forEach((el) => {
    el.addEventListener("click", () => {
      game.strategic.selectedNode = el.getAttribute("data-node");
      addLog(`Selected ${game.strategic.selectedNode}`);
    });
  });

  document.querySelectorAll(".nodeAttack").forEach((el) => {
    el.addEventListener("click", () => {
      const nodeId = el.getAttribute("data-attack");
      startBattle(nodeId);
      renderPanels();
    });
  });

  document.getElementById("btnSettle")?.addEventListener("click", () => {
    settleGarrison();
  });

  document.querySelectorAll("button[data-deploy]").forEach((el) => {
    el.addEventListener("click", () => {
      deployUnit(el.getAttribute("data-deploy"));
      renderPanels();
    });
  });

  document.getElementById("btnBackToMap")?.addEventListener("click", () => {
    setScreen("map");
    game.battle = createEmptyBattle();
    game.playerControlledId = null;
    game.selectedUnitId = null;
    renderPanels();
  });
}

function upgradeTemplateMaterials(material) {
  for (const t of game.templates) {
    for (const cell of t.structure) {
      cell.material = material;
    }
    t.gasCost += material === "combined" ? 8 : 4;
  }
}

function upgradeTemplatesWeapon() {
  const tank = game.templates.find((t) => t.id === "tank-ground");
  if (!tank) return;
  const w = tank.attachments.find((a) => a.component === "cannonL");
  if (w) {
    w.component = "cannonM";
  }
  tank.gasCost += 9;
}

function setScreen(screen) {
  game.screen = screen;
  basePanel.classList.toggle("hidden", screen !== "base");
  mapPanel.classList.toggle("hidden", screen !== "map");
  battlePanel.classList.toggle("hidden", screen !== "battle");

  tabs.base.classList.toggle("active", screen === "base");
  tabs.map.classList.toggle("active", screen === "map");
  tabs.battle.classList.toggle("active", screen === "battle");
}

tabs.base.addEventListener("click", () => setScreen("base"));
tabs.map.addEventListener("click", () => setScreen("map"));
tabs.battle.addEventListener("click", () => setScreen("battle"));

window.addEventListener("keydown", (e) => {
  if (e.key === "a" || e.key === "A") game.keys.a = true;
  if (e.key === "d" || e.key === "D") game.keys.d = true;
  if (e.key === "w" || e.key === "W") game.keys.w = true;
  if (e.key === "s" || e.key === "S") game.keys.s = true;
  if (e.code === "Space") game.keys.space = true;
});

window.addEventListener("keyup", (e) => {
  if (e.key === "a" || e.key === "A") game.keys.a = false;
  if (e.key === "d" || e.key === "D") game.keys.d = false;
  if (e.key === "w" || e.key === "W") game.keys.w = false;
  if (e.key === "s" || e.key === "S") game.keys.s = false;
  if (e.code === "Space") game.keys.space = false;
});

canvas.addEventListener("click", (e) => {
  if (game.screen !== "battle") {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);

  let picked = null;
  let bestDist = Infinity;
  for (const u of game.battle.units) {
    if (!u.alive || u.side !== "player") continue;
    const dx = u.x - x;
    const dy = u.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < u.radius + 6 && dist < bestDist) {
      picked = u;
      bestDist = dist;
    }
  }
  if (picked) {
    game.selectedUnitId = picked.id;
    game.playerControlledId = picked.id;
    renderPanels();
  }
});

function frame(ts) {
  if (!game.lastTs) game.lastTs = ts;
  const dt = Math.min(0.033, (ts - game.lastTs) / 1000);
  game.lastTs = ts;
  game.now += dt;

  if (game.running) {
    if (game.screen === "battle") {
      updateBattle(dt);
    } else {
      updateStrategic(dt);
    }
  }

  drawBattle();

  if (Math.floor(game.now * 4) !== Math.floor((game.now - dt) * 4)) {
    renderPanels();
  }

  requestAnimationFrame(frame);
}

setScreen("base");
addLog("Campaign initialized");
renderPanels();
requestAnimationFrame(frame);
